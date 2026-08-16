// The entity graph: people, organisations, places, products, events, and the
// concepts a person keeps returning to.
//
// This is one of the things a history search cannot do, structurally. History
// stores URLs and titles — it has no notion that "Jamie Chen" in an email
// header, "Jamie" in a calendar invite, and "J. Chen" on a shared document
// are the same person, so it can never answer "everything about Jamie".
//
// Entities arrive two ways:
//   - the summarizer already returns them, so full ingests cost nothing extra
//   - author fields, email senders, and calendar organisers are entities on
//     their face, so those are linked without any model call at all — which
//     matters because the bulk-scanned corpus is title-only and would
//     otherwise contribute nothing to the graph

import * as store from './storage.js';

const KINDS = ['person', 'org', 'place', 'concept', 'product', 'event'];

// Honorifics and suffixes stripped before comparing names, so "Mr. Patel"
// and "Patel" resolve to one person.
const TITLES = /^(mr|mrs|ms|miss|dr|prof|professor|sir|madam|rev|hon)\.?\s+/i;
const SUFFIXES = /\s+(jr|sr|ii|iii|iv|phd|md|esq)\.?$/i;

/** Canonical comparison form of a name. */
export function normName(name) {
  let s = String(name || '').trim();
  s = s.replace(TITLES, '').replace(SUFFIXES, '');
  s = s.toLowerCase();
  s = s.replace(/[‘’']/g, '');
  s = s.replace(/[^a-z0-9\s-]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

export function entityId(kind, norm) { return `${kind}:${norm}`; }

/** Names too generic to be worth a node in the graph. */
const NOISE = new Set([
  'me', 'you', 'us', 'them', 'no reply', 'noreply', 'no-reply', 'support',
  'info', 'admin', 'notifications', 'team', 'the team', 'newsletter',
  'unknown', 'n a', 'untitled', 'google', 'gmail',
]);

function isUsableName(norm, kind) {
  if (!norm || norm.length < 2) return false;
  if (NOISE.has(norm)) return false;
  if (/^\d+$/.test(norm)) return false;
  // A single-character-per-word string is almost always an artefact.
  if (kind === 'person' && norm.length > 60) return false;
  return true;
}

/** Extract a display name out of an email header value. */
export function nameFromEmailField(value) {
  if (!value) return null;
  const s = String(value).trim();
  const angled = s.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  if (angled) return angled[1].trim();
  const bare = s.match(/^([^@\s]+)@[^@\s]+$/);
  if (bare) {
    // first.last@ or first_last@ → "First Last"
    return bare[1].replace(/[._-]+/g, ' ').replace(/\d+/g, '').trim();
  }
  return s.includes('@') ? null : s;
}

/**
 * Conservative alias resolution for people.
 *
 * "Jamie" folds into "Jamie Chen" only when exactly one existing person
 * starts with that token. If two people are called Jamie, the bare first
 * name stays its own node rather than being attached to the wrong person —
 * a wrong merge is much worse than a missed one, because it silently
 * attributes one person's emails and documents to another.
 */
function resolveAlias(norm, kind, existing) {
  if (kind !== 'person') return null;
  const parts = norm.split(' ');
  if (parts.length !== 1) return null;
  const matches = [];
  for (const e of existing.values()) {
    if (e.kind !== 'person') continue;
    const en = e.norm.split(' ');
    if (en.length > 1 && en[0] === norm) matches.push(e);
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Attach a set of entities to a memory. Returns the entity ids that were
 * linked, so the memory record can carry them for the multiEntry index.
 */
export async function linkEntities(memId, entities, ts = Date.now()) {
  if (!entities || entities.length === 0) return [];
  const all = await store.entitiesAll();
  const byId = new Map(all.map((e) => [e.id, e]));

  const touched = new Map();
  const linked = [];

  for (const raw of entities) {
    const kind = KINDS.includes(raw.kind) ? raw.kind : 'concept';
    const norm = normName(raw.name);
    if (!isUsableName(norm, kind)) continue;

    const alias = resolveAlias(norm, kind, byId);
    const id = alias ? alias.id : entityId(kind, norm);
    let e = touched.get(id) || byId.get(id);
    if (!e) {
      e = {
        id, kind, norm,
        name: String(raw.name).trim().slice(0, 120),
        aliases: [],
        memIds: [],
        count: 0,
        firstSeen: ts,
        lastSeen: ts,
      };
    }
    if (alias && !e.aliases.includes(norm)) e.aliases.push(norm);
    if (!e.memIds.includes(memId)) {
      e.memIds.push(memId);
      e.count = e.memIds.length;
    }
    e.firstSeen = Math.min(e.firstSeen, ts);
    e.lastSeen = Math.max(e.lastSeen, ts);
    touched.set(id, e);
    byId.set(id, e);
    if (!linked.includes(id)) linked.push(id);
  }

  if (touched.size > 0) await store.entityPutMany([...touched.values()]);
  return linked;
}

/**
 * Entities derivable from a memory's own metadata, with no model call.
 * Email senders, document authors, calendar organisers and attendees, video
 * channels — all of these are people or organisations by construction.
 */
export function implicitEntities(memory) {
  const out = [];
  const push = (name, kind) => {
    const clean = nameFromEmailField(name);
    if (clean) out.push({ name: clean, kind });
  };

  if (memory.author) {
    push(memory.author, memory.sourceKind === 'youtube' ? 'org' : 'person');
  }
  const extra = memory.extra || {};
  if (Array.isArray(extra.attendees)) for (const a of extra.attendees) push(a, 'person');
  if (extra.organizer) push(extra.organizer, 'person');
  if (extra.from) push(extra.from, 'person');
  if (extra.channelTitle) push(extra.channelTitle, 'org');
  if (extra.courseName) out.push({ name: extra.courseName, kind: 'event' });
  if (memory.sourceKind === 'drive' && memory.siteName && memory.siteName !== 'Google Drive') {
    out.push({ name: memory.siteName, kind: 'org' });
  }
  return out;
}

/**
 * Top entities by how often they appear.
 *
 * The threshold applies to topics and organisations, not to people. A concept
 * seen once is usually a stray tag, but a person who has emailed you once is
 * still a person — and filtering them out left the graph showing nothing but
 * abstract nouns, which is the opposite of the point.
 */
export async function topEntities({ kind = null, limit = 40, minCount = 2 } = {}) {
  const all = await store.entitiesAll();
  const threshold = (e) => (e.kind === 'person' || e.kind === 'event' ? 1 : minCount);
  return all
    .filter((e) => (!kind || e.kind === kind) && e.count >= threshold(e))
    .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
    .slice(0, limit);
}

/** Everything mem has ever seen about one entity, newest first. */
export async function entityTimeline(id, { limit = 200 } = {}) {
  const e = await store.entityGet(id);
  if (!e) return null;
  const records = (await store.getMany(e.memIds.slice(-limit))).filter(Boolean);
  records.sort((a, b) => b.createdAt - a.createdAt);
  return { entity: e, memories: records };
}

/** Look up an entity by a name the user typed. */
export async function findEntity(name) {
  const norm = normName(name);
  if (!norm) return null;
  const all = await store.entitiesAll();
  return all.find((e) => e.norm === norm)
    || all.find((e) => e.aliases?.includes(norm))
    || all.find((e) => e.norm.startsWith(norm + ' '))
    || null;
}

/**
 * Which entities two memories share. Used to explain a connection in plain
 * language — "both mention Jamie Chen and the Bio project" reads better than
 * a similarity score.
 */
export async function sharedEntities(idA, idB) {
  const [a, b] = await store.getMany([idA, idB]);
  if (!a || !b) return [];
  const setB = new Set(b.entityIds || []);
  const shared = (a.entityIds || []).filter((id) => setB.has(id));
  if (shared.length === 0) return [];
  const all = await store.entitiesAll();
  const byId = new Map(all.map((e) => [e.id, e]));
  return shared.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Rebuild the whole graph from stored memories. Used after a bulk import,
 * and by the settings "rebuild" action. Runs entirely locally: it reuses the
 * entities the summarizer already returned plus everything derivable from
 * metadata, so it costs no API calls.
 */
export async function rebuildAll({ onProgress } = {}) {
  await store.entitiesClear();
  const memories = await store.allLite();
  onProgress?.({ stage: 'entities', total: memories.length, done: 0 });

  const byId = new Map();
  let done = 0;

  for (const m of memories) {
    const candidates = implicitEntities(m);
    // Tags produced by the summarizer are concept entities in all but name.
    for (const t of (m.tags || []).slice(0, 6)) candidates.push({ name: t, kind: 'concept' });

    for (const raw of candidates) {
      const kind = KINDS.includes(raw.kind) ? raw.kind : 'concept';
      const norm = normName(raw.name);
      if (!isUsableName(norm, kind)) continue;
      const alias = resolveAlias(norm, kind, byId);
      const id = alias ? alias.id : entityId(kind, norm);
      let e = byId.get(id);
      if (!e) {
        e = {
          id, kind, norm,
          name: String(raw.name).trim().slice(0, 120),
          aliases: [], memIds: [], count: 0,
          firstSeen: m.createdAt, lastSeen: m.createdAt,
        };
        byId.set(id, e);
      }
      if (alias && !e.aliases.includes(norm)) e.aliases.push(norm);
      if (!e.memIds.includes(m.id)) { e.memIds.push(m.id); e.count = e.memIds.length; }
      e.firstSeen = Math.min(e.firstSeen, m.createdAt);
      e.lastSeen = Math.max(e.lastSeen, m.createdAt);
    }

    done++;
    if (done % 500 === 0) onProgress?.({ stage: 'entities', total: memories.length, done });
  }

  // A name seen exactly once is usually a passing mention, not something the
  // user would recognise as a thing in their life. Keeping singletons would
  // bury the real entities under thousands of one-offs.
  const keep = [...byId.values()].filter((e) => e.count >= 2 || e.kind === 'person');
  await store.entityPutMany(keep);

  // Write the reverse links so the multiEntry index can serve
  // "memories mentioning X" without scanning.
  const memEntities = new Map();
  for (const e of keep) {
    for (const mid of e.memIds) {
      if (!memEntities.has(mid)) memEntities.set(mid, []);
      memEntities.get(mid).push(e.id);
    }
  }
  const updates = [];
  for (const [mid, ids] of memEntities) {
    const full = await store.get(mid);
    if (!full) continue;
    full.entityIds = ids;
    updates.push(full);
    if (updates.length >= 400) { await store.putMany(updates.splice(0)); }
  }
  if (updates.length) await store.putMany(updates);

  onProgress?.({ stage: 'done', total: memories.length, done });
  return { entities: keep.length };
}

export { KINDS };
