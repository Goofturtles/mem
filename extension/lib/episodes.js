// Episodes — activity reconstructed into named work sessions.
//
// Browser history is a flat chronological list. That's a log, not a memory.
// People don't recall Tuesday as forty-one URLs; they recall "the afternoon I
// was trying to figure out why the auth redirect kept looping". An episode is
// that unit: a contiguous stretch of related activity with a name, a span, a
// set of sources, and a one-line account of what was going on.
//
// Segmentation is two-pass and entirely local:
//
//   1. Split on idle gaps. A gap longer than the threshold ends a session —
//      this is how people actually experience breaks in their own work.
//   2. Split long sessions on topic shift. Inside one uninterrupted stretch a
//      person often switches subjects; consecutive-item similarity against a
//      running centroid finds the seam. This uses vectors mem already has,
//      so it costs nothing.
//
// Naming is deferred. A deterministic name derived from tags and domains is
// available immediately and for free; the model-written name is generated
// only for episodes the user actually looks at, and then cached. Naming every
// episode of a six-month history scan up front would be hundreds of calls
// for text nobody would read.

import * as store from './storage.js';
import * as ai from './ai.js';
import { dot, normalize } from './vec.js';
import { contentTokens } from './text.js';

// Idle gap that ends a session. Long enough to survive reading one long
// article without interruption, short enough that lunch starts a new one.
const DEFAULT_GAP_MIN = 45;

// An episode needs enough in it to be worth recalling as a unit.
const MIN_ITEMS = 3;

// Below this similarity to the running centroid, a long session is treated as
// having changed subject.
const TOPIC_SHIFT = 0.42;

// Only sessions at least this long get the topic-shift pass.
const SPLIT_MIN_ITEMS = 8;

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function episodeId(startedAt, firstMemId) {
  return `ep-${startedAt}-${String(firstMemId || '').slice(0, 8)}`;
}

/** Split a time-ordered list wherever the idle gap exceeds the threshold. */
function segmentByTime(items, gapMs) {
  const segments = [];
  let cur = [];
  for (const m of items) {
    if (cur.length === 0) { cur.push(m); continue; }
    const prev = cur[cur.length - 1];
    if (m.createdAt - prev.createdAt > gapMs) {
      segments.push(cur);
      cur = [m];
    } else {
      cur.push(m);
    }
  }
  if (cur.length) segments.push(cur);
  return segments;
}

/**
 * Split one time segment where its subject changes.
 *
 * Walks forward maintaining a centroid of the current run. When an item is
 * far from that centroid and both sides would still be substantial, the run
 * is cut and the centroid restarts. Both-sides-substantial is what stops a
 * single unrelated tab from fragmenting an otherwise coherent session.
 */
function splitByTopic(segment, vecs) {
  if (segment.length < SPLIT_MIN_ITEMS) return [segment];

  const out = [];
  let run = [];
  let centroid = null;
  let centroidCount = 0;

  const addToCentroid = (v) => {
    if (!v) return;
    if (!centroid) { centroid = Float32Array.from(v); centroidCount = 1; return; }
    for (let i = 0; i < centroid.length; i++) centroid[i] += v[i];
    centroidCount++;
  };
  const centroidUnit = () => (centroid ? normalize(centroid) : null);

  for (const m of segment) {
    const v = vecs.get(m.id) || null;
    if (run.length === 0) {
      run.push(m);
      addToCentroid(v);
      continue;
    }
    const c = centroidUnit();
    const sim = v && c ? dot(v, c) : 1; // no vector → never forces a split
    const remaining = segment.length - (out.reduce((n, s) => n + s.length, 0) + run.length);
    if (sim < TOPIC_SHIFT && run.length >= MIN_ITEMS && remaining >= MIN_ITEMS) {
      out.push(run);
      run = [m];
      centroid = null;
      centroidCount = 0;
      addToCentroid(v);
    } else {
      run.push(m);
      addToCentroid(v);
    }
  }
  if (run.length) out.push(run);
  return out;
}

function topCounts(values, n) {
  const counts = new Map();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([v]) => v);
}

