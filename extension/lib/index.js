// The retrieval index: an ordinal table, a packed quantised vector matrix,
// and a BM25 inverted index.
//
// What this replaces: search used to call store.all(), pull every memory —
// including up to 60KB of body text and a 1536-element plain JS array — into
// the page, and run a full linear pass computing cosine with three square
// roots per document, on every query. At a few hundred memories that is
// merely wasteful; at the tens of thousands mem's own first-run scan creates
// (5,000 history + 1,500 YouTube + 1,000 calendar + Gmail + Drive) it stops
// working.
//
// Here, a query touches:
//   - one contiguous int8 matrix for the semantic pass (~12MB at 8,000 docs,
//     integer multiply-accumulate, no allocation), and
//   - only the postings lists for the query's own terms, not the corpus.

import * as store from './storage.js';
import { normalize, quantize, toFloat32, scanPacked, topK, DIM } from './vec.js';
import { contentTokens, ANALYZER_VERSION } from './text.js';

// 512 ordinals per shard keeps a single incremental write under 1MB while
// still loading the whole corpus in a handful of binary reads.
const SHARD_SIZE = 512;

// Bumped whenever the on-disk vector encoding changes. Version 1 was a single
// fixed scale of 127 for every vector; version 2 stores a per-vector scale
// alongside the row. Shards that don't match are discarded rather than
// misread — see the load() comment for why silently misreading is the worse
// outcome.
const SHARD_FORMAT = 2;

// Set while the index is being torn down and rewritten. Its presence at load
// time means a previous rebuild was interrupted and the on-disk index cannot
// be trusted.
const COMPACT_MARKER = 'indexRebuildInProgress';

// Okapi BM25 constants. k1 controls term-frequency saturation, b controls
// length normalisation. These are the standard defaults and they behave well
// on mixed-length corpora, which is exactly what mem has — one-line calendar
// entries next to 60,000-character papers.
const K1 = 1.2;
const B = 0.75;

const state = {
  loaded: false,
  loading: null,
  space: null,
  dim: DIM,
  ids: [],                 // ordinal → memId, or null for a tombstone
  ordinalOf: new Map(),    // memId → ordinal
  matrix: new Int8Array(0),
  // Per-ordinal dequantisation scale. Each vector is quantised against its
  // own largest component, so the scale has to travel with it.
  scales: new Float32Array(0),
  capacity: 0,
  hasVec: new Uint8Array(0),
  docLen: new Uint32Array(0),
  // Creation time per ordinal. Kept in the index so "what did I read
  // yesterday" can restrict the candidate set before scoring anything,
  // without reading a single memory record.
  createdAt: new Float64Array(0),
  liveCount: 0,
  totalLen: 0,
  dirtyShards: new Set(),
  // term → { df, docs: number[], tfs: number[] } accumulated since last flush
  pendingPostings: new Map(),
  pendingReembed: new Set(),
  metaDirty: false,
};

// ---------- capacity ----------

function grow(minCapacity) {
  if (state.capacity >= minCapacity) return;
  let cap = Math.max(SHARD_SIZE, state.capacity || SHARD_SIZE);
  while (cap < minCapacity) cap *= 2;
  const matrix = new Int8Array(cap * state.dim);
  matrix.set(state.matrix.subarray(0, state.capacity * state.dim));
  const hasVec = new Uint8Array(cap);
  hasVec.set(state.hasVec.subarray(0, state.capacity));
  const docLen = new Uint32Array(cap);
  docLen.set(state.docLen.subarray(0, state.capacity));
  const createdAt = new Float64Array(cap);
  createdAt.set(state.createdAt.subarray(0, state.capacity));
  const scales = new Float32Array(cap);
  scales.set(state.scales.subarray(0, state.capacity));
  state.matrix = matrix;
  state.scales = scales;
  state.hasVec = hasVec;
  state.docLen = docLen;
  state.createdAt = createdAt;
  state.capacity = cap;
}

// ---------- load ----------

/**
 * Read-only mode.
 *
 * The index keeps its ordinal table in module-level state and persists it
 * wholesale, so two JavaScript contexts that both import this module each hold
 * their own copy and the last one to flush wins. In an extension that is not
 * hypothetical: the dashboard page and the service worker are separate
 * contexts, and auto-capture appends ordinals in the worker while the
 * dashboard sits open. A single delete from a dashboard loaded an hour
 * earlier would write its stale, shorter table over the worker's, stranding
 * every memory captured in between — still present in `memories`, but with no
 * ordinal, so invisible to search forever and skipped by ingest's dedupe.
 *
 * The fix is ownership rather than locking: the worker is the only writer.
 * Pages set this flag, and any write becomes a loud error instead of silent
 * corruption. Reads are unaffected.
 */
let readOnly = false;

export function setReadOnly(value) { readOnly = !!value; }
export function isReadOnly() { return readOnly; }

function assertWritable(what) {
  if (!readOnly) return;
  throw new Error(
    `[mem] index is read-only in this context (${what}). Route the write through the service worker.`
  );
}

