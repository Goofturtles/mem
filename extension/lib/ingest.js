// Shared ingest pipeline. Everything that becomes text — web pages, files,
// Drive docs, history, bookmarks, Gmail, YouTube, Calendar, Classroom —
// flows through here.
//
// The significant change in v2 is that documents are chunked. A page is
// split into overlapping passages, each passage gets its own embedding, and
// all of them go into the index. Before this, one embedding was computed
// over the title plus the first 2,000 characters and that was the entire
// searchable surface of the document; anything below the fold was invisible
// to semantic search no matter how it was phrased.
//
// The added cost is small. Chunk embeddings for a whole page are a single
// batched request — one API call, the same as before — and embedding tokens
// are the cheapest thing either provider sells.

import * as store from './storage.js';
import * as index from './index.js';
import * as ai from './ai.js';
import { chunkText } from './text.js';
import { linkEntities } from './entities.js';

// Chunk embeddings for one document are batched into a single request, so
// the ceiling exists to bound memory and storage rather than API cost. The
// chunk target scales up for very long documents so coverage stays complete
// instead of the tail being dropped.
const MAX_CHUNKS = 40;
const MIN_CHUNKABLE = 1600;  // below this, the document is its own passage
const MAX_TEXT = 60000;

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/**
 * SHA-1 of normalised content. Lets a re-save of unchanged content skip the
 * entire AI pipeline — worth a lot under auto-capture, where the same pages
 * are revisited constantly.
 */
