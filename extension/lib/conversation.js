// Multi-turn recall.
//
// Every question used to be single-shot: ask, get an answer, and the next
// question started from nothing. So "what did I read about perovskites?"
// worked and "why do they degrade?" retrieved garbage, because "why" on its
// own embeds to nothing and matches nothing.
//
// The fix is query rewriting. Before retrieval, a follow-up is resolved
// against the conversation into a query that stands on its own — "why" plus
// the prior turn becomes "why do perovskite solar cells degrade". Retrieval
// then runs on the standalone form, while the model answers with the whole
// thread in view. Rewriting before retrieving, rather than just passing
// history to the answer call, is what makes the second and third questions
// find their own sources instead of reusing the first question's.

import * as ai from './ai.js';
import { recallStreaming } from './search.js';

// Enough for a real exchange; beyond this the earliest turns stop being
// relevant and start crowding the context.
const MAX_TURNS = 6;

export class Conversation {
  constructor() {
    this.turns = [];
    this.abort = null;
  }

  get length() { return this.turns.length; }
  get isEmpty() { return this.turns.length === 0; }

  /** Turns in the shape the answer call wants. */
  history() {
    return this.turns.map((t) => ({ question: t.question, answer: t.answer }));
  }

  reset() {
    this.cancel();
    this.turns = [];
  }

  cancel() {
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
  }

  /**
   * Ask a question in the context of this thread.
   *
   * onRewritten fires when a follow-up has been resolved into a standalone
   * query, so the UI can show what was actually searched for — otherwise
   * "why?" returning six sources looks like magic, or like a bug.
   */
  async ask(question, { limit = 6, onToken, onMemories, onRewritten } = {}) {
    const q = (question || '').trim();
    if (!q) throw new Error('Ask something first.');

    this.cancel();
    this.abort = new AbortController();
    const { signal } = this.abort;

    let searchQuery = q;
    if (this.turns.length > 0 && isFollowUp(q)) {
      try {
        searchQuery = await ai.rewriteQuery({ question: q, history: this.history() });
      } catch {
        searchQuery = q; // rewriting is an optimisation, never a gate
      }
      if (searchQuery !== q) onRewritten?.(searchQuery);
    }

    const turn = { question: q, searchQuery, answer: '', memoryIds: [], at: Date.now() };

    try {
      const { answer, memories, hits, synthesisFailed, synthesisError } = await recallStreaming(searchQuery, {
        limit,
        history: this.history(),
        onToken,
        onMemoriesResolved: onMemories,
        signal,
      });
      turn.answer = answer;
      turn.memoryIds = memories.map((m) => m.id);
      // A turn with no answer would poison the next rewrite, which reads the
      // thread for context, so only successful turns join the history.
      if (answer) this.push(turn);
      return { answer, memories, hits, searchQuery, rewritten: searchQuery !== q, synthesisFailed, synthesisError };
    } catch (e) {
      // A failed turn is still part of the thread's history for the user, but
      // an empty answer would poison the context of the next rewrite, so it
      // isn't recorded.
      e.searchQuery = searchQuery;
      throw e;
    } finally {
      this.abort = null;
    }
  }

  push(turn) {
    this.turns.push(turn);
    if (this.turns.length > MAX_TURNS) this.turns.shift();
  }
}

/**
 * Does this question depend on what came before?
 *
 * Rewriting costs a model call, so it's skipped for questions that clearly
 * stand alone. The test is deliberately generous: rewriting a
 * self-contained question is harmless (the prompt returns it unchanged),
 * while failing to rewrite a dependent one breaks retrieval outright.
 */
export function isFollowUp(q) {
  const s = q.trim().toLowerCase();
  if (s.length < 30) return true;                       // short questions lean on context
  if (/^(why|how|when|where|who|what about|and|but|so|then|ok|okay)\b/.test(s)) return true;
  if (/\b(it|that|this|those|these|they|them|its|their|the same|the second|the first|the other|instead|more about|tell me more|go on|elaborate|expand)\b/.test(s)) return true;
  return false;
}

export { MAX_TURNS };
