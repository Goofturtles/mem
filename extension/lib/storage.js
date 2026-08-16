// IndexedDB layer for mem. Local-first: everything lives in the user's
// browser, no backend.
//
// Schema v2 splits what used to be one fat record into stores with different
// access patterns:
//
//   memories  the displayable record. No longer carries its embedding — a
//             1536-element plain JS array cost ~12KB per memory and every
//             one of them was loaded on the dashboard's live-search path.
//   vectors   int8-quantised document vectors packed into contiguous shards.
//             One binary read gives the whole corpus; see vec.js for why.
//   chunks    per-document passage text and exact Float32 vectors. Only ever
//             read for the handful of documents that survive tier-1 ranking.
//   postings  BM25 inverted index. A query touches only its own terms, not
//             the corpus.
//   meta      index bookkeeping: ordinal table, document lengths, versions.
//   episodes  reconstructed activity sessions (see episodes.js).
//   entities  the people/orgs/concepts graph (see entities.js).
//
// v1 databases migrate in place, locally, with no API calls: existing
// embeddings are lifted out of the memory records and rebuilt into the index.

import { toFloat32, normalize, quantize, DIM } from './vec.js';

const DB_NAME = 'mem';
export const DB_VERSION = 2;

export const STORE = {
  memories: 'memories',
  vectors: 'vectors',
  chunks: 'chunks',
  postings: 'postings',
  meta: 'meta',
  episodes: 'episodes',
  entities: 'entities',
};

// Vector width lives with the vector code; re-exported here so consumers of
// the storage layer don't need to reach into vec.js for it.
export { DIM };

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const tx = e.target.transaction;

      let memories;
      if (!db.objectStoreNames.contains(STORE.memories)) {
        memories = db.createObjectStore(STORE.memories, { keyPath: 'id' });
        memories.createIndex('url', 'url', { unique: false });
        memories.createIndex('createdAt', 'createdAt', { unique: false });
        memories.createIndex('tags', 'tags', { unique: false, multiEntry: true });
      } else {
        memories = tx.objectStore(STORE.memories);
      }
      // Added in v2 — guarded so a fresh install and an upgrade take the same path.
      if (!memories.indexNames.contains('sourceKind')) {
        memories.createIndex('sourceKind', 'sourceKind', { unique: false });
      }
      if (!memories.indexNames.contains('episodeId')) {
        memories.createIndex('episodeId', 'episodeId', { unique: false });
      }
      if (!memories.indexNames.contains('entityIds')) {
        memories.createIndex('entityIds', 'entityIds', { unique: false, multiEntry: true });
      }

      if (!db.objectStoreNames.contains(STORE.vectors)) {
        db.createObjectStore(STORE.vectors, { keyPath: 'shard' });
      }
      if (!db.objectStoreNames.contains(STORE.chunks)) {
        db.createObjectStore(STORE.chunks, { keyPath: 'memId' });
      }
      if (!db.objectStoreNames.contains(STORE.postings)) {
        db.createObjectStore(STORE.postings, { keyPath: 'term' });
      }
      if (!db.objectStoreNames.contains(STORE.meta)) {
        db.createObjectStore(STORE.meta, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE.episodes)) {
        const ep = db.createObjectStore(STORE.episodes, { keyPath: 'id' });
        ep.createIndex('startedAt', 'startedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE.entities)) {
        const en = db.createObjectStore(STORE.entities, { keyPath: 'id' });
        en.createIndex('kind', 'kind', { unique: false });
        en.createIndex('norm', 'norm', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('mem database is open in another tab running an older version. Close it and reload.'));
  });
  return dbPromise;
}

export function ready() { return openDB(); }

/** Test-only: drop the cached connection so a fresh open re-runs upgrades. */
export function _resetConnection() {
  dbPromise = null;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(storeName, mode).objectStore(storeName);
}

