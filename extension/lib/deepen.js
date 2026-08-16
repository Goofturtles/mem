// Deepening — turning a title-only memory into a real one.
//
// This exists because of an uncomfortable fact about mem's own data. The
// first-run scan ingests thousands of history entries, bookmarks, email
// subjects and video titles, and every one of them is title-only: a title,
// a URL, and an embedding computed over the title. The corpus is therefore
// overwhelmingly made of records that can be found but cannot be answered
// from, and no amount of retrieval work changes that. The ceiling on answer
// quality is set by how much of the corpus has actual content in it.
//
// Deepening fetches the page, extracts its text, and runs the full
// summarize-chunk-embed pipeline over it. Doing that on demand, one memory
// at a time, was never going to move the ceiling. So it also runs quietly in
// the background, prioritised by evidence that the user cared: pages they
// returned to, pages they bookmarked, pages they read recently.
//
// It is deliberately conservative about cost. It fetches nothing the user
// hasn't already visited, it stops on the first rate-limit, it gives up on
// pages that fail twice, and it can be turned off.

import * as store from './storage.js';
import { ingest } from './ingest.js';

const DAY = 24 * 60 * 60 * 1000;
const FAILED_KEY = 'deepenFailures';
const STATE_KEY = 'deepenState';

// Sources whose URLs don't yield useful HTML to a background fetch: Gmail and
// Classroom need an authenticated app shell, calendar entries have no page,
// YouTube's markup carries no transcript.
const NOT_FETCHABLE = new Set(['gmail', 'calendar', 'classroom', 'youtube']);

// Domains where a background fetch reliably returns a login wall or a
// consent interstitial rather than content.
const SKIP_HOSTS = [
  'mail.google.com', 'drive.google.com', 'docs.google.com', 'calendar.google.com',
  'accounts.google.com', 'classroom.google.com', 'youtube.com', 'youtu.be',
  'twitter.com', 'x.com', 'instagram.com', 'facebook.com', 'linkedin.com',
  'reddit.com', 'netflix.com', 'localhost',
];

// ---------- HTML extraction ----------

// Regex-based rather than DOMParser: this runs in an MV3 service worker,
// where DOMParser isn't reliably available.
function htmlToText(html) {
  if (!html) return { text: '', title: '' };
  let s = html;

  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const docTitle = titleMatch ? titleMatch[1].trim() : '';

  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ');
  s = s.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ');
  s = s.replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, ' ');
  s = s.replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, ' ');
  s = s.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, ' ');
  s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, ' ');
  s = s.replace(/<\/(p|div|li|h[1-6]|blockquote|article|section|tr)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');

  const ents = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&apos;': "'", '&mdash;': '—', '&ndash;': '–',
    '&hellip;': '…', '&#x27;': "'",
  };
  s = s.replace(/&(nbsp|amp|lt|gt|quot|#39|apos|mdash|ndash|hellip|#x27);/g, (m) => ents[m] || ' ');
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));

  s = s.replace(/[\t\f\v ]+/g, ' ');
  s = s.replace(/\n\s*\n\s*\n+/g, '\n\n');
  s = s.replace(/^[ \t]+|[ \t]+$/gm, '');
  return { text: s.trim(), title: docTitle };
}

// ---------- single deepen ----------

/**
 * Fetch a memory's URL and re-ingest it with full content. Credentialed so
 * pages the user is signed into come back as they'd see them.
 */
export async function deepenMemory(id) {
  const m = await store.get(id);
  if (!m) throw new Error('Memory not found.');
  if (!m.url || !/^https?:/i.test(m.url)) throw new Error("Can't deepen this — no fetchable URL.");

  let res;
  try {
    res = await fetch(m.url, { credentials: 'include', redirect: 'follow' });
  } catch (e) {
    throw new Error(`Couldn't reach the page: ${e.message}`);
  }
  if (!res.ok) throw new Error(`Page returned ${res.status}`);

  const type = res.headers.get('content-type') || '';
  if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) {
    throw new Error(`Not a readable page (${type.split(';')[0]}).`);
  }

  const html = await res.text();
  const { text, title: docTitle } = htmlToText(html);
  if (!text || text.length < 400) {
    throw new Error('No usable text on the page (likely behind a login or paywall).');
  }

  return ingest({
    url: m.url,
    title: docTitle || m.title,
    text,
    excerpt: text.slice(0, 240),
    favicon: m.favicon,
    author: m.author,
    siteName: m.siteName,
    publishedAt: m.publishedAt,
    sourceKind: m.sourceKind,
    sourceLabel: m.sourceLabel,
    mime: 'text/html',
    extra: m.extra,
  });
}

