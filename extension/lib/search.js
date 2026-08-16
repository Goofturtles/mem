// Two-stage hybrid retrieval.
//
// Stage 1 generates candidates two independent ways — an approximate
// semantic scan over the packed int8 matrix, and BM25 over the inverted
// index — and merges them by Reciprocal Rank Fusion. RRF only looks at rank
// position, which is what lets an unbounded BM25 score and a bounded cosine
// score vote in the same election. The previous blend, `0.7 * cosine +
// 0.3 * normalisedLexical`, was adding two quantities with no shared unit.
//
// Stage 2 takes the survivors and rescores them against exact Float32
// vectors, including every passage of the document rather than just its
// opening. That second part is the whole point: a 60,000-character page used
// to have one embedding computed over its first 2,000 characters, so a
// question about anything later in the document could not be answered. Now
// the passage that actually matched is found, ranked, and handed to the
// model as the evidence for its answer.
//
// Cost per query: one embedding call, a handful of postings reads, and one
// chunk-record read per surviving candidate. The corpus is never loaded.

import * as store from './storage.js';
import * as index from './index.js';
import * as ai from './ai.js';
import { dot, rrf, mmr, toFloat32, normalize } from './vec.js';
import { clipPassage } from './text.js';

// How many candidates each retrieval arm contributes before fusion.
const CANDIDATES = 60;
// How many fused candidates get the expensive exact + chunk-level treatment.
const RESCORE = 40;
// Pool handed to MMR before the final cut.
const DIVERSIFY_POOL = 24;

// ---------- time scoping ----------

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Queries anchored to a time ("yesterday", "this week") care more about when
 * than what.
 *
 * These are calendar-day questions and have to be answered with calendar-day
 * boundaries. Rolling offsets were subtly and confidently wrong: "yesterday"
 * as now-48h to now-24h means, at 9am on Tuesday, Sunday morning through
 * Monday morning — it drops most of Monday and includes most of Sunday. And
 * because an empty window returns nothing rather than falling back, the
 * failure looked like "you didn't read anything" instead of "wrong day".
 *
 * Returns { from, to, label } as absolute timestamps, or null.
 */
export function queryTimeScope(q, now = Date.now()) {
  if (!q) return null;
  const lc = q.toLowerCase();
  const today = startOfDay(now);

  if (/\b(yesterday|last night)\b/.test(lc)) {
    return { from: today - DAY_MS, to: today, label: 'yesterday' };
  }
  if (/\b(today|this (morning|afternoon|evening)|tonight)\b/.test(lc)) {
    return { from: today, to: today + DAY_MS, label: 'today' };
  }
  if (/\bthis\s+week\b/.test(lc)) {
    // Week starts Monday; JS getDay() is Sunday-based.
    const dow = (new Date(now).getDay() + 6) % 7;
    return { from: today - dow * DAY_MS, to: today + DAY_MS, label: 'this week' };
  }
  if (/\b(last|past)\s+week\b/.test(lc)) {
    const dow = (new Date(now).getDay() + 6) % 7;
    const thisWeekStart = today - dow * DAY_MS;
    return { from: thisWeekStart - 7 * DAY_MS, to: thisWeekStart, label: 'last week' };
  }
  if (/\bthis\s+month\b/.test(lc)) {
    const d = new Date(now);
    return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: today + DAY_MS, label: 'this month' };
  }
  if (/\b(last|past)\s+month\b/.test(lc)) {
    const d = new Date(now);
    return {
      from: new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(),
      to: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
      label: 'last month',
    };
  }
  // Deliberately narrow. "now", "just" and "earlier" appear constantly in
  // ordinary questions ("what do I know about X now"), and treating them as a
  // hard four-hour filter silently discarded the rest of the corpus.
  if (/\b(just now|right now|last hour|in the last hour|moments ago|a moment ago)\b/.test(lc)
      || /\bwhat (was|were) i (just )?(doing|reading|looking at)\b/.test(lc)) {
    return { from: now - 4 * 60 * 60 * 1000, to: now + 60000, label: 'the last few hours' };
  }
  return null;
}

export function isTimeAnchoredQuery(q) { return !!queryTimeScope(q); }

// ---------- retrieval ----------

/**
 * Rank memories against a query.
 *
 * Returns [{ memory, score, semantic, lexical, evidence, evidenceStart }].
 * `evidence` is the passage that matched — what the answer should be written
 * from — or null when the memory has no stored passages.
 *
 * lexicalOnly skips the network embedding call. Live filter-as-you-type uses
 * it so a keystroke costs nothing. The on-device embedder is free and
 * synchronous, so it runs even under lexicalOnly.
 */
