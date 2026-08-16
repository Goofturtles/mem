// Resurface — bringing back what's about to be forgotten, and noticing when
// two things you saw months apart belong together.
//
// A search bar is passive: it answers when asked, and everything you fail to
// ask about is functionally lost. Human memory doesn't work that way — it
// volunteers. This module is the part of mem that volunteers.
//
// Two mechanisms:
//
//   Decay.       Retention of a specific memory falls off roughly
//                exponentially with time, and the rate depends on how firmly
//                it was encoded in the first place. Things you highlighted,
//                returned to, or bookmarked decay slowly; a page glanced at
//                once decays fast. The interesting moment to resurface
//                something is when retention has fallen enough that it's
//                genuinely slipping, but not so far that it's already gone.
//
//   Connection.  Two memories that are semantically close but separated by
//                weeks are exactly the pair you'd never think to search for
//                together, because you no longer remember the older one
//                exists. Surfacing those is the thing an index of your own
//                past can do that a search box cannot.

import * as store from './storage.js';
import * as index from './index.js';
import { dot } from './vec.js';

const DAY = 24 * 60 * 60 * 1000;

// Baseline memory strength, in days, for something seen once and never
// revisited. Signals below multiply this upward.
const BASE_STABILITY_DAYS = 9;

// Retention band worth acting on. Above the upper bound it's still fresh and
// resurfacing is noise; below the lower bound it's long gone and showing it
// reads as random.
const RETENTION_HIGH = 0.72;
const RETENTION_LOW = 0.12;

// Don't show the same memory again inside this window.
const COOLDOWN_DAYS = 30;

/**
 * How firmly this memory was encoded, expressed as a stability constant in
 * days. Each signal is evidence the user cared, and caring is what makes a
 * memory durable.
 */
export function stabilityDays(m) {
  let s = BASE_STABILITY_DAYS;
  const extra = m.extra || {};

  // Deliberate acts beat passive exposure by a wide margin.
  if (m.sourceKind === 'bookmark') s *= 3.0;
  if (m.selectionLength > 0 || (m.selection && m.selection.length > 0)) s *= 2.4;
  if (m.sourceKind === 'file' || m.sourceKind === 'drive') s *= 1.8;

  // Repeat exposure is the strongest natural consolidator there is.
  const visits = extra.visitCount || 1;
  if (visits > 1) s *= 1 + Math.min(1.8, Math.log2(visits));

  // Real engagement with the page itself.
  if (typeof extra.scrollPct === 'number' && extra.scrollPct > 0.7) s *= 1.5;
  if (typeof extra.dwellMs === 'number' && extra.dwellMs > 180000) s *= 1.4;

  // Substance: a memory with extracted facts had something worth extracting.
  if ((m.keyFacts || []).length >= 3) s *= 1.3;
  if (m.contentType === 'paper' || m.contentType === 'tutorial') s *= 1.2;

  // A title-only memory was never really encoded at all.
  if (m.lightweight) s *= 0.45;

  return s;
}

/** Exponential forgetting curve: retention after `ageDays` at stability `s`. */
export function retention(ageDays, s) {
  if (s <= 0) return 0;
  return Math.exp(-ageDays / s);
}

/**
 * Worth surfacing? Peaks when retention sits in the middle of the actionable
 * band, weighted by how much the memory was worth keeping in the first place.
 */
function resurfaceScore(m, now) {
  const ageDays = (now - m.createdAt) / DAY;
  if (ageDays < 3) return 0;                    // still fresh in mind
  const s = stabilityDays(m);
  const r = retention(ageDays, s);
  if (r > RETENTION_HIGH || r < RETENTION_LOW) return 0;

  // Triangular peak in the middle of the band.
  const mid = (RETENTION_HIGH + RETENTION_LOW) / 2;
  const halfSpan = (RETENTION_HIGH - RETENTION_LOW) / 2;
  const position = 1 - Math.abs(r - mid) / halfSpan;

  // Importance: what made it durable also makes it worth remembering.
  const importance = Math.min(1, s / (BASE_STABILITY_DAYS * 4));
  return position * (0.45 + 0.55 * importance);
}

/**
 * Memories that are slipping and worth a second look.
 */