// ---------- candidate selection ----------

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function isFetchable(m) {
  if (!m.url || !/^https?:/i.test(m.url)) return false;
  if (NOT_FETCHABLE.has(m.sourceKind)) return false;
  const host = hostOf(m.url);
  if (!host) return false;
  return !SKIP_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

export function isTitleOnly(m) {
  return !!m.lightweight || !m.summary || m.summary === m.title || (m.summary || '').length < 40;
}

/**
 * Priority for deepening. Ranked by evidence the user cared about the page,
 * because spending a fetch and a summarize call on something they glanced at
 * once is the whole failure mode to avoid.
 */
export function deepenPriority(m, now = Date.now()) {
  let score = 0;
  const extra = m.extra || {};

  // Returning to a page repeatedly is the strongest signal available.
  const visits = extra.visitCount || 1;
  score += Math.min(4, Math.log2(visits + 1)) * 2.2;

  // Explicit acts of saving.
  if (m.sourceKind === 'bookmark') score += 3.5;
  if (extra.typedCount > 0) score += 1.2;   // typed the URL from memory

  // Actual engagement, when the ambient script recorded it.
  if (typeof extra.dwellMs === 'number') score += Math.min(2.5, extra.dwellMs / 120000);
  if (typeof extra.scrollPct === 'number') score += extra.scrollPct * 1.5;

  // Recent things are more likely to be asked about.
  const ageDays = (now - m.createdAt) / DAY;
  score += Math.max(0, 3 - ageDays / 14);

  // A bare domain root is usually a jumping-off point, not a thing to read.
  try {
    const path = new URL(m.url).pathname;
    if (path === '/' || path === '') score -= 2.5;
    else if (path.split('/').filter(Boolean).length >= 2) score += 0.6;
  } catch { /* keep score */ }

  return score;
}

async function failureMap() {
  return new Map(Object.entries((await store.metaGet(FAILED_KEY, {})) || {}));
}

async function recordFailure(id, message) {
  const map = await failureMap();
  const prev = map.get(id) || { n: 0 };
  map.set(id, { n: prev.n + 1, at: Date.now(), message: String(message).slice(0, 120) });
  // Bounded: keep the most recent entries only.
  const entries = [...map.entries()].slice(-3000);
  await store.metaSet(FAILED_KEY, Object.fromEntries(entries));
}

/** Highest-value title-only memories worth deepening right now. */
export async function pickCandidates({ limit = 20, now = Date.now() } = {}) {
  const [lite, failures] = await Promise.all([store.allLite(), failureMap()]);
  const out = [];
  for (const m of lite) {
    if (!isTitleOnly(m)) continue;
    if (!isFetchable(m)) continue;
    // Two failures is enough to conclude the page won't yield to a background
    // fetch — paywalls and login walls don't get better with retries.
    const f = failures.get(m.id);
    if (f && f.n >= 2) continue;
    out.push({ id: m.id, title: m.title, url: m.url, score: deepenPriority(m, now) });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// ---------- background pass ----------

export async function getState() {
  return (await store.metaGet(STATE_KEY, null)) || {
    enabled: true, deepened: 0, failed: 0, lastRunAt: 0, lastError: '',
  };
}

export async function setEnabled(enabled) {
  const s = await getState();
  await store.metaSet(STATE_KEY, { ...s, enabled: !!enabled });
  return !!enabled;
}

/**
 * Deepen a small batch. Called on an alarm so it survives service-worker
 * restarts and never blocks anything the user is doing.
 *
 * Stops immediately on a rate limit — the point is to use spare capacity,
 * not to compete with the user's own queries for it.
 */
export async function runDeepenPass({ max = 5, onProgress } = {}) {
  // Compaction runs before the enabled check on purpose. Deepening is the
  // main producer of tombstones, but not the only one — deletes and any
  // content-changed re-save produce them too, and every flush rewrites the
  // ordinal table. Gating the only release valve behind an unrelated toggle
  // meant turning deepening off let per-save write cost grow without bound.
  await maybeCompact({ onProgress });

  const state = await getState();
  // Everything below this line can spend money. Compaction above is local and
  // free, so it runs regardless; the re-embed drain makes network calls and
  // must respect the same off switch as deepening itself.
  if (!state.enabled) return { deepened: 0, skipped: 0, reason: 'disabled' };

  await drainReembedQueue({ onProgress });

  const candidates = await pickCandidates({ limit: max });
  if (candidates.length === 0) {
    await store.metaSet(STATE_KEY, { ...state, lastRunAt: Date.now() });
    return { deepened: 0, skipped: 0, reason: 'nothing to deepen' };
  }

  let deepened = 0;
  let failed = 0;
  let stopReason = 'complete';

  for (const c of candidates) {
    try {
      await deepenMemory(c.id);
      deepened++;
      onProgress?.({ stage: 'deepen', done: deepened, total: candidates.length, title: c.title });
    } catch (e) {
      if (e.code === 'RATE_LIMIT' || e.status === 429 || /\b429\b|rate limit/i.test(e.message)) {
        stopReason = 'rate limited';
        break;
      }
      if (e.code === 'NO_API_KEY') {
        stopReason = 'no key';
        break;
      }
      failed++;
      await recordFailure(c.id, e.message);
    }
    // Space the fetches out so a background pass is never mistaken for a
    // crawler by the sites being fetched.
    await new Promise((r) => setTimeout(r, 1200));
  }

  await store.metaSet(STATE_KEY, {
    ...state,
    deepened: (state.deepened || 0) + deepened,
    failed: (state.failed || 0) + failed,
    lastRunAt: Date.now(),
    lastError: stopReason === 'complete' ? '' : stopReason,
  });

  return { deepened, failed, reason: stopReason };
}

// Compact once a third of the ordinal table is dead. Below that the wasted
// scan is a rounding error; above it, both the vector matrix and every
// postings list are carrying weight for documents that no longer exist.
const COMPACT_THRESHOLD = 0.34;
const COMPACT_MIN_ORDINALS = 200;

async function maybeCompact({ onProgress } = {}) {
  try {
    const index = await import('./index.js');
    const stats = await index.stats();
    if (stats.ordinals < COMPACT_MIN_ORDINALS) return false;
    const ratio = await index.tombstoneRatio();
    if (ratio < COMPACT_THRESHOLD) return false;
    console.log(`[mem] compacting index — ${(ratio * 100).toFixed(0)}% of ordinals are tombstoned`);
    const res = await index.compact({ onProgress });
    console.log(`[mem] compacted ${res.before} → ${res.after} ordinals`);
    return true;
  } catch (e) {
    // Compaction is housekeeping; failing it must never stop deepening.
    console.warn('[mem] compaction skipped:', e.message);
    return false;
  }
}

// Documents get queued for re-embedding whenever their vector can't be used:
// a provider switch changes the embedding space, a shard is dropped for being
// in an old format, or an embedding came back all-zero. Nothing consumed that
// queue, so "queued for re-embedding" meant "silently lexical-only forever".
// This drains it, a batch at a time, on the same background pass.
const REEMBED_BATCH = 24;

async function drainReembedQueue({ onProgress } = {}) {
  try {
    const index = await import('./index.js');
    const ids = await index.pendingReembedIds(REEMBED_BATCH);
    if (ids.length === 0) return 0;

    const ai = await import('./ai.js');
    const stats = await index.stats();
    const provider = await ai.effectiveProvider();
    const querySpace = ai.spaceOf(provider);

    // If the provider has changed, every document in the corpus needs a new
    // vector, not twenty-four of them — and re-embedding into a space the
    // index doesn't use would have addDoc re-queue each one immediately,
    // spending real money on an endless loop. A whole-corpus re-index is the
    // correct response, and it is the user's call to make.
    if (stats.space && querySpace !== stats.space) {
      console.warn(
        `[mem] ${stats.pendingReembed} memories need re-embedding, but the index was built with ` +
        `${stats.space} and this provider produces ${querySpace}. Re-index from Settings to switch spaces.`
      );
      return 0;
    }

    const records = (await store.getMany(ids)).filter(Boolean);
    if (records.length === 0) {
      // Every id at the head of the queue points at a deleted memory. Left
      // alone these starve the queue permanently, since pendingReembedIds
      // always reads from the front.
      await index.dropFromReembedQueue(ids);
      return 0;
    }

    // Before paying for anything, check what's already on disk. A document
    // queued because its shard was dropped for being in an old format still
    // has an exact vector in the chunk store, in the current space — the
    // format stamp guards the packed matrix, not the chunk records. On a
    // format upgrade that is the *entire corpus* queued, and re-embedding all
    // of it would be a large bill for data we already hold.
    const onDisk = await store.getChunksMany(records.map((m) => m.id));
    const needsEmbedding = [];
    let restored = 0;
    for (const m of records) {
      const rec = onDisk.get(m.id);
      if (rec?.docVec && rec.space === stats.space) {
        await index.addDoc({
          id: m.id, vec: rec.docVec, space: rec.space, createdAt: m.createdAt,
          chunks: null,
          tokensText: [m.title, m.summary, (m.tags || []).join(' '), (m.keyFacts || []).join(' '), m.text].filter(Boolean).join('\n'),
        }, { writeChunks: false });
        restored++;
      } else {
        needsEmbedding.push(m);
      }
    }
    if (restored) {
      await index.flush();
      console.log(`[mem] restored ${restored} vectors from disk without re-embedding`);
    }
    if (needsEmbedding.length === 0) {
      onProgress?.({ stage: 'reembed', done: restored, total: records.length });
      return restored;
    }

    // Built from needsEmbedding, not records: the returned vectors are
    // consumed positionally, so embedding the full set while iterating the
    // filtered one would attach each vector to the wrong document.
    const texts = needsEmbedding.map((m) => [
      m.title, m.summary, (m.tags || []).join(', '), (m.text || '').slice(0, 2000),
    ].filter(Boolean).join('\n\n'));

    const { vectors, space } = await ai.embedMany(texts);

    // Re-check the space against what actually came back, not what was
    // intended. embedMany routes through viaChain, which falls back to the
    // next provider on 429/401/5xx/network — and a background pass running
    // into a rate limit is the expected case, not an exotic one. Writing the
    // fallback's vectors would overwrite good on-disk vectors with ones
    // addDoc immediately rejects, destroying data that was restorable for
    // free and leaving the documents queued for the next pass to destroy too.
    if (stats.space && space !== stats.space) {
      console.warn(
        `[mem] re-embed aborted: asked for ${stats.space} but the provider chain returned ${space}. ` +
        'Nothing was written. Check the provider or re-index from Settings.'
      );
      return restored;
    }

    let done = restored;
    for (let i = 0; i < needsEmbedding.length; i++) {
      if (!vectors[i]) continue;
      const m = needsEmbedding[i];
      // The chunk record has to be updated too, not just the packed matrix.
      // Compaction and crash recovery both re-index from `rec.docVec` /
      // `rec.space`, so a matrix-only re-embed is reverted by the next
      // rebuild — and if the stored space is stale, addDoc re-queues the
      // document, which turns this pass and the compaction pass into a cycle
      // that sustains itself and bills for every lap.
      await store.updateChunkVector(m.id, { docVec: vectors[i], space });
      await index.addDoc({
        id: m.id,
        vec: vectors[i],
        space,
        createdAt: m.createdAt,
        chunks: null,      // existing passages are preserved by updateChunkVector
        tokensText: [
          m.title, m.summary, (m.tags || []).join(' '),
          (m.keyFacts || []).join(' '), m.text,
        ].filter(Boolean).join('\n'),
      }, { writeChunks: false });
      done++;
    }
    await index.flush();
    onProgress?.({ stage: 'reembed', done, total: records.length });
    if (done > restored) console.log(`[mem] re-embedded ${done - restored} memories that had no usable vector`);
    return done;
  } catch (e) {
    // Rate limits and missing keys are expected here; the queue persists and
    // the next pass tries again.
    console.warn('[mem] re-embed pass skipped:', e.message);
    return 0;
  }
}

/** How much of the corpus has real content. Shown in settings. */
export async function coverage() {
  const lite = await store.allLite();
  let full = 0;
  let titleOnly = 0;
  let deepenable = 0;
  for (const m of lite) {
    if (isTitleOnly(m)) {
      titleOnly++;
      if (isFetchable(m)) deepenable++;
    } else {
      full++;
    }
  }
  const total = full + titleOnly;
  return { total, full, titleOnly, deepenable, pct: total ? full / total : 0 };
}
