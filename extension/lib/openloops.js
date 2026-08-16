// Open loops — things started and never finished.
//
// This is the clearest example of something a history search cannot do, and
// not for lack of effort: history records that a URL was visited. It has no
// representation of state, so "did I finish this" is not a question it can
// hold, let alone answer.
//
// mem can, because it keeps things history doesn't:
//   - how far down a page the user actually got, and how long they stayed
//     (recorded by the ambient content script)
//   - whether a Classroom assignment was turned in
//   - whether an email is still unread days later
//   - how much text a page had, so "read 8% of a 9,000-word piece" is
//     distinguishable from "read all of a short one"
//
// Every signal is optional. A source that doesn't supply one simply doesn't
// produce that kind of loop, rather than producing a wrong one.

import * as store from './storage.js';

const DAY = 24 * 60 * 60 * 1000;

// A page has to be substantial before "you didn't finish it" is meaningful.
const LONG_READ_CHARS = 6000;
// And the user has to have actually engaged with it — a page open for three
// seconds was a mis-click, not an abandoned read.
const MIN_DWELL_MS = 20000;
// Below this fraction of the page, the read is unfinished.
const ABANDONED_SCROLL = 0.4;

const DISMISSED_KEY = 'dismissedLoops';

async function dismissedSet() {
  const list = await store.metaGet(DISMISSED_KEY, []);
  return new Set(list || []);
}

/** Hide a loop permanently. Keyed by loop id, not memory id, so a memory can
 *  still surface later for a different reason. */
export async function dismiss(loopId) {
  const list = await store.metaGet(DISMISSED_KEY, []);
  const set = new Set(list || []);
  set.add(loopId);
  // Bounded so this can't grow without limit.
  await store.metaSet(DISMISSED_KEY, [...set].slice(-2000));
}

export async function undismiss(loopId) {
  const list = await store.metaGet(DISMISSED_KEY, []);
  await store.metaSet(DISMISSED_KEY, (list || []).filter((x) => x !== loopId));
}

function loopId(kind, memId) { return `${kind}:${memId}`; }

/** Map "how soon is this due" onto 0..1. Overdue saturates at 1. */
function dueUrgency(due, now) {
  if (!due) return 0;
  const delta = due - now;
  if (delta <= 0) return 1;
  if (delta < DAY) return 0.95;
  if (delta < 3 * DAY) return 0.8;
  if (delta < 7 * DAY) return 0.55;
  if (delta < 14 * DAY) return 0.3;
  return 0.15;
}

function looksLikeAQuestion(m) {
  const hay = `${m.title || ''} ${m.summary || ''}`;
  if (/\?/.test(hay)) return true;
  return /\b(can you|could you|would you|please (send|share|confirm|review|let me know)|let me know|any update|following up|reminder|deadline|rsvp|confirm)\b/i.test(hay);
}

/**
 * Find everything currently unfinished.
 *
 * Returns [{ id, kind, label, reason, urgency, memory, dueAt }] sorted by
 * urgency. `reason` is written to be shown to the user verbatim.
 */