export async function load() {
  if (state.loaded) return state;
  if (state.loading) return state.loading;
  state.loading = (async () => {
    // A marker left behind means a previous rebuild was killed partway — most
    // likely by Chrome reclaiming the service worker. The on-disk vectors and
    // postings are then a mix of old and new ordinals, which is worse than
    // having none. `memories` and `chunks` were never touched, so recovery is
    // a full local reindex costing no quota.
    const interrupted = await store.metaGet(COMPACT_MARKER, null);
    if (interrupted && readOnly) {
      // A read-only context must not attempt repair: it would clear the
      // stores and then fail on the first write, destroying the only state
      // the worker could still recover from. Load what's there and let the
      // worker heal it.
      console.warn('[mem] index needs repair, but this context is read-only — leaving it for the service worker.');
    } else if (interrupted) {
      const attempt = (interrupted.attempt || 0) + 1;
      if (attempt > MAX_RECOVERY_ATTEMPTS) {
        console.error(`[mem] index recovery failed ${MAX_RECOVERY_ATTEMPTS} times — giving up to avoid a boot loop. Re-index from Settings.`);
        await store.metaSet(COMPACT_MARKER, null);
      } else {
        console.warn('[mem] index rebuild was interrupted — reconstructing from stored memories.');
        // state.loading is deliberately left set: concurrent callers must
        // await this same promise. rebuildIndexFromStores sets state.loaded
        // before its first addDoc, and load() checks `loaded` before
        // `loading`, so the nested addDoc calls return synchronously instead
        // of awaiting the promise that is calling them.
        try {
          await rebuildIndexFromStores({ attempt });
          return state;
        } catch (e) {
          // The marker stays, carrying the incremented attempt count, so the
          // next load retries — bounded by MAX_RECOVERY_ATTEMPTS above.
          // Clearing it here would discard the only signal that the index is
          // still broken, at exactly the moment it is.
          // rebuildIndexFromStores sets state.loaded early so its own nested
          // addDoc calls don't deadlock on this promise. If it then throws,
          // that flag would leave the next load() returning a half-built table
          // with no error — and a later flush() would persist the truncation.
          state.loaded = false;
          console.error(`[mem] index recovery attempt ${attempt} failed:`, e);
          throw e;
        }
      }
    }

    const meta = await store.metaGet('index', null);

    // The analyzer that produced the stored postings has to be the one
    // answering queries against them. When it isn't, terms silently stop
    // matching documents that contain them, which reads as poor relevance
    // rather than as a bug. Rebuilding is entirely local and costs no quota,
    // so it just happens — but only in the writable context, and only when
    // there is actually something indexed.
    if (meta?.ids?.length && (meta.analyzer || 1) !== ANALYZER_VERSION) {
      if (readOnly) {
        console.warn('[mem] index was built by an older analyzer; the service worker will rebuild it.');
      } else {
        console.warn(`[mem] analyzer changed (v${meta.analyzer || 1} → v${ANALYZER_VERSION}) — reindexing locally.`);
        try {
          await rebuildIndexFromStores();
          return state;
        } catch (e) {
          // rebuildIndexFromStores clears shards and postings before it starts
          // and sets state.loaded early so its nested addDoc calls don't
          // deadlock. If it throws, "continue with the old index" would mean
          // continuing with an emptied one, and a later flush() would persist
          // that truncation. Clearing the flag makes the next load() retry.
          state.loaded = false;
          console.error('[mem] analyzer reindex failed; the index needs rebuilding:', e);
          throw e;
        }
      }
    }

    const ids = meta?.ids || [];
    state.space = meta?.space || null;
    state.dim = meta?.dim || DIM;
    state.ids = ids;
    state.ordinalOf = new Map();
    for (let i = 0; i < ids.length; i++) if (ids[i]) state.ordinalOf.set(ids[i], i);
    state.pendingReembed = new Set(meta?.pendingReembed || []);

    grow(Math.max(ids.length, SHARD_SIZE));

    // Shards carry their own dequantisation scales and a format stamp.
    //
    // Both matter. The scales used to live in the meta record, written in a
    // separate IndexedDB transaction from the shard itself — so a service
    // worker dying between the two writes left a new quantised row paired
    // with an old scale, producing silently wrong similarities forever.
    // Keeping them in one record makes them atomic by construction.
    //
    // The format stamp catches the other half: a shard written by an older
    // build used a single fixed scale of 127, and its int8 values are
    // meaningless under per-vector scaling. Without the stamp those rows load
    // with scale 0, score 0, and — because topK fills its buffer regardless —
    // hand the sixty oldest memories to the fusion stage at full weight as
    // "semantic" matches. That is worse than having no vectors at all, so
    // anything unrecognised is dropped and queued for re-embedding instead.
    const shards = await store.shardAll();
    let stale = 0;
    for (const sh of shards) {
      if (!sh?.data || sh.dim !== state.dim) { stale++; continue; }
      if (sh.format !== SHARD_FORMAT || !sh.scales) { stale++; continue; }
      const base = sh.shard * SHARD_SIZE;
      if (base >= state.capacity) continue;
      const room = Math.min(sh.data.length, (state.capacity - base) * state.dim);
      state.matrix.set(sh.data.subarray(0, room), base * state.dim);
      const scaleRoom = Math.min(sh.scales.length, state.capacity - base);
      state.scales.set(sh.scales.subarray(0, scaleRoom), base);
    }
    if (stale > 0) {
      console.warn(`[mem] ${stale} vector shard(s) in an old format — dropping and re-embedding.`);
    }

    const flags = meta?.hasVec;
    if (flags) state.hasVec.set(flags.subarray(0, Math.min(flags.length, state.capacity)));
    const lens = meta?.docLen;
    if (lens) state.docLen.set(lens.subarray(0, Math.min(lens.length, state.capacity)));
    const times = meta?.createdAt;
    if (times) state.createdAt.set(times.subarray(0, Math.min(times.length, state.capacity)));

    state.liveCount = 0;
    state.totalLen = 0;
    for (let i = 0; i < state.ids.length; i++) {
      if (!state.ids[i]) continue;
      state.liveCount++;
      state.totalLen += state.docLen[i];
      // A row flagged as having a vector but carrying no scale cannot be
      // scored. Fail closed: clear the flag so the semantic pass reports
      // honestly, and queue the document for re-embedding.
      if (state.hasVec[i] === 1 && !(state.scales[i] > 0)) {
        state.hasVec[i] = 0;
        state.pendingReembed.add(state.ids[i]);
        state.metaDirty = true;
      }
    }

    state.loaded = true;
    state.loading = null;
    return state;
  })().catch((e) => {
    // Without this, a single transient IndexedDB error leaves the rejected
    // promise cached and every later load() in this context returns it —
    // search stays broken until the page is reloaded.
    state.loading = null;
    throw e;
  });
  return state.loading;
}