/** Run a batch of writes against one store in a single transaction. */
async function batch(storeName, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readwrite');
    const s = t.objectStore(storeName);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

// ---------- ids ----------

/** Deterministic id from a URL so re-saving updates instead of duplicating. */
export async function urlId(url) {
  const buf = new TextEncoder().encode(url);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- memories ----------

export async function put(memory) {
  const s = await tx(STORE.memories, 'readwrite');
  return reqToPromise(s.put(memory));
}

export async function putMany(memories) {
  if (!memories || memories.length === 0) return 0;
  await batch(STORE.memories, (s) => { for (const m of memories) s.put(m); });
  return memories.length;
}

export async function get(id) {
  const s = await tx(STORE.memories, 'readonly');
  return reqToPromise(s.get(id));
}

export async function getMany(ids) {
  if (!ids || ids.length === 0) return [];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE.memories, 'readonly');
    const s = t.objectStore(STORE.memories);
    const out = new Array(ids.length);
    let remaining = ids.length;
    ids.forEach((id, i) => {
      const r = s.get(id);
      r.onsuccess = () => { out[i] = r.result || null; if (--remaining === 0) resolve(out); };
      r.onerror = () => reject(r.error);
    });
  });
}

export async function getByUrl(url) {
  return get(await urlId(url));
}

/** Map<id, boolean> of which ids already exist. One transaction for all. */
export async function getManyExist(ids) {
  const out = new Map();
  if (!ids || ids.length === 0) return out;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE.memories, 'readonly');
    const s = t.objectStore(STORE.memories);
    let remaining = ids.length;
    for (const id of ids) {
      const r = s.getKey(id);
      r.onsuccess = () => { out.set(id, !!r.result); if (--remaining === 0) resolve(out); };
      r.onerror = () => reject(r.error);
    }
  });
}

export async function remove(id) {
  await batch(STORE.memories, (s) => s.delete(id));
  await batch(STORE.chunks, (s) => s.delete(id));
  // The vector matrix and postings are tombstoned rather than rewritten;
  // index.js drops tombstoned ordinals at query time and compacts on rebuild.
  const { removeDoc } = await import('./index.js');
  await removeDoc(id);
}

export async function all() {
  const s = await tx(STORE.memories, 'readonly');
  return reqToPromise(s.getAll());
}

export async function count() {
  const s = await tx(STORE.memories, 'readonly');
  return reqToPromise(s.count());
}

/** Every memory id, without materialising the records. Used by reconcile(). */
export async function allMemoryKeys() {
  const s = await tx(STORE.memories, 'readonly');
  return reqToPromise(s.getAllKeys());
}

/**
 * Recent memories, newest first. Walks the createdAt index backwards so we
 * read `limit` records instead of the whole store.
 */