export async function dueForResurface({ limit = 8, now = Date.now() } = {}) {
  const lite = await store.allLite();
  const cooldownBefore = now - COOLDOWN_DAYS * DAY;

  const scored = [];
  for (const m of lite) {
    if (m.createdAt > now) continue;                      // upcoming, not past
    if (m.sourceKind === 'calendar') continue;            // events aren't knowledge
    const last = m.extra?.lastResurfacedAt || 0;
    if (last > cooldownBefore) continue;
    const score = resurfaceScore(m, now);
    if (score <= 0) continue;
    const ageDays = (now - m.createdAt) / DAY;
    scored.push({
      memory: m,
      score,
      retention: retention(ageDays, stabilityDays(m)),
      ageDays: Math.round(ageDays),
      reason: describeReason(m, ageDays),
    });
  }

  scored.sort((a, b) => b.score - a.score);

  // One per site keeps a single prolific domain from filling the list.
  const seenSite = new Set();
  const out = [];
  for (const s of scored) {
    const site = s.memory.siteName || '';
    if (site && seenSite.has(site)) continue;
    seenSite.add(site);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function describeReason(m, ageDays) {
  const when = ageDays < 45 ? `${Math.round(ageDays)} days ago`
    : ageDays < 400 ? `${Math.round(ageDays / 30)} months ago`
    : `${Math.round(ageDays / 365)} years ago`;
  if (m.sourceKind === 'bookmark') return `You bookmarked this ${when} and haven't been back.`;
  if ((m.extra?.visitCount || 1) > 2) return `You came back to this ${m.extra.visitCount} times ${when}.`;
  if ((m.keyFacts || []).length >= 3) return `You read this ${when} — it had a few things worth keeping.`;
  return `You read this ${when}.`;
}

/** Mark memories as shown so the cooldown applies. */
export async function markResurfaced(ids, now = Date.now()) {
  const records = (await store.getMany(ids)).filter(Boolean);
  for (const r of records) {
    r.extra = { ...(r.extra || {}), lastResurfacedAt: now };
  }
  if (records.length) await store.putMany(records);
  return records.length;
}

// ---------- connections ----------

// Close enough to be about the same thing.
const CONNECTION_MIN_SIM = 0.62;
// Far enough apart in time that the user has plausibly forgotten the older
// one — which is the entire reason the pairing is interesting.
const CONNECTION_MIN_GAP_DAYS = 14;

/**
 * Pairs of memories that are semantically close but temporally distant.
 *
 * Anchored on recent memories rather than scanning all pairs: for each of the
 * last `anchors` memories, ask the index for its nearest neighbours and keep
 * the ones from a different era. That's `anchors` index scans instead of
 * O(n²) comparisons, so it stays fast on a large corpus.
 */
export async function findConnections({ anchors = 25, limit = 10, now = Date.now() } = {}) {
  const recentIds = await index.recentIds(anchors);
  if (recentIds.length === 0) return [];

  const chunkRecs = await store.getChunksMany(recentIds);
  const times = await index.timesOf(recentIds);
  const seenPair = new Set();
  const found = [];

  for (const id of recentIds) {
    const rec = chunkRecs.get(id);
    if (!rec?.docVec) continue;
    const neighbours = await index.searchVectors(rec.docVec, { k: 6 });
    const anchorTime = times.get(id) || now;

    for (const n of neighbours) {
      if (n.id === id) continue;
      if (n.score < CONNECTION_MIN_SIM) continue;
      const key = [id, n.id].sort().join('|');
      if (seenPair.has(key)) continue;

      const otherTimes = await index.timesOf([n.id]);
      const otherTime = otherTimes.get(n.id) || 0;
      const gapDays = Math.abs(anchorTime - otherTime) / DAY;
      if (gapDays < CONNECTION_MIN_GAP_DAYS) continue;

      seenPair.add(key);
      found.push({ recentId: id, olderId: n.id, similarity: n.score, gapDays: Math.round(gapDays) });
    }
  }

  found.sort((a, b) => b.similarity - a.similarity);
  const top = found.slice(0, limit);

  const ids = [...new Set(top.flatMap((c) => [c.recentId, c.olderId]))];
  const records = await store.getMany(ids);
  const byId = new Map(ids.map((id, i) => [id, records[i]]));

  return top.map((c) => ({
    recent: byId.get(c.recentId),
    older: byId.get(c.olderId),
    similarity: c.similarity,
    gapDays: c.gapDays,
    reason: `You saw something closely related ${c.gapDays < 45 ? `${c.gapDays} days` : `${Math.round(c.gapDays / 30)} months`} earlier.`,
  })).filter((c) => c.recent && c.older);
}

export { RETENTION_HIGH, RETENTION_LOW, COOLDOWN_DAYS, CONNECTION_MIN_SIM };