/** Test-only: drop in-memory state so the next load() re-reads IndexedDB. */
export function _reset() {
  state.loaded = false;
  state.loading = null;
  state.space = null;
  state.ids = [];
  state.ordinalOf = new Map();
  state.matrix = new Int8Array(0);
  state.scales = new Float32Array(0);
  state.capacity = 0;
  state.hasVec = new Uint8Array(0);
  state.docLen = new Uint32Array(0);
  state.createdAt = new Float64Array(0);
  state.liveCount = 0;
  state.totalLen = 0;
  state.dirtyShards = new Set();
  state.pendingPostings = new Map();
  state.pendingReembed = new Set();
  state.metaDirty = false;
}

export async function stats() {
  await load();
  return {
    docs: state.liveCount,
    ordinals: state.ids.length,
    withVectors: countVectors(),
    space: state.space,
    dim: state.dim,
    avgDocLength: state.liveCount ? state.totalLen / state.liveCount : 0,
    pendingReembed: state.pendingReembed.size,
    memoryBytes: state.capacity * state.dim,
  };
}

function countVectors() {
  let n = 0;
  for (let i = 0; i < state.ids.length; i++) if (state.ids[i] && state.hasVec[i]) n++;
  return n;
}

// ---------- ordinals ----------

/**
 * Allocate an ordinal for a document.
 *
 * Ordinals are never reused, and re-indexing a document moves it to a fresh
 * one. Both rules exist for the same reason: postings are append-merged per
 * term and nothing ever deletes an ordinal from a term it no longer contains.
 *
 * Reusing a tombstoned ordinal therefore transplanted the deleted document's
 * entire vocabulary onto whatever was saved next — delete a page about
 * Kubernetes, save a page about cooking, and searching "kubernetes" returned
 * the cooking page with a confident BM25 score, which the model then cited as
 * evidence. Re-indexing in place had the milder version of the same bug: a
 * page kept matching the words it used to contain, which matters here because
 * deepening rewrites title-only memories constantly.
 *
 * Tombstones are filtered at query time (`state.ids[ord]` is null), so a
 * stale posting is inert. Growth is bounded by compact().
 */
function ordinalFor(id) {
  // Re-indexing always retires the old ordinal. There is no caller that wants
  // an in-place update: keeping the ordinal is precisely what let a document
  // go on matching words it no longer contains.
  const existing = state.ordinalOf.get(id);
  if (existing !== undefined) retireOrdinal(existing);
  const ord = state.ids.length;
  state.ids.push(id);
  grow(state.ids.length);
  state.ordinalOf.set(id, ord);
  state.liveCount++;
  state.metaDirty = true;
  return ord;
}

/** Blank an ordinal in place. Postings pointing at it become inert. */
function retireOrdinal(ord) {
  if (ord === undefined || !state.ids[ord]) return;
  state.ids[ord] = null;
  state.hasVec[ord] = 0;
  state.scales[ord] = 0;
  state.totalLen -= state.docLen[ord] || 0;
  state.docLen[ord] = 0;
  state.createdAt[ord] = 0;
  state.matrix.fill(0, ord * state.dim, (ord + 1) * state.dim);
  state.dirtyShards.add(Math.floor(ord / SHARD_SIZE));
  state.liveCount = Math.max(0, state.liveCount - 1);
  state.metaDirty = true;
}