/**
 * Name derived from the episode's own contents. Always available, costs
 * nothing, and reads sensibly — which means an episode is never a blank row
 * waiting on a model call.
 *
 * Tags come from the summarizer, so they only exist for fully ingested
 * memories. An episode made of history entries has none, and naming those
 * after their domain produced rows that all read "example.test" — accurate
 * and completely useless. Recurring words across the titles are the fallback,
 * because a session's titles overlap heavily on whatever it was about.
 */
function deterministicName(items) {
  const tags = topCounts(items.flatMap((m) => m.tags || []), 2);
  if (tags.length) {
    const label = tags.join(' · ');
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  const shared = recurringTitleWords(items, 3);
  if (shared.length >= 2) {
    const label = shared.join(' ');
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  const sites = topCounts(items.map((m) => m.siteName || hostOf(m.url)), 1);
  if (shared.length === 1) {
    const word = shared[0].charAt(0).toUpperCase() + shared[0].slice(1);
    return sites[0] ? `${word} · ${sites[0]}` : word;
  }
  if (sites.length && sites[0]) return `Browsing ${sites[0]}`;
  const kinds = topCounts(items.map((m) => m.sourceKind), 1);
  return kinds.length ? `${kinds[0]} session` : 'Session';
}

/** Content words appearing across more than one title in the episode. */
function recurringTitleWords(items, limit) {
  const docFreq = new Map();
  for (const m of items) {
    // Count each word once per title, so one long title can't dominate.
    for (const w of new Set(contentTokens(m.title || ''))) {
      if (w.length < 4) continue;
      docFreq.set(w, (docFreq.get(w) || 0) + 1);
    }
  }
  const threshold = items.length >= 4 ? 2 : 1;
  return [...docFreq.entries()]
    .filter(([, n]) => n >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([w]) => w);
}

function buildEpisode(items) {
  const sorted = [...items].sort((a, b) => a.createdAt - b.createdAt);
  const startedAt = sorted[0].createdAt;
  const endedAt = sorted[sorted.length - 1].createdAt;
  return {
    id: episodeId(startedAt, sorted[0].id),
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    memIds: sorted.map((m) => m.id),
    count: sorted.length,
    title: deterministicName(sorted),
    gist: '',
    named: false,
    topTags: topCounts(sorted.flatMap((m) => m.tags || []), 5),
    topSites: topCounts(sorted.map((m) => m.siteName || hostOf(m.url)), 4),
    sourceKinds: topCounts(sorted.map((m) => m.sourceKind), 5),
  };
}

/**
 * Rebuild every episode from scratch. Deterministic, local, no model calls.
 */
export async function rebuildEpisodes({ gapMinutes = DEFAULT_GAP_MIN, onProgress } = {}) {
  const lite = await store.allLite();
  onProgress?.({ stage: 'segment', total: lite.length });

  // Future-dated records (upcoming calendar events, assignments not yet due)
  // are not things that happened, so they don't belong in a session.
  const now = Date.now();
  const items = lite
    .filter((m) => m.createdAt <= now)
    .sort((a, b) => a.createdAt - b.createdAt);

  const segments = segmentByTime(items, gapMinutes * 60000);

  // Load vectors only for segments long enough to be worth splitting.
  const needVecs = segments.filter((s) => s.length >= SPLIT_MIN_ITEMS).flatMap((s) => s.map((m) => m.id));
  const vecs = new Map();
  if (needVecs.length) {
    onProgress?.({ stage: 'vectors', total: needVecs.length });
    const BATCH = 300;
    for (let i = 0; i < needVecs.length; i += BATCH) {
      const recs = await store.getChunksMany(needVecs.slice(i, i + BATCH));
      for (const [id, rec] of recs) if (rec.docVec) vecs.set(id, rec.docVec);
    }
  }

  const episodes = [];
  for (const seg of segments) {
    for (const run of splitByTopic(seg, vecs)) {
      if (run.length < MIN_ITEMS) continue;
      episodes.push(buildEpisode(run));
    }
  }

  await store.episodesClear();
  await store.episodePutMany(episodes);

  // Write the back-reference so a memory can say which session it belonged to.
  const byMem = new Map();
  for (const ep of episodes) for (const mid of ep.memIds) byMem.set(mid, ep.id);
  const updates = [];
  for (const [mid, epId] of byMem) {
    const full = await store.get(mid);
    if (!full || full.episodeId === epId) continue;
    full.episodeId = epId;
    updates.push(full);
    if (updates.length >= 400) await store.putMany(updates.splice(0));
  }
  if (updates.length) await store.putMany(updates);

  onProgress?.({ stage: 'done', total: episodes.length });
  return { episodes: episodes.length, assigned: byMem.size };
}

/**
 * Incrementally place recent memories. Cheaper than a full rebuild, and safe
 * to run after every capture: it either extends the newest episode or starts
 * a fresh one.
 */
export async function assignRecent({ gapMinutes = DEFAULT_GAP_MIN } = {}) {
  const all = await store.episodesAll();
  all.sort((a, b) => b.endedAt - a.endedAt);
  const latest = all[0];
  const since = latest ? latest.endedAt : 0;

  const fresh = (await store.betweenDates(since + 1, Date.now() + 1, { limit: 500 }))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (fresh.length === 0) return { updated: 0, created: 0 };

  const gapMs = gapMinutes * 60000;
  let created = 0;
  let updated = 0;
  let current = latest && fresh[0].createdAt - latest.endedAt <= gapMs ? latest : null;
  const pending = [];

  for (const m of fresh) {
    if (current && m.createdAt - current.endedAt > gapMs) {
      await store.episodePut(current);
      current = null;
    }
    if (!current) {
      current = buildEpisode([m]);
      created++;
    } else {
      if (!current.memIds.includes(m.id)) current.memIds.push(m.id);
      current.endedAt = m.createdAt;
      current.durationMs = current.endedAt - current.startedAt;
      current.count = current.memIds.length;
      updated++;
    }
    m.episodeId = current.id;
    pending.push(m);
  }

  if (current) {
    // Refresh the derived fields against the episode's full membership.
    const members = (await store.getMany(current.memIds)).filter(Boolean);
    if (members.length) {
      const rebuilt = buildEpisode(members);
      current.title = current.named ? current.title : rebuilt.title;
      current.topTags = rebuilt.topTags;
      current.topSites = rebuilt.topSites;
      current.sourceKinds = rebuilt.sourceKinds;
    }
    await store.episodePut(current);
  }
  if (pending.length) await store.putMany(pending);

  return { updated, created };
}

/** Episodes newest first, optionally only those with real substance. */
export async function listEpisodes({ limit = 40, minItems = MIN_ITEMS } = {}) {
  const all = await store.episodesAll();
  return all
    .filter((e) => e.count >= minItems)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}

export async function getEpisode(id) {
  const ep = await store.episodeGet(id);
  if (!ep) return null;
  const memories = (await store.getMany(ep.memIds)).filter(Boolean);
  memories.sort((a, b) => a.createdAt - b.createdAt);
  return { episode: ep, memories };
}

/**
 * Give episodes model-written names. Called for the episodes actually on
 * screen, and cached — a named episode is never renamed.
 */
export async function nameEpisodes(ids, { onNamed } = {}) {
  const out = [];
  for (const id of ids) {
    const ep = await store.episodeGet(id);
    if (!ep || ep.named) continue;
    const memories = (await store.getMany(ep.memIds)).filter(Boolean);
    if (memories.length < MIN_ITEMS) continue;
    try {
      const { title, gist } = await ai.nameCluster({ items: memories, kind: 'session' });
      if (title) {
        ep.title = title;
        ep.gist = gist;
        ep.named = true;
        await store.episodePut(ep);
        out.push(ep);
        onNamed?.(ep);
      }
    } catch (e) {
      // The deterministic name is already in place, so a failure here just
      // means the episode keeps its cheaper name.
      console.warn('[mem] episode naming failed:', e.message);
      break; // stop the batch — the next call would fail the same way
    }
  }
  return out;
}

/** The episode a memory belongs to, with its siblings. */
export async function episodeFor(memId) {
  const m = await store.get(memId);
  if (!m?.episodeId) return null;
  return getEpisode(m.episodeId);
}

export { DEFAULT_GAP_MIN, MIN_ITEMS };