export async function recent(limit = 50) {
  const s = await tx(STORE.memories, 'readonly');
  const idx = s.index('createdAt');
  return new Promise((resolve, reject) => {
    const out = [];
    const req = idx.openCursor(null, 'prev');
    req.onsuccess = (e) => {
      const c = e.target.result;
      if (!c || out.length >= limit) return resolve(out);
      out.push(c.value);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Memories created inside [from, to). Uses the createdAt index rather than
 * filtering the full store, which is what the daily summary and episode
 * builder need once the corpus is large.
 */
export async function betweenDates(from, to, { limit = 5000 } = {}) {
  const s = await tx(STORE.memories, 'readonly');
  const idx = s.index('createdAt');
  const range = IDBKeyRange.bound(from, to, false, true);
  return new Promise((resolve, reject) => {
    const out = [];
    const req = idx.openCursor(range, 'prev');
    req.onsuccess = (e) => {
      const c = e.target.result;
      if (!c || out.length >= limit) return resolve(out);
      out.push(c.value);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Lightweight projection for scanning the whole corpus without pulling each
 * record's `text` (up to 60KB) into memory. Used by episode clustering,
 * open-loop detection, and the resurface scorer.
 */
export async function allLite() {
  const s = await tx(STORE.memories, 'readonly');
  return new Promise((resolve, reject) => {
    const out = [];
    const req = s.openCursor();
    req.onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return resolve(out);
      const m = c.value;
      out.push({
        id: m.id, url: m.url, title: m.title, summary: m.summary,
        tags: m.tags || [], keyFacts: m.keyFacts || [], author: m.author,
        siteName: m.siteName, sourceKind: m.sourceKind, sourceLabel: m.sourceLabel,
        contentType: m.contentType, favicon: m.favicon, extra: m.extra,
        createdAt: m.createdAt, updatedAt: m.updatedAt,
        lightweight: !!m.lightweight, episodeId: m.episodeId,
        entityIds: m.entityIds || [], textLength: (m.text || '').length,
      });
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clear() {
  const db = await openDB();
  const names = Object.values(STORE);
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, 'readwrite');
    for (const n of names) t.objectStore(n).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ---------- chunks ----------

/**
 * One record per document holds all of its passages: the exact Float32 doc
 * vector, the packed Float32 chunk matrix, and the chunk texts. Storing them
 * together means tier-2 rescoring costs one IDB read per candidate document
 * rather than one per passage.
 */
export async function putChunks(memId, { space, docVec, chunks }) {
  const dim = docVec ? docVec.length : DIM;
  const data = new Float32Array((chunks?.length || 0) * dim);
  const texts = [];
  const starts = new Int32Array(chunks?.length || 0);
  (chunks || []).forEach((c, i) => {
    if (c.vec) data.set(c.vec, i * dim);
    texts.push(c.text);
    starts[i] = c.start || 0;
  });
  const rec = {
    memId, space, dim,
    count: chunks?.length || 0,
    docVec: docVec ? toFloat32(docVec) : null,
    data, texts, starts,
  };
  await batch(STORE.chunks, (s) => s.put(rec));
  return rec;
}

/**
 * Replace a document's vector and embedding space, keeping its passages.
 *
 * The chunk record is the source of truth for every rebuild path — compaction
 * and recovery both re-index from `rec.docVec` / `rec.space`. So a re-embed
 * that updates only the packed matrix is silently reverted the next time the
 * index is rebuilt, and if the stored space is stale the document is
 * immediately re-queued, which turns the re-embed pass and the compaction pass
 * into a loop that feeds itself.
 *
 * Creates a vector-only record when none exists, so a re-embedded memory that
 * never had passages doesn't lose its vector.
 */
export async function updateChunkVector(memId, { docVec, space }) {
  const existing = await getChunks(memId);
  const vec32 = docVec ? normalize(toFloat32(docVec)) : null;

  let rec;
  if (!existing) {
    rec = { memId, space, dim: vec32 ? vec32.length : DIM, count: 0, docVec: vec32, data: new Float32Array(0), texts: [], starts: new Int32Array(0) };
  } else if (existing.space === space) {
    // Same space: the passage vectors remain comparable, so keep them.
    rec = { ...existing, docVec: vec32, space };
  } else {
    // Different space. The record's single `space` field is what retrieval
    // uses to decide the passage matrix is comparable to a query vector
    // (search.js gates on `rec.space === indexStats.space`, then dots every
    // passage and votes that list at the heaviest weight in the fusion). So
    // re-stamping the space while keeping passages embedded by a different
    // model would make the document cite an arbitrary passage as "the part
    // that matched" — worse than citing none.
    //
    // The passage *text* is still good and re-chunking it is free, so keep
    // texts and offsets and drop only the vectors. count = 0 makes retrieval
    // skip the passage tier for this document until a full deepen re-embeds
    // them.
    rec = {
      ...existing,
      docVec: vec32,
      space,
      count: 0,
      data: new Float32Array(0),
      dim: vec32 ? vec32.length : existing.dim,
    };
  }

  await batch(STORE.chunks, (s) => s.put(rec));
  return rec;
}

export async function getChunks(memId) {
  const s = await tx(STORE.chunks, 'readonly');
  return reqToPromise(s.get(memId));
}

export async function getChunksMany(memIds) {
  if (!memIds || memIds.length === 0) return new Map();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE.chunks, 'readonly');
    const s = t.objectStore(STORE.chunks);
    const out = new Map();
    let remaining = memIds.length;
    for (const id of memIds) {
      const r = s.get(id);
      r.onsuccess = () => { if (r.result) out.set(id, r.result); if (--remaining === 0) resolve(out); };
      r.onerror = () => reject(r.error);
    }
  });
}

export async function allChunkKeys() {
  const s = await tx(STORE.chunks, 'readonly');
  return reqToPromise(s.getAllKeys());
}

// ---------- raw store access (used by index.js) ----------

export async function metaGet(key, fallback = null) {
  const s = await tx(STORE.meta, 'readonly');
  const rec = await reqToPromise(s.get(key));
  return rec ? rec.value : fallback;
}

export async function metaSet(key, value) {
  await batch(STORE.meta, (s) => s.put({ key, value }));
  return value;
}

export async function shardGet(shard) {
  const s = await tx(STORE.vectors, 'readonly');
  return reqToPromise(s.get(shard));
}

export async function shardAll() {
  const s = await tx(STORE.vectors, 'readonly');
  return reqToPromise(s.getAll());
}

export async function shardPutMany(shards) {
  await batch(STORE.vectors, (s) => { for (const sh of shards) s.put(sh); });
}

export async function shardClear() {
  await batch(STORE.vectors, (s) => s.clear());
}

export async function postingsGetMany(terms) {
  if (!terms || terms.length === 0) return new Map();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE.postings, 'readonly');
    const s = t.objectStore(STORE.postings);
    const out = new Map();
    let remaining = terms.length;
    for (const term of terms) {
      const r = s.get(term);
      r.onsuccess = () => { if (r.result) out.set(term, r.result); if (--remaining === 0) resolve(out); };
      r.onerror = () => reject(r.error);
    }
  });
}

export async function postingsPutMany(records) {
  await batch(STORE.postings, (s) => { for (const r of records) s.put(r); });
}

export async function postingsClear() {
  await batch(STORE.postings, (s) => s.clear());
}

// ---------- episodes & entities ----------

export async function episodePut(ep) {
  await batch(STORE.episodes, (s) => s.put(ep));
  return ep;
}
export async function episodePutMany(eps) {
  await batch(STORE.episodes, (s) => { for (const e of eps) s.put(e); });
  return eps.length;
}
export async function episodeGet(id) {
  const s = await tx(STORE.episodes, 'readonly');
  return reqToPromise(s.get(id));
}
export async function episodesAll() {
  const s = await tx(STORE.episodes, 'readonly');
  return reqToPromise(s.getAll());
}
export async function episodesClear() {
  await batch(STORE.episodes, (s) => s.clear());
}

export async function entityPut(e) {
  await batch(STORE.entities, (s) => s.put(e));
  return e;
}
export async function entityPutMany(list) {
  await batch(STORE.entities, (s) => { for (const e of list) s.put(e); });
  return list.length;
}
export async function entityGet(id) {
  const s = await tx(STORE.entities, 'readonly');
  return reqToPromise(s.get(id));
}
export async function entitiesAll() {
  const s = await tx(STORE.entities, 'readonly');
  return reqToPromise(s.getAll());
}
export async function entitiesClear() {
  await batch(STORE.entities, (s) => s.clear());
}

// ---------- migration ----------

/**
 * Lift v1 data into the v2 shape.
 *
 * v1 stored a plain 1536-number array on each memory record. We move those
 * into the vector index and the chunk store, then strip the field. Entirely
 * local — no embedding is recomputed, so migrating a 10,000-memory store
 * costs zero API calls and zero quota.
 *
 * Idempotent and safe to re-enter: progress is recorded in meta, and a
 * partially-migrated store simply resumes.
 */
// Guards against the same context entering migration twice — boot paths and
// page loads both call it, and it is check-then-act.
let migrationInFlight = null;

export async function migrateIfNeeded(opts = {}) {
  if (migrationInFlight) return migrationInFlight;
  migrationInFlight = runMigration(opts).finally(() => { migrationInFlight = null; });
  return migrationInFlight;
}

async function runMigration({ onProgress } = {}) {
  await openDB();
  const done = await metaGet('schemaVersion', 0);
  if (done >= 2) return { migrated: false, count: 0 };

  // Cross-context guard. The in-flight promise above only covers one
  // JavaScript context, and the dashboard and service worker are separate —
  // both call this on startup. rebuildFrom() opens by clearing shards and
  // postings, so a second entrant would wipe the first one's work halfway
  // through and leave a mix of old and new ordinals.
  //
  // The lease is claimed in a single read-modify-write and expires, so a
  // worker killed mid-migration doesn't deadlock the next attempt.
  // A lease is considered dead only if it hasn't been renewed recently. The
  // holder renews while it works, so a migration that legitimately takes ten
  // minutes never looks abandoned.
  const LEASE_STALE_MS = 30 * 1000;
  const RENEW_MS = 10 * 1000;
  const owner = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const lease = await metaGet('migrationLease', null);
  if (lease && Date.now() - lease.at < LEASE_STALE_MS) {
    // Someone else is doing it. Wait for as long as they keep renewing —
    // giving up while a live holder is still working would mean starting a
    // second migration, and rebuildFrom() opens by clearing shards and
    // postings, destroying the first one's work.
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      if ((await metaGet('schemaVersion', 0)) >= 2) return { migrated: false, count: 0, waited: true };
      const current = await metaGet('migrationLease', null);
      if (!current || Date.now() - current.at >= LEASE_STALE_MS) break; // holder stopped renewing
    }
  }

  await metaSet('migrationLease', { at: Date.now(), owner });
  const renewer = setInterval(() => {
    metaSet('migrationLease', { at: Date.now(), owner }).catch(() => {});
  }, RENEW_MS);

  try {
    return await doMigrate({ onProgress });
  } finally {
    clearInterval(renewer);
    // Only clear a lease we still hold — another context may have taken over
    // after concluding this one died.
    const held = await metaGet('migrationLease', null);
    if (!held || held.owner === owner) await metaSet('migrationLease', null);
  }
}

async function doMigrate({ onProgress } = {}) {

  const index = await import('./index.js');
  const memories = await all();
  onProgress?.({ stage: 'scan', total: memories.length });

  const docs = [];
  const rewritten = [];
  for (const m of memories) {
    if (m.embedding && m.embedding.length > 0) {
      const vec = normalize(toFloat32(m.embedding));
      docs.push({
        id: m.id,
        vec,
        // Carried across explicitly: without it the index stamps every
        // migrated memory with the migration time, and "what did I read
        // yesterday" would answer for the whole archive.
        createdAt: m.createdAt,
        // v1 never chunked, so the whole document becomes a single passage.
        chunks: [{ text: (m.summary || m.title || '').slice(0, 1800), start: 0, vec }],
        // v1 predates provider tagging. Assume the currently configured
        // provider produced these; if that guess is wrong the vectors are
        // simply excluded from semantic scoring until re-embedded, and BM25
        // still covers them.
        space: null,
        tokensText: [m.title, m.summary, (m.tags || []).join(' '), (m.keyFacts || []).join(' '), m.text].filter(Boolean).join('\n'),
      });
    } else {
      docs.push({
        id: m.id, vec: null, chunks: [], space: null, createdAt: m.createdAt,
        tokensText: [m.title, m.summary, (m.tags || []).join(' '), m.text].filter(Boolean).join('\n'),
      });
    }
    const { embedding, ...rest } = m;
    rewritten.push(rest);
  }

  onProgress?.({ stage: 'index', total: docs.length });
  await index.rebuildFrom(docs, { onProgress });

  onProgress?.({ stage: 'compact', total: rewritten.length });
  await putMany(rewritten);

  await metaSet('schemaVersion', 2);
  await metaSet('migratedAt', Date.now());
  onProgress?.({ stage: 'done', total: rewritten.length });
  return { migrated: true, count: rewritten.length };
}

// ---------- export / import ----------

export async function exportAll() {
  const items = await all();
  // Embeddings are reproducible from the index, and they dominate the file
  // size — a 5,000-memory export drops from roughly 250MB to under 20MB by
  // leaving them out. Import rebuilds them.
  return JSON.stringify({
    version: DB_VERSION,
    exportedAt: Date.now(),
    memories: items,
  }, null, 2);
}

export async function importAll(json) {
  const data = JSON.parse(json);
  if (!Array.isArray(data.memories)) throw new Error('Invalid export file');
  const index = await import('./index.js');

  const records = [];
  const docs = [];
  for (const m of data.memories) {
    const { embedding, ...rest } = m;
    records.push(rest);
    const vec = embedding && embedding.length ? normalize(toFloat32(embedding)) : null;
    docs.push({
      id: m.id,
      vec,
      // Carried across explicitly. Without it addDoc stamps Date.now(), the
      // record keeps its real date but the index doesn't, and every restored
      // memory then falls inside "yesterday" and "this week" — so restoring a
      // backup makes every time-scoped question return the whole archive.
      createdAt: m.createdAt,
      chunks: vec ? [{ text: (m.summary || m.title || '').slice(0, 1800), start: 0, vec }] : [],
      space: m.embedSpace || null,
      tokensText: [m.title, m.summary, (m.tags || []).join(' '), (m.keyFacts || []).join(' '), m.text].filter(Boolean).join('\n'),
    });
  }

  await putMany(records);
  // Flush periodically rather than only at the end: a large restore killed
  // partway would otherwise leave every record written but unindexed.
  // reconcile() would repair it on the next boot, but not losing it in the
  // first place is cheaper.
  for (let i = 0; i < docs.length; i++) {
    await index.addDoc(docs[i]);
    if (i % 200 === 199) await index.flush();
  }
  await index.flush();
  return records.length;
}

// Re-exported so callers that only need quantisation don't also import vec.js.
export { quantize };