/** Fraction of the ordinal table that is tombstoned. */
export async function tombstoneRatio() {
  await load();
  if (state.ids.length === 0) return 0;
  return 1 - state.liveCount / state.ids.length;
}

/**
 * Rebuild the ordinal space with no gaps, dropping every stale posting.
 *
 * Since ordinals are never reused, heavy churn (deleting, and especially
 * deepening, which re-indexes) grows the table. This is the release valve —
 * it runs from the background pass rather than inline, because it rewrites
 * every posting.
 */
export async function compact({ onProgress } = {}) {
  // Never let two compactions overlap: each clears the stores the other is
  // rebuilding. Callers get the in-flight run rather than starting a second.
  if (compacting) return compacting;
  compacting = (async () => {
    try {
      return await compactInner({ onProgress });
    } finally {
      compacting = null;
    }
  })();
  return compacting;
}

async function compactInner({ onProgress } = {}) {
  assertWritable('compact');
  await load();
  const live = state.ids.filter(Boolean);
  if (live.length === 0 || state.liveCount === state.ids.length) {
    return { compacted: false, ordinals: state.ids.length };
  }

  const before = state.ids.length;
  const carriedReembed = [...state.pendingReembed];

  // Compaction renumbers ordinals, which invalidates every posting at once —
  // so it genuinely has to clear and rewrite rather than overwrite in place.
  // That makes the window between the clear and the rewrite the most
  // dangerous moment in the whole extension: this runs on an alarm inside an
  // MV3 service worker, which Chrome will terminate after 30s idle, and
  // neither IndexedDB work nor setTimeout resets that timer.
  //
  // The saving grace is that compaction reads only from `memories` and
  // `chunks`, and writes only to `vectors` and `postings`. The source of
  // truth is never touched, so the index is always fully reconstructible with
  // no network and no API calls. A marker written before the destructive step
  // turns a fatal interruption into a rebuild on next load.
  await store.metaSet(COMPACT_MARKER, { startedAt: Date.now(), before });

  try {
    const keepSpace = state.space;
    _reset();
    state.loaded = true;
    state.space = keepSpace;
    await store.shardClear();
    await store.postingsClear();
    await reindexFromStores(live, keepSpace, { onProgress, stage: 'compact' });
    // Anything that was awaiting a re-embed still is — the chunk store can
    // only heal documents that actually have a vector in the active space.
    for (const id of carriedReembed) {
      if (state.ordinalOf.has(id) && !state.hasVec[state.ordinalOf.get(id)]) {
        state.pendingReembed.add(id);
      }
    }
    state.metaDirty = true;
    await flush();
    // Success only. Clearing this in a `finally` — which is what this site
    // used to do, and what was already fixed in rebuildIndexFromStores —
    // discards the recovery signal at precisely the moment it is needed, e.g.
    // a QuotaExceededError out of flush() after the stores have been cleared.
    await store.metaSet(COMPACT_MARKER, null);
  } catch (e) {
    console.error('[mem] compaction failed; marker left in place so the next load repairs the index:', e);
    throw e;
  }

  return { compacted: true, before, after: state.ids.length };
}

/**
 * Rebuild ordinals, vectors and postings for a set of ids, reading only from
 * the memory and chunk stores.
 *
 * Costs nothing but local IO: the exact Float32 document vector already lives
 * in the chunk record, so nothing is re-embedded.
 */
async function reindexFromStores(ids, space, { onProgress, stage = 'rebuild' } = {}) {
  grow(Math.max(ids.length, SHARD_SIZE));
  const BATCH = 200;
  let done = 0;

  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const [records, chunkRecs] = await Promise.all([
      store.getMany(slice),
      store.getChunksMany(slice),
    ]);
    for (let j = 0; j < slice.length; j++) {
      const full = records[j];
      if (!full) continue;
      const rec = chunkRecs.get(slice[j]) || null;
      await addDoc({
        id: full.id,
        vec: rec?.docVec || null,
        space: rec?.space || space,
        createdAt: full.createdAt,
        chunks: null,           // already stored; don't rewrite them
        tokensText: [
          full.title, full.summary, (full.tags || []).join(' '),
          (full.keyFacts || []).join(' '), full.text,
        ].filter(Boolean).join('\n'),
      }, { writeChunks: false });
      done++;
    }
    await flush();
    onProgress?.({ stage, done, total: ids.length });
  }
  return done;
}

/**
 * Rebuild the entire index from the memory and chunk stores.
 *
 * This is both the recovery path for an interrupted compaction and the
 * "rebuild index" action in settings. It is always safe to run and never
 * spends quota.
 */