export async function search(query, {
  limit = 12,
  lexicalOnly = false,
  filterIds = null,
  evidence = true,
  diversify = true,
} = {}) {
  const q = (query || '').trim();
  if (!q) return recentHits(limit);

  await index.load();
  const scope = queryTimeScope(q);
  let allowIds = filterIds;
  if (scope) {
    const inWindow = await index.idsBetween(scope.from, scope.to);
    allowIds = filterIds ? inWindow.filter((id) => new Set(filterIds).has(id)) : inWindow;
    // A time-anchored question with nothing in its window should say so
    // rather than silently answering from a different week.
    if (allowIds.length === 0) return [];
  }

  // --- stage 1: candidates ---
  const lexHits = await index.searchLexical(q, { k: CANDIDATES, filterIds: allowIds });

  let vecHits = [];
  let queryVec = null;
  let semanticSkipped = null;
  const indexStats = await index.stats();
  const provider = await ai.effectiveProvider();
  const querySpace = ai.spaceOf(provider);

  if (indexStats.space && querySpace !== indexStats.space) {
    // Comparing vectors from two different models produces confident
    // nonsense. Drop the semantic arm and say why, rather than ranking on
    // meaningless similarities.
    semanticSkipped = `index built with ${indexStats.space}, queries now come from ${querySpace}`;
  } else if (indexStats.withVectors === 0) {
    // Lexical-only is a legitimate mode, but the caller has to be able to
    // tell the user why an answer looks thinner than usual.
    semanticSkipped = indexStats.pendingReembed > 0
      ? `${indexStats.pendingReembed} memories are waiting to be re-embedded`
      : 'no embeddings stored yet — searching text only';
  } else if (!lexicalOnly || provider === 'local') {
    // The on-device embedder is free and synchronous, so it runs even when
    // the caller asked to skip network embedding.
    try {
      const { vector } = await ai.embedOne(q);
      if (vector) {
        queryVec = normalize(toFloat32(vector));
        vecHits = await index.searchVectors(queryVec, { k: CANDIDATES, filterIds: allowIds });
      }
    } catch (e) {
      // No key, offline, rate-limited: BM25 still works, so search degrades
      // instead of failing.
      semanticSkipped = e.message;
    }
  }

  if (lexHits.length === 0 && vecHits.length === 0) {
    return scope ? recentHitsWithin(allowIds, limit) : [];
  }

  // A hashed local embedding is largely a restatement of the lexical signal,
  // so letting it vote at full strength alongside BM25 double-counts the
  // same evidence. A learned embedding is genuinely independent and gets
  // equal weight.
  const lexicalSpace = ai.local.isLexicalSpace(indexStats.space);
  const fused = rrf([
    { name: 'vector', ids: vecHits.map((h) => h.id), weight: lexicalSpace ? 0.6 : 1 },
    { name: 'lexical', ids: lexHits.map((h) => h.id), weight: 1 },
  ]);

  const semanticById = new Map(vecHits.map((h) => [h.id, h.score]));
  const lexicalById = new Map(lexHits.map((h) => [h.id, h.score]));

  // --- stage 2: exact + passage-level rescoring ---
  const shortlist = fused.slice(0, RESCORE);
  const chunkRecs = (evidence || queryVec)
    ? await store.getChunksMany(shortlist.map((c) => c.id))
    : new Map();

  const rescored = shortlist.map((c) => {
    const rec = chunkRecs.get(c.id);
    let exact = semanticById.get(c.id) ?? 0;
    let bestChunk = -1;
    let bestIdx = -1;

    if (rec && queryVec && rec.space === indexStats.space) {
      if (rec.docVec && rec.docVec.length === queryVec.length) {
        // Exact Float32 similarity, undoing quantisation error for the
        // documents that made it this far.
        exact = dot(queryVec, rec.docVec);
      }
      for (let i = 0; i < rec.count; i++) {
        const cv = rec.data.subarray(i * rec.dim, (i + 1) * rec.dim);
        const s = dot(queryVec, cv);
        if (s > bestChunk) { bestChunk = s; bestIdx = i; }
      }
    }

    // Only a passage that actually won a similarity comparison is evidence.
    // Falling back to chunk 0 handed the model the document's *opening* while
    // labelling it "the part that matched the question" — which is worse than
    // sending no passage at all, because it invites confident citation of
    // text that has nothing to do with what was asked. On the lexical-only
    // path (no query vector) there is no matched passage, and the model gets
    // the summary instead.
    // `bestChunk` starts at -1, so a chunk whose vector is all zeros — one
    // whose embedding failed while the document vector succeeded — would win
    // at exactly 0.0 over genuinely negative chunks and be handed to the model
    // as the matched passage. Requiring a positive score matches the filter
    // used to build byChunk below.
    let passage = null;
    let passageStart = 0;
    if (rec && rec.count > 0 && bestIdx >= 0 && bestChunk > 0) {
      passage = rec.texts[bestIdx] || null;
      passageStart = rec.starts ? rec.starts[bestIdx] : 0;
    }

    return {
      id: c.id,
      fusedScore: c.score,
      exact,
      bestChunk,
      semantic: semanticById.get(c.id) ?? exact,
      lexical: lexicalById.get(c.id) ?? 0,
      passage,
      passageStart,
      docVec: rec?.docVec || null,
    };
  });

  // --- final fusion ---
  // Four ranked views of the same candidate set. Recency is a weak vote for
  // ordinary questions and the dominant one when the query named a time.
  const byExact = [...rescored].filter((r) => r.exact > 0).sort((a, b) => b.exact - a.exact).map((r) => r.id);
  const byChunk = [...rescored].filter((r) => r.bestChunk > 0).sort((a, b) => b.bestChunk - a.bestChunk).map((r) => r.id);
  const times = await index.timesOf(rescored.map((r) => r.id));
  const byRecency = [...rescored].sort((a, b) => (times.get(b.id) || 0) - (times.get(a.id) || 0)).map((r) => r.id);

  const finalRanked = rrf([
    { name: 'fused', ids: shortlist.map((c) => c.id), weight: scope ? 0.5 : 1 },
    { name: 'exact', ids: byExact, weight: 1 },
    // Passage-level agreement is the strongest evidence that a long document
    // genuinely answers the question, so it votes hardest.
    { name: 'chunk', ids: byChunk, weight: 1.3 },
    { name: 'recency', ids: byRecency, weight: scope ? 2.5 : 0.25 },
  ]);

  const byId = new Map(rescored.map((r) => [r.id, r]));
  let ordered = finalRanked
    .map((f) => ({ ...byId.get(f.id), id: f.id, score: f.score, ranks: f.ranks }))
    .filter((r) => r.id);

  // --- diversification ---
  // Without this, six near-identical history rows for one article can occupy
  // every slot handed to the model.
  if (diversify && ordered.length > limit) {
    ordered = mmr(ordered.slice(0, DIVERSIFY_POOL), {
      lambda: 0.72,
      k: limit,
      getVec: (it) => it.docVec,
    }).concat(ordered.slice(DIVERSIFY_POOL));
  }

  const top = ordered.slice(0, limit);
  const records = await store.getMany(top.map((t) => t.id));

  return top.map((t, i) => ({
    memory: records[i],
    score: t.score,
    semantic: t.semantic,
    lexical: t.lexical,
    evidence: t.passage ? clipPassage(t.passage, 1400) : null,
    evidenceStart: t.passageStart,
    semanticSkipped,
  })).filter((h) => h.memory);
}