export async function findOpenLoops({ limit = 25, now = Date.now() } = {}) {
  const [lite, dismissed] = await Promise.all([store.allLite(), dismissedSet()]);
  const loops = [];

  for (const m of lite) {
    const extra = m.extra || {};

    // --- Classroom assignments: explicit, reliable state ---
    if (m.sourceKind === 'classroom' && extra.due && extra.submitted === false) {
      const overdue = extra.due < now;
      const kind = overdue ? 'assignment-overdue' : 'assignment-due';
      const id = loopId(kind, m.id);
      if (!dismissed.has(id)) {
        const course = extra.courseName ? ` for ${extra.courseName}` : '';
        loops.push({
          id, kind, memory: m, dueAt: extra.due,
          label: overdue ? 'Overdue' : 'Due soon',
          reason: overdue
            ? `Not turned in${course} — was due ${relative(extra.due, now)}.`
            : `Not turned in${course} — due ${relative(extra.due, now)}.`,
          urgency: overdue ? 1 : dueUrgency(extra.due, now),
        });
      }
      continue;
    }

    // --- Email still unread after a day, that reads like it wants a reply ---
    if (m.sourceKind === 'gmail') {
      const labels = extra.labels || [];
      const unread = labels.includes('UNREAD');
      const age = now - m.createdAt;
      if (unread && age > DAY && looksLikeAQuestion(m)) {
        const id = loopId('unread-email', m.id);
        if (!dismissed.has(id)) {
          loops.push({
            id, kind: 'unread-email', memory: m, dueAt: null,
            label: 'Unanswered',
            reason: `${m.author ? shortName(m.author) : 'Someone'} wrote ${relative(m.createdAt, now)} and it's still unread.`,
            // Older unanswered mail is more of a problem, not less, but the
            // signal decays once it's clearly been abandoned on purpose.
            urgency: age > 21 * DAY ? 0.25 : Math.min(0.75, 0.3 + age / (14 * DAY) * 0.45),
          });
        }
        continue;
      }
    }

    // --- Long reads the user got a little way into and left ---
    // Needs the ambient script's dwell and scroll signals; without them this
    // rule stays silent rather than guessing.
    const scroll = extra.scrollPct;
    const dwell = extra.dwellMs;
    if (
      typeof scroll === 'number' && typeof dwell === 'number' &&
      m.textLength >= LONG_READ_CHARS &&
      dwell >= MIN_DWELL_MS &&
      scroll < ABANDONED_SCROLL &&
      now - m.createdAt > 2 * DAY
    ) {
      const id = loopId('abandoned-read', m.id);
      if (!dismissed.has(id)) {
        const pct = Math.round(scroll * 100);
        const mins = Math.max(1, Math.round(dwell / 60000));
        loops.push({
          id, kind: 'abandoned-read', memory: m, dueAt: null,
          label: 'Unfinished',
          reason: `You spent ${mins} min here ${relative(m.createdAt, now)} and got about ${pct}% through.`,
          // Something you nearly finished is a better prompt to return than
          // something you barely started.
          urgency: 0.2 + scroll * 0.5,
        });
      }
      continue;
    }

    // --- Documents opened once and never returned to ---
    if (m.sourceKind === 'drive' && extra.modifiedByMe && !extra.revisited) {
      const age = now - (extra.modifiedTime || m.createdAt);
      if (age > 7 * DAY && age < 120 * DAY) {
        const id = loopId('stale-doc', m.id);
        if (!dismissed.has(id)) {
          loops.push({
            id, kind: 'stale-doc', memory: m, dueAt: null,
            label: 'Untouched',
            reason: `You last edited this ${relative(extra.modifiedTime || m.createdAt, now)} and haven't opened it since.`,
            urgency: 0.25,
          });
        }
      }
    }
  }

  loops.sort((a, b) => b.urgency - a.urgency || (a.dueAt || Infinity) - (b.dueAt || Infinity));
  return loops.slice(0, limit);
}

/** Counts by kind, for a badge or a summary line. */
export async function openLoopCounts(opts = {}) {
  const loops = await findOpenLoops({ ...opts, limit: 500 });
  const counts = {};
  for (const l of loops) counts[l.kind] = (counts[l.kind] || 0) + 1;
  return { total: loops.length, byKind: counts };
}

function shortName(author) {
  const s = String(author || '').trim();
  const angled = s.match(/^"?([^"<]+?)"?\s*</);
  return (angled ? angled[1] : s.split('@')[0]).trim() || 'Someone';
}

function relative(ts, now = Date.now()) {
  const d = ts - now;
  const abs = Math.abs(d);
  const unit = abs < 3600000 ? [Math.round(abs / 60000), 'min']
    : abs < DAY ? [Math.round(abs / 3600000), 'hour']
    : abs < 30 * DAY ? [Math.round(abs / DAY), 'day']
    : [Math.round(abs / (30 * DAY)), 'month'];
  const n = Math.max(1, unit[0]);
  const word = `${n} ${unit[1]}${n === 1 ? '' : 's'}`;
  return d >= 0 ? `in ${word}` : `${word} ago`;
}