export async function rebuildIndexFromStores({ onProgress, attempt = 0 } = {}) {
  // This function destroys the on-disk index before rebuilding it, so it is
  // a writer — and a page that has declared itself read-only must never reach
  // here. store.shardClear() is not gated by the read-only flag, so without
  // this the dashboard could wipe the shards and only then hit assertWritable
  // on the first addDoc, turning a recoverable state into an unrecoverable
  // one just by being open.
  assertWritable('rebuildIndexFromStores');

  const meta = await store.metaGet('index', null);
  const space = meta?.space || null;
  const dim = meta?.dim || DIM;
  // The re-embed queue is not reconstructible from the stores — a document
  // waiting on a vector looks identical to one that never had one — so it has
  // to be carried across explicitly.
  const carriedReembed = meta?.pendingReembed || [];

  const all = await store.allLite();
  const ids = all.map((m) => m.id);

  _reset();
  state.loaded = true;
  state.space = space;
  state.dim = dim;

  // The marker goes down BEFORE anything destructive. Writing it afterwards —
  // which is what this function originally did — reproduced the exact bug it
  // exists to fix: a kill inside either clear left the index gone with no
  // signal that it needed rebuilding.
  await store.metaSet(COMPACT_MARKER, { startedAt: Date.now(), rebuilding: true, attempt });
  await store.shardClear();
  await store.postingsClear();

  await reindexFromStores(ids, space, { onProgress, stage: 'rebuild' });
  for (const id of carriedReembed) {
    const ord = state.ordinalOf.get(id);
    if (ord !== undefined && !state.hasVec[ord]) state.pendingReembed.add(id);
  }
  state.metaDirty = true;
  await flush();

  // Cleared only on success. Clearing in a `finally` discarded the one signal
  // that recovery was still needed at precisely the moment it was needed —
  // a QuotaExceededError out of flush() would have left a half-built table
  // with nothing scheduled to repair it.
  await store.metaSet(COMPACT_MARKER, null);
  return { rebuilt: state.liveCount };
}

// A rebuild that keeps dying partway would otherwise retry on every single
// load. Past this many attempts the marker is cleared and the index is left
// lexically empty but consistent — recoverable by hand, rather than a boot loop.
const MAX_RECOVERY_ATTEMPTS = 3;

// Serialises compaction against itself. Two overlapping runs would each clear
// the stores the other was mid-way through rebuilding. The 30-minute alarm is
// not the only trigger — Settings has a "run now" button, and both funnel
// into runDeepenPass.
let compacting = null;

// ---------- writes ----------

/**
 * Add or replace a document.
 *
 * doc: {
 *   id, vec (Float32Array|number[]|null), space, tokensText,
 *   chunks: [{ text, start, vec }]
 * }
 *
 * The vector goes into the packed matrix; the chunks and the exact Float32
 * vectors go to the chunk store for tier-2 rescoring.
 */
export async function addDoc(doc, { writeChunks = true } = {}) {
  assertWritable('addDoc');
  await load();
  // A re-index moves to a fresh ordinal so the document stops matching words
  // it no longer contains. Deepening rewrites title-only memories into full
  // ones constantly, so this path is hot, not exotic.
  const ord = ordinalFor(doc.id);

  // First vector written decides the index's embedding space. A document
  // embedded in a different space is queued for re-embedding rather than
  // compared across spaces — cosine between two different models' vectors is
  // meaningless, and silently blending them is worse than omitting them.
  if (doc.vec && doc.space) {
    if (!state.space) { state.space = doc.space; state.metaDirty = true; }
    if (doc.space !== state.space) {
      // Delete before add so the id moves to the back of the queue. A Set's
      // insertion order is unchanged by re-adding an existing member, and
      // pendingReembedIds() reads from the front — so without this, a document
      // that cannot be satisfied re-selects itself on every pass forever. That
      // is a busy-loop of *paid* embedding calls once anything drains the
      // queue, which is exactly what the background pass now does.
      state.pendingReembed.delete(doc.id);
      state.pendingReembed.add(doc.id);
      state.hasVec[ord] = 0;
      state.metaDirty = true;
    } else {
      state.pendingReembed.delete(doc.id);
      const v = normalize(toFloat32(doc.vec));
      if (v.length === state.dim) {
        const { q, scale } = quantize(v);
        state.matrix.set(q, ord * state.dim);
        state.scales[ord] = scale;
        // An all-zero vector quantises to scale 0, which scanPacked skips —
        // but topK fills its buffer regardless of score, so a row flagged as
        // having a vector would enter the semantic list at 0.0, ahead of every
        // genuinely-scored negative match, and RRF ranks by position alone.
        // Only claim a vector when it can actually be scored.
        state.hasVec[ord] = scale > 0 ? 1 : 0;
        if (scale <= 0) state.pendingReembed.add(doc.id);
        state.dirtyShards.add(Math.floor(ord / SHARD_SIZE));
      }
    }
  } else if (doc.vec && !doc.space) {
    // Migration path: v1 vectors carry no space tag. Adopt them into whatever
    // space the index is in; if the guess is wrong, results degrade to BM25
    // for those documents rather than producing nonsense similarities.
    const v = normalize(toFloat32(doc.vec));
    if (v.length === state.dim) {
      const { q, scale } = quantize(v);
      state.matrix.set(q, ord * state.dim);
      state.scales[ord] = scale;
      // Same guard as the tagged-space branch: a zero-scale row is unscoreable
      // by scanPacked but would still be admitted by topK, entering the
      // semantic list at 0.0 ahead of every genuinely negative match.
      state.hasVec[ord] = scale > 0 ? 1 : 0;
      if (scale <= 0) state.pendingReembed.add(doc.id);
      state.dirtyShards.add(Math.floor(ord / SHARD_SIZE));
    }
  } else {
    state.hasVec[ord] = 0;
    state.scales[ord] = 0;
  }

  state.createdAt[ord] = doc.createdAt || Date.now();

  // BM25 side.
  const tokens = contentTokens(doc.tokensText || '');
  const prevLen = state.docLen[ord] || 0;
  state.totalLen += tokens.length - prevLen;
  state.docLen[ord] = tokens.length;

  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  for (const [term, n] of tf) {
    let p = state.pendingPostings.get(term);
    if (!p) { p = { docs: [], tfs: [] }; state.pendingPostings.set(term, p); }
    p.docs.push(ord);
    p.tfs.push(Math.min(n, 65535));
  }

  if (writeChunks && doc.chunks) {
    await store.putChunks(doc.id, {
      space: doc.space || state.space,
      docVec: doc.vec ? normalize(toFloat32(doc.vec)) : null,
      chunks: doc.chunks.map((c) => ({
        text: c.text,
        start: c.start || 0,
        vec: c.vec ? normalize(toFloat32(c.vec)) : new Float32Array(state.dim),
      })),
    });
  }

  state.metaDirty = true;
  return ord;
}