async function recentHits(limit) {
  const items = await store.recent(limit);
  return items.map((m) => ({ memory: m, score: 0, semantic: 0, lexical: 0, evidence: null }));
}

async function recentHitsWithin(ids, limit) {
  if (!ids || ids.length === 0) return [];
  const times = await index.timesOf(ids);
  const ordered = [...ids].sort((a, b) => (times.get(b) || 0) - (times.get(a) || 0)).slice(0, limit);
  const records = await store.getMany(ordered);
  return records.filter(Boolean).map((m) => ({ memory: m, score: 0, semantic: 0, lexical: 0, evidence: null }));
}

/**
 * Memories most similar to a given one. Powers the ambient "you've seen
 * something related" panel and the connections shown on a memory's detail
 * view.
 */
export async function relatedTo(memId, { limit = 5 } = {}) {
  const rec = await store.getChunks(memId);
  if (!rec?.docVec) return [];
  const hits = await index.searchVectors(rec.docVec, { k: limit + 1 });
  const ids = hits.filter((h) => h.id !== memId).slice(0, limit);
  const records = await store.getMany(ids.map((h) => h.id));
  return ids.map((h, i) => ({ memory: records[i], score: h.score })).filter((r) => r.memory);
}

/** Nearest neighbours of an arbitrary text, without storing anything. */
export async function relatedToText(text, { limit = 5, exclude = null } = {}) {
  const stats = await index.stats();
  if (stats.withVectors === 0) return [];
  const provider = await ai.effectiveProvider();
  if (stats.space && ai.spaceOf(provider) !== stats.space) return [];
  const { vector } = await ai.embedOne(text);
  if (!vector) return [];
  const hits = await index.searchVectors(vector, { k: limit + (exclude ? 3 : 0) });
  const filtered = hits.filter((h) => h.id !== exclude).slice(0, limit);
  const records = await store.getMany(filtered.map((h) => h.id));
  return filtered.map((h, i) => ({ memory: records[i], score: h.score })).filter((r) => r.memory);
}