async function contentHash(title, text) {
  const norm = (title || '').trim() + '\n' + (text || '').trim().slice(0, 8000);
  const buf = new TextEncoder().encode(norm);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * "Trivial" content: essentially the title repeated, or too short to say
 * anything. These skip the chat-completion call and are stored as
 * lightweight, title-only memories.
 */
function isTrivial(title, text) {
  const t = (text || '').trim();
  const tl = (title || '').trim();
  if (t.length < 500) return true;
  if (tl && t.startsWith(tl) && t.length < tl.length * 3) return true;
  return false;
}

/** Text used for the document-level embedding. */
function docEmbedText({ title, summary, tags, text }) {
  return [
    title,
    summary,
    Array.isArray(tags) ? tags.join(', ') : '',
    (text || '').slice(0, 2000),
  ].filter(Boolean).join('\n\n');
}

/**
 * Build the passages for a document.
 *
 * Each passage is prefixed with the document title before embedding. A bare
 * middle-of-the-document chunk has lost all sense of what the document is
 * about — "it degrades by roughly 30% under thermal stress" doesn't say what
 * "it" is — and the prefix restores that context cheaply. The prefix is used
 * only for the embedding; the stored passage text stays clean so the model
 * quotes real prose.
 */
function buildChunks(title, text) {
  const src = (text || '').slice(0, MAX_TEXT);
  if (src.length < MIN_CHUNKABLE) {
    return src.trim() ? [{ text: src, start: 0, i: 0 }] : [];
  }
  let chunks = chunkText(src);
  if (chunks.length > MAX_CHUNKS) {
    // Widen the target so a very long document still gets full coverage
    // instead of having its tail discarded.
    chunks = chunkText(src, {
      target: Math.ceil(src.length / MAX_CHUNKS),
      max: Math.ceil((src.length / MAX_CHUNKS) * 1.6),
    });
  }
  return chunks.slice(0, MAX_CHUNKS);
}

function embedPrefix(title, chunk) {
  return title ? `${title}\n\n${chunk}` : chunk;
}

/**
 * Input shape:
 *   url         canonical identifier (https://…, mem-file://…, drive://…)
 *   title       display title
 *   text        extracted text
 *   selection?  highlighted subset, preferred over `text` when substantial
 *   excerpt?, favicon?, author?, siteName?, publishedAt?, mime?, extra?
 *   sourceKind  'web' | 'file' | 'drive' | 'gmail' | 'youtube' | 'calendar' |
 *               'classroom' | 'history' | 'bookmark' | 'note'
 *   sourceLabel? human-readable origin shown on the card
 */
export async function ingest(input, { onProgress } = {}) {
  if (!input?.text || input.text.trim().length < 40) {
    throw new Error('Not enough text to remember.');
  }

  const id = await store.urlId(input.url);
  const existing = await store.get(id);
  const textForAI = input.selection && input.selection.length > 200 ? input.selection : input.text;
  const hash = await contentHash(input.title, textForAI);

  // Unchanged content: bump recency, touch nothing else, spend nothing.
  if (existing && existing.contentHash === hash && existing.summary && existing.summary !== existing.title) {
    onProgress?.('skip-unchanged');
    const updated = { ...existing, updatedAt: Date.now() };
    await store.put(updated);
    return updated;
  }

  onProgress?.('summarize');

  const trivial = isTrivial(input.title, textForAI);
  let summaryResult = { summary: input.title, tags: [], keyFacts: [], contentType: 'other', entities: [] };
  if (!trivial) {
    summaryResult = await ai.summarize({ title: input.title, url: input.url, text: textForAI });
  }

  onProgress?.('embed');

  const chunks = trivial ? [] : buildChunks(input.title, textForAI);
  const docText = docEmbedText({
    title: input.title,
    summary: trivial ? '' : summaryResult.summary,
    tags: summaryResult.tags,
    text: textForAI,
  });

  // One request covers the document vector and every passage vector.
  const toEmbed = [docText, ...chunks.map((c) => embedPrefix(input.title, c.text))];
  let vectors = [];
  let space = null;
  try {
    const res = await ai.embedMany(toEmbed);
    vectors = res.vectors;
    space = res.space;
  } catch (e) {
    // A memory without a vector is still findable by BM25, so a failed
    // embedding degrades search rather than losing the memory.
    console.warn('[mem] embed failed, storing without vectors:', e.message);
  }

  const docVec = vectors[0] || null;
  const chunkRecords = chunks.map((c, i) => ({
    text: c.text,
    start: c.start,
    vec: vectors[i + 1] || null,
  }));

  onProgress?.('store');

  const now = Date.now();
  const memory = {
    id,
    url: input.url,
    title: input.title,
    excerpt: input.excerpt || '',
    text: (input.text || '').slice(0, MAX_TEXT),
    selection: input.selection || '',
    favicon: input.favicon || '',
    author: input.author || '',
    siteName: input.siteName || '',
    publishedAt: input.publishedAt || '',
    summary: summaryResult.summary,
    tags: summaryResult.tags,
    keyFacts: summaryResult.keyFacts,
    contentType: summaryResult.contentType,
    sourceKind: input.sourceKind || 'web',
    sourceLabel: input.sourceLabel || input.siteName || '',
    mime: input.mime || '',
    extra: input.extra || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    source: existing ? 'updated' : 'new', // legacy field, superseded by sourceKind
    contentHash: hash,
    embedSpace: space,
    chunkCount: chunkRecords.length,
    ...(trivial ? { lightweight: true } : {}),
    // Preserve any episode assignment across a re-ingest.
    ...(existing?.episodeId ? { episodeId: existing.episodeId } : {}),
  };

  await store.put(memory);

  await index.addDoc({
    id,
    vec: docVec,
    space,
    createdAt: memory.createdAt,
    chunks: chunkRecords,
    tokensText: [
      memory.title, memory.summary, (memory.tags || []).join(' '),
      (memory.keyFacts || []).join(' '), memory.text,
    ].filter(Boolean).join('\n'),
  });
  await index.flush();

  // Entity linking is best-effort — a failure here must not lose the memory.
  if (!trivial && summaryResult.entities?.length) {
    try {
      const entityIds = await linkEntities(id, summaryResult.entities, memory.createdAt);
      if (entityIds.length) {
        memory.entityIds = entityIds;
        await store.put(memory);
      }
    } catch (e) {
      console.warn('[mem] entity linking failed:', e.message);
    }
  }

  return memory;
}

/**
 * Bulk ingest for first-run scans: history, bookmarks, Gmail subjects,
 * YouTube playlists, Calendar. Embeds title plus whatever context the source
 * provides, and does not call the summarizer per item — that would be
 * thousands of chat completions for a single scan.
 *
 * The memories this produces are title-only. deepen.js upgrades the ones
 * that matter in the background.
 */
export async function ingestBatch(items, { onProgress } = {}) {
  if (!Array.isArray(items) || items.length === 0) return { added: 0, skipped: 0 };

  onProgress?.({ stage: 'dedup', total: items.length });
  const valid = items.filter((it) => it.url && it.title);
  const ids = await Promise.all(valid.map((it) => store.urlId(it.url)));
  const existingMap = await store.getManyExist(ids);

  // Deduplicate against the store *and* within the batch itself. A source can
  // easily hand us the same URL twice — a bookmark filed in two folders, a
  // message appearing in two Gmail labels — and without this each duplicate
  // would consume an embedding, overwrite the previous record, and inflate
  // the reported count.
  const seen = new Set();
  const fresh = [];
  for (let i = 0; i < valid.length; i++) {
    const id = ids[i];
    if (existingMap.get(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    fresh.push({ ...valid[i], id });
  }
  if (fresh.length === 0) return { added: 0, skipped: items.length };

  onProgress?.({ stage: 'embed', total: fresh.length });
  const texts = fresh.map((it) => {
    const parts = [it.title];
    if (it.siteName) parts.push(it.siteName);
    if (it.context) parts.push(it.context);
    if (it.tags?.length) parts.push(it.tags.join(', '));
    return parts.join('\n');
  });

  let vectors = new Array(fresh.length).fill(null);
  let space = null;
  try {
    const res = await ai.embedMany(texts);
    vectors = res.vectors;
    space = res.space;
  } catch (e) {
    console.warn('[mem] bulk embed failed, indexing lexically only:', e.message);
  }

  onProgress?.({ stage: 'store', total: fresh.length });
  const now = Date.now();
  const records = fresh.map((it, i) => ({
    id: it.id,
    url: it.url,
    title: it.title,
    excerpt: (it.context || '').slice(0, 240),
    text: it.context || it.title,
    selection: '',
    favicon: it.favicon || '',
    author: it.author || '',
    siteName: it.siteName || hostOf(it.url),
    publishedAt: it.publishedAt || '',
    summary: it.context || it.title,
    tags: it.tags || [],
    keyFacts: [],
    contentType: it.contentType || 'reference',
    sourceKind: it.sourceKind,
    sourceLabel: it.sourceLabel || '',
    mime: it.mime || '',
    extra: it.extra || null,
    createdAt: it.createdAt || now,
    updatedAt: now,
    lightweight: true,
    embedSpace: space,
    chunkCount: 0,
  }));

  await store.putMany(records);

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    await index.addDoc({
      id: r.id,
      vec: vectors[i],
      space,
      createdAt: r.createdAt,
      // A title-only memory has one passage: itself.
      chunks: vectors[i] ? [{ text: texts[i], start: 0, vec: vectors[i] }] : [],
      tokensText: [r.title, r.summary, (r.tags || []).join(' '), r.siteName].filter(Boolean).join('\n'),
    });
    if (i % 200 === 0) await index.flush();
  }
  await index.flush();

  onProgress?.({ stage: 'done', total: fresh.length });
  return { added: fresh.length, skipped: items.length - fresh.length };
}