/** Tombstone a document. Postings keep the ordinal; queries filter it out. */
export async function removeDoc(id) {
  assertWritable('removeDoc');
  await load();
  const ord = state.ordinalOf.get(id);
  if (ord === undefined) return false;
  retireOrdinal(ord);
  state.ordinalOf.delete(id);
  state.pendingReembed.delete(id);
  await flush();
  return true;
}

/** Persist dirty shards, merged postings, and the ordinal table. */
export async function flush() {
  if (!state.loaded) return;
  // Silent no-op rather than a throw: read-only contexts have nothing pending
  // to write, and callers flush defensively after read paths.
  if (readOnly) return;

  if (state.dirtyShards.size > 0) {
    const shards = [];
    for (const shard of state.dirtyShards) {
      const base = shard * SHARD_SIZE * state.dim;
      const end = Math.min(base + SHARD_SIZE * state.dim, state.matrix.length);
      if (base >= end) continue;
      const ordBase = shard * SHARD_SIZE;
      shards.push({
        shard,
        format: SHARD_FORMAT,
        space: state.space,
        dim: state.dim,
        count: SHARD_SIZE,
        // Copies, not subarray views — a view would serialise the entire
        // backing buffer. Scales travel inside the record so they can never
        // be a transaction behind the rows they belong to.
        data: state.matrix.slice(base, end),
        scales: state.scales.slice(ordBase, Math.min(ordBase + SHARD_SIZE, state.capacity)),
      });
    }
    if (shards.length) await store.shardPutMany(shards);
    state.dirtyShards.clear();
  }

  if (state.pendingPostings.size > 0) {
    const terms = [...state.pendingPostings.keys()];
    const existing = await store.postingsGetMany(terms);
    const records = [];
    for (const [term, add] of state.pendingPostings) {
      const prev = existing.get(term);
      const byDoc = new Map();
      if (prev) {
        for (let i = 0; i < prev.docs.length; i++) byDoc.set(prev.docs[i], prev.tfs[i]);
      }
      // Replace rather than accumulate: re-indexing a document must not
      // double-count its terms.
      for (let i = 0; i < add.docs.length; i++) byDoc.set(add.docs[i], add.tfs[i]);
      const docs = new Uint32Array(byDoc.size);
      const tfs = new Uint16Array(byDoc.size);
      let i = 0;
      for (const [d, f] of byDoc) { docs[i] = d; tfs[i] = f; i++; }
      records.push({ term, df: byDoc.size, docs, tfs });
    }
    await store.postingsPutMany(records);
    state.pendingPostings.clear();
  }

  if (state.metaDirty) {
    await store.metaSet('index', {
      ids: state.ids,
      space: state.space,
      dim: state.dim,
      hasVec: state.hasVec.slice(0, state.ids.length),
      docLen: state.docLen.slice(0, state.ids.length),
      createdAt: state.createdAt.slice(0, state.ids.length),
      analyzer: ANALYZER_VERSION,
      // scales deliberately absent: they live in the shard records so they
      // stay atomic with the rows they describe.
      pendingReembed: [...state.pendingReembed],
      updatedAt: Date.now(),
    });
    state.metaDirty = false;
  }
}