// ---------- answer synthesis ----------

// Five-minute LRU of synthesised answers, keyed by the question plus the
// exact retrieval set. Re-asking inside the window costs zero model calls.
const ANSWER_CACHE_MAX = 20;
const ANSWER_TTL_MS = 5 * 60 * 1000;
const answerCache = new Map();

function answerCacheKey(query, memoryIds, historyLen) {
  return `${query.trim().toLowerCase()}|${historyLen}|${[...memoryIds].sort().join(',')}`;
}
function answerCacheGet(key) {
  const e = answerCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > ANSWER_TTL_MS) { answerCache.delete(key); return null; }
  answerCache.delete(key);
  answerCache.set(key, e);
  return e;
}
function answerCacheSet(key, answer, memories) {
  answerCache.delete(key);
  answerCache.set(key, { answer, memories, at: Date.now() });
  if (answerCache.size > ANSWER_CACHE_MAX) answerCache.delete(answerCache.keys().next().value);
}
export function invalidateAnswerCache() { answerCache.clear(); }

/** Non-streaming recall. Kept for callers that just want the finished text. */
export async function recall(query, { limit = 6, history = [] } = {}) {
  const hits = await search(query, { limit });
  if (hits.length === 0) return { answer: '', memories: [], hits: [] };
  const memories = hits.map(withEvidence);
  let answer = '';
  try {
    answer = await ai.answerFromMemories({ question: query, memories });
  } catch (e) {
    answer = `_(couldn't synthesize an answer: ${e.message})_`;
  }
  return { answer, memories, hits };
}

/** Attach the matched passage to the memory record handed to the model. */
function withEvidence(hit) {
  return hit.evidence ? { ...hit.memory, evidence: hit.evidence } : hit.memory;
}

/**
 * Streaming recall. onToken(delta, accumulated) fires per chunk;
 * onMemoriesResolved fires once retrieval settles so citations can render
 * before the first token arrives.
 */
export async function recallStreaming(query, {
  limit = 6,
  history = [],
  onToken,
  onMemoriesResolved,
  signal,
} = {}) {
  // Time-anchored questions need to see the actual sequence of activity, so
  // they get a wider context window.
  const effectiveLimit = isTimeAnchoredQuery(query) ? Math.max(limit, 15) : limit;
  const hits = await search(query, { limit: effectiveLimit });
  if (hits.length === 0) return { answer: '', memories: [], hits: [] };

  const memories = hits.map(withEvidence);
  onMemoriesResolved?.(memories);

  const ckey = answerCacheKey(query, memories.map((m) => m.id), history.length);
  const cached = answerCacheGet(ckey);
  if (cached) {
    console.log('[mem] recall cache hit');
    onToken?.(cached.answer, cached.answer);
    return { answer: cached.answer, memories, hits, cached: true };
  }

  let answer = '';
  try {
    answer = await ai.answerFromMemoriesStreaming({ question: query, memories, history, onToken, signal });
    if (answer && answer.length > 20) answerCacheSet(ckey, answer, memories);
  } catch (e) {
    // Errors the UI has a specific call to action for are re-thrown with the
    // retrieved memories attached, so the sources still render.
    if (e.code === 'NO_API_KEY' || /No\s.*key/i.test(e.message)) {
      const err = new Error(e.message);
      err.code = 'NO_API_KEY';
      err.memories = memories;
      err.hits = hits;
      throw err;
    }
    if (e.code === 'RATE_LIMIT' || e.status === 429 || /\b429\b/.test(e.message)) {
      const err = new Error('Rate limit — wait a minute or switch provider in Settings.');
      err.code = 'RATE_LIMIT';
      err.provider = e.provider;
      err.memories = memories;
      err.hits = hits;
      throw err;
    }
    // Retrieval succeeded and synthesis didn't. The sources are still worth
    // showing, but the caller has to be able to label it as such rather than
    // presenting an error string as if it were the recalled answer.
    answer = '';
    return { answer: '', memories, hits, synthesisFailed: true, synthesisError: e.message };
  }
  return { answer, memories, hits };
}