/**
 * Rebuild the whole index from scratch. Used by migration, by "re-index" in
 * settings, and whenever the active embedding space changes.
 */
export async function rebuildFrom(docs, { onProgress } = {}) {
  _reset();
  await store.shardClear();
  await store.postingsClear();
  await store.metaSet('index', null);
  state.loaded = true;
  state.dim = DIM;
  state.ids = [];
  state.ordinalOf = new Map();
  grow(Math.max(docs.length, SHARD_SIZE));

  let done = 0;
  for (const d of docs) {
    await addDoc(d, { writeChunks: !!(d.chunks && d.chunks.length) });
    done++;
    if (done % 250 === 0) {
      await flush();
      onProgress?.({ stage: 'index', done, total: docs.length });
    }
  }
  await flush();
  onProgress?.({ stage: 'index', done, total: docs.length });
  return { indexed: done };
}

/**
 * Switch the active embedding space. Documents whose stored chunk vectors
 * already live in the new space are restored from the chunk store for free;
 * the rest are queued for background re-embedding.
 */
export async function setSpace(space, { onProgress } = {}) {
  await load();
  if (state.space === space) return { changed: false };

  state.space = space;
  state.pendingReembed = new Set();
  state.hasVec.fill(0);
  state.matrix.fill(0);
  state.scales.fill(0);

  const ids = state.ids.filter(Boolean);
  const chunkRecs = await store.getChunksMany(ids);
  let restored = 0;
  for (const id of ids) {
    const rec = chunkRecs.get(id);
    const ord = state.ordinalOf.get(id);
    if (ord === undefined) continue;
    if (rec && rec.space === space && rec.docVec && rec.docVec.length === state.dim) {
      const { q, scale } = quantize(normalize(rec.docVec));
      state.matrix.set(q, ord * state.dim);
      state.scales[ord] = scale;
      // A stored vector that quantises to a zero scale is unusable; queue it
      // rather than restoring a row that can never be scored.
      state.hasVec[ord] = scale > 0 ? 1 : 0;
      if (scale > 0) restored++;
      else state.pendingReembed.add(id);
    } else {
      state.pendingReembed.add(id);
    }
    state.dirtyShards.add(Math.floor(ord / SHARD_SIZE));
  }
  state.metaDirty = true;
  await flush();
  onProgress?.({ stage: 'space', restored, pending: state.pendingReembed.size });
  return { changed: true, restored, pending: state.pendingReembed.size };
}

export async function pendingReembedIds(limit = 100) {
  await load();
  return [...state.pendingReembed].slice(0, limit);
}

/**
 * Remove ids from the re-embed queue without re-indexing them.
 *
 * The queue is read from the front, so ids that can never be satisfied —
 * pointing at deleted memories, typically — sit at the head and starve
 * everything behind them.
 */
export async function dropFromReembedQueue(ids) {
  assertWritable('dropFromReembedQueue');
  await load();
  let dropped = 0;
  for (const id of ids) if (state.pendingReembed.delete(id)) dropped++;
  if (dropped) { state.metaDirty = true; await flush(); }
  return dropped;
}

// ---------- queries ----------

function allowFn(filterIds) {
  if (!filterIds) return (ord) => !!state.ids[ord];
  const set = filterIds instanceof Set ? filterIds : new Set(filterIds);
  return (ord) => {
    const id = state.ids[ord];
    return !!id && set.has(id);
  };
}

/**
 * Semantic candidates. One pass over the packed int8 matrix.
 * Returns [{ id, score }] with score in roughly [-1, 1].
 */
export async function searchVectors(queryVec, { k = 60, filterIds = null } = {}) {
  await load();
  if (!queryVec || state.ids.length === 0) return [];
  const q = normalize(toFloat32(queryVec));
  if (q.length !== state.dim) return [];
  const { q: qq, scale: qScale } = quantize(q);
  const scores = scanPacked(qq, qScale, state.matrix, state.scales, state.dim, state.ids.length);
  const base = allowFn(filterIds);
  const hits = topK(scores, k, (ord) => base(ord) && state.hasVec[ord] === 1);
  return hits.map((h) => ({ id: state.ids[h.i], ordinal: h.i, score: h.score }));
}

/**
 * BM25 candidates. Reads only the postings lists for the query's own terms,
 * so cost scales with the query, not the corpus.
 */
export async function searchLexical(query, { k = 60, filterIds = null } = {}) {
  await load();
  const terms = [...new Set(contentTokens(query))];
  if (terms.length === 0 || state.liveCount === 0) return [];

  const postings = await store.postingsGetMany(terms);
  if (postings.size === 0) return [];

  const avgdl = state.liveCount ? state.totalLen / state.liveCount : 1;
  const scores = new Float32Array(state.ids.length);
  const N = state.liveCount;

  for (const [, p] of postings) {
    // Only live documents count toward df, otherwise deleting documents
    // inflates the idf of every term they contained.
    let liveDf = 0;
    for (let i = 0; i < p.docs.length; i++) if (state.ids[p.docs[i]]) liveDf++;
    if (liveDf === 0) continue;
    const idf = Math.log(1 + (N - liveDf + 0.5) / (liveDf + 0.5));
    for (let i = 0; i < p.docs.length; i++) {
      const ord = p.docs[i];
      if (ord >= scores.length || !state.ids[ord]) continue;
      const tf = p.tfs[i];
      const dl = state.docLen[ord] || 1;
      const denom = tf + K1 * (1 - B + B * (dl / (avgdl || 1)));
      scores[ord] += idf * ((tf * (K1 + 1)) / (denom || 1));
    }
  }

  const base = allowFn(filterIds);
  const hits = topK(scores, k, (ord) => base(ord) && scores[ord] > 0);
  return hits.filter((h) => h.score > 0).map((h) => ({ id: state.ids[h.i], ordinal: h.i, score: h.score }));
}

/** Whether a semantic pass is possible at all right now. */
export async function hasVectors() {
  await load();
  return countVectors() > 0;
}

export async function knownIds() {
  await load();
  return state.ids.filter(Boolean);
}

/**
 * Ids created inside [fromMs, toMs). Answers the prefilter for time-anchored
 * questions straight from the index — no memory records are read.
 */
export async function idsBetween(fromMs, toMs) {
  await load();
  const out = [];
  for (let ord = 0; ord < state.ids.length; ord++) {
    const id = state.ids[ord];
    if (!id) continue;
    const t = state.createdAt[ord];
    if (t >= fromMs && t < toMs) out.push(id);
  }
  return out;
}

/**
 * Re-index memories that exist in the store but have no ordinal.
 *
 * This is the safety net for every crash-mid-loop case. A first-run scan
 * writes thousands of records and then indexes them in a loop; MV3 will kill
 * the worker partway through a job that size, and ingest's dedupe skips
 * anything already in `memories`, so a re-run never repairs it. Without this
 * the affected memories exist but are permanently unsearchable, silently.
 *
 * Costs nothing to run: exact vectors already live in the chunk store, so
 * orphans are re-indexed with no API calls and no quota.
 */
export async function reconcile({ onProgress, limit = 20000 } = {}) {
  assertWritable('reconcile');
  await load();

  const storedIds = await store.allMemoryKeys();
  const orphans = [];
  for (const id of storedIds) {
    if (!state.ordinalOf.has(id)) orphans.push(id);
    if (orphans.length >= limit) break;
  }

  // The mirror image: an ordinal pointing at a record that no longer exists,
  // which would let a deleted memory keep scoring in BM25.
  const storedSet = new Set(storedIds);
  let stale = 0;
  for (let ord = 0; ord < state.ids.length; ord++) {
    const id = state.ids[ord];
    if (id && !storedSet.has(id)) {
      retireOrdinal(ord);
      state.ordinalOf.delete(id);
      // Also drop it from the re-embed queue. The queue is read from the
      // front, so ids for memories that no longer exist would sit at the head
      // and starve everything behind them.
      state.pendingReembed.delete(id);
      stale++;
    }
  }

  if (orphans.length === 0 && stale === 0) return { orphans: 0, stale: 0 };

  onProgress?.({ stage: 'reconcile', total: orphans.length, done: 0 });
  const BATCH = 200;
  let done = 0;
  for (let i = 0; i < orphans.length; i += BATCH) {
    const slice = orphans.slice(i, i + BATCH);
    const [records, chunkRecs] = await Promise.all([
      store.getMany(slice),
      store.getChunksMany(slice),
    ]);
    for (let j = 0; j < slice.length; j++) {
      const m = records[j];
      if (!m) continue;
      const rec = chunkRecs.get(slice[j]);
      await addDoc({
        id: m.id,
        vec: rec?.docVec || null,
        space: rec?.space || state.space,
        createdAt: m.createdAt,
        chunks: null,
        tokensText: [
          m.title, m.summary, (m.tags || []).join(' '),
          (m.keyFacts || []).join(' '), m.text,
        ].filter(Boolean).join('\n'),
      }, { writeChunks: false });
      done++;
    }
    await flush();
    onProgress?.({ stage: 'reconcile', total: orphans.length, done });
  }

  await flush();
  return { orphans: done, stale };
}

/** Ids ordered newest first, straight from the index. */
export async function recentIds(limit = 50) {
  await load();
  const rows = [];
  for (let ord = 0; ord < state.ids.length; ord++) {
    if (state.ids[ord]) rows.push({ id: state.ids[ord], t: state.createdAt[ord] });
  }
  rows.sort((a, b) => b.t - a.t);
  return rows.slice(0, limit).map((r) => r.id);
}

/** Creation time for a set of ids, without reading their records. */
export async function timesOf(ids) {
  await load();
  const out = new Map();
  for (const id of ids) {
    const ord = state.ordinalOf.get(id);
    if (ord !== undefined) out.set(id, state.createdAt[ord]);
  }
  return out;
}
