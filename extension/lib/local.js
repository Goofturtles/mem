// On-device AI. Two independent halves, and it matters that they're
// independent:
//
//   Generation runs on Chrome's built-in model (Gemini Nano) through the
//   Prompt and Summarizer APIs. Real model, real quality, no network, no key.
//
//   Embedding has no on-device counterpart — Chrome ships no embedding API —
//   so this file computes a deterministic hashed feature vector instead.
//   That is genuinely weaker than a learned embedding: it captures shared
//   vocabulary and morphology, not synonymy. "Photovoltaics" will not find
//   "solar cells" here the way a cloud embedding would. It is, however,
//   dense, normalised, and in the same shape as everything else, so it
//   composes with BM25 through the same fusion path and keeps mem fully
//   functional offline. The UI says so plainly rather than implying parity.

import { contentTokens, bigrams, charNgrams, hash32 } from './text.js';
import { DIM } from './vec.js';

export const LOCAL_SPACE = `local:${DIM}`;

// Gemini Nano's context window is far smaller than a cloud model's, so
// callers clip to this rather than discovering the limit as a runtime error.
export const LOCAL_MAX_CONTEXT = 4000;

// ---------- capability detection ----------

function languageModelApi() {
  const g = typeof globalThis !== 'undefined' ? globalThis : self;
  if (g.LanguageModel) return { api: g.LanguageModel, style: 'modern' };
  // Pre-standardisation namespace, still present in some channels.
  if (g.ai?.languageModel) return { api: g.ai.languageModel, style: 'legacy' };
  return null;
}

function summarizerApi() {
  const g = typeof globalThis !== 'undefined' ? globalThis : self;
  if (g.Summarizer) return { api: g.Summarizer, style: 'modern' };
  if (g.ai?.summarizer) return { api: g.ai.summarizer, style: 'legacy' };
  return null;
}

/**
 * Normalise the two API generations into one availability string:
 * 'unavailable' | 'downloadable' | 'downloading' | 'available'.
 */
async function availabilityOf(entry) {
  if (!entry) return 'unavailable';
  const { api, style } = entry;
  try {
    if (style === 'modern' && typeof api.availability === 'function') {
      return await api.availability();
    }
    if (typeof api.capabilities === 'function') {
      const caps = await api.capabilities();
      const a = caps?.available;
      if (a === 'readily') return 'available';
      if (a === 'after-download') return 'downloadable';
      return 'unavailable';
    }
  } catch {
    return 'unavailable';
  }
  return 'unavailable';
}

/** Full picture for the settings UI. */
export async function status() {
  const lm = languageModelApi();
  const sm = summarizerApi();
  const [lmAvail, smAvail] = await Promise.all([availabilityOf(lm), availabilityOf(sm)]);
  return {
    supported: !!lm,
    languageModel: lmAvail,
    summarizer: smAvail,
    // Embeddings are always available because we compute them ourselves —
    // but they're lexical, and callers surface that distinction.
    embeddings: 'lexical',
    ready: lmAvail === 'available',
    needsDownload: lmAvail === 'downloadable' || lmAvail === 'downloading',
  };
}

export async function isReady() {
  return (await availabilityOf(languageModelApi())) === 'available';
}

/**
 * Trigger the model download. Chrome requires a user gesture for this, so it
 * must be called from a click handler in the options page, not from the
 * service worker.
 */
export async function prepare({ onProgress } = {}) {
  const entry = languageModelApi();
  if (!entry) throw new Error('This browser has no built-in AI. Chrome 138+ on desktop is required.');
  const avail = await availabilityOf(entry);
  if (avail === 'unavailable') {
    throw new Error('Built-in AI is unavailable on this device. It needs a desktop Chrome with enough free disk space and a supported GPU.');
  }
  const session = await entry.api.create({
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        onProgress?.({ loaded: e.loaded, total: e.total || 1 });
      });
    },
  });
  session.destroy?.();
  return status();
}

// ---------- session helpers ----------

async function withSession(opts, fn) {
  const entry = languageModelApi();
  if (!entry) {
    const err = new Error('No on-device model available in this browser.');
    err.code = 'LOCAL_UNAVAILABLE';
    throw err;
  }
  const avail = await availabilityOf(entry);
  if (avail !== 'available') {
    const err = new Error(
      avail === 'downloadable' || avail === 'downloading'
        ? 'On-device model still downloading. Open Settings and wait for it to finish.'
        : 'On-device model is unavailable on this device.'
    );
    err.code = 'LOCAL_UNAVAILABLE';
    throw err;
  }
  let session;
  try {
    session = await entry.api.create(opts);
    return await fn(session);
  } finally {
    try { session?.destroy?.(); } catch { /* already gone */ }
  }
}

function clip(text, max = LOCAL_MAX_CONTEXT) {
  const t = text || '';
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.7);
  return t.slice(0, head) + '\n…\n' + t.slice(-(max - head - 3));
}

/**
 * Pull the first JSON object out of a model response. Nano ignores response
 * constraints more often than a cloud model does, so this handles fenced
 * code blocks and leading prose.
 */
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// ---------- generation ----------

const SUMMARY_INSTRUCTION = `You extract structured memory from things the user read. Reply with JSON only, no prose, no code fence.
Shape: {"summary": string, "tags": string[], "keyFacts": string[], "contentType": string}
- summary: 2-3 plain sentences stating the main point. Never invent facts.
- tags: 3-6 concept tags ("perovskite stability"), never generic ones ("science").
- keyFacts: up to 5 concrete facts actually stated in the text.
- contentType: one of article, paper, documentation, discussion, reference, tutorial, other.`;

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    keyFacts: { type: 'array', items: { type: 'string' } },
    contentType: {
      type: 'string',
      enum: ['article', 'paper', 'documentation', 'discussion', 'reference', 'tutorial', 'other'],
    },
  },
  required: ['summary', 'tags', 'keyFacts', 'contentType'],
};

export async function summarize({ title, url, text }) {
  const body = `Title: ${title}\nURL: ${url}\n\n---\n${clip(text)}`;
  return withSession({ initialPrompts: [{ role: 'system', content: SUMMARY_INSTRUCTION }] }, async (session) => {
    let raw;
    try {
      raw = await session.prompt(body, { responseConstraint: SUMMARY_SCHEMA });
    } catch {
      // Older builds reject the responseConstraint option outright.
      raw = await session.prompt(body);
    }
    const parsed = extractJson(raw);
    if (!parsed || !parsed.summary) {
      // Rather than fail the whole ingest, fall back to the raw text as a
      // summary. A rough memory beats no memory.
      const fallback = (raw || '').trim().slice(0, 400);
      if (!fallback) throw new Error('On-device model returned nothing.');
      return { summary: fallback, tags: [], keyFacts: [], contentType: 'other' };
    }
    return {
      summary: String(parsed.summary).slice(0, 1200),
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 6).map(String) : [],
      keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts.slice(0, 5).map(String) : [],
      contentType: SUMMARY_SCHEMA.properties.contentType.enum.includes(parsed.contentType)
        ? parsed.contentType : 'other',
    };
  });
}

/** Streaming answer. onToken(delta, accumulated) mirrors the cloud providers. */
export async function answerStream({ system, question, context, onToken, signal }) {
  return withSession({ initialPrompts: [{ role: 'system', content: clip(system, 2200) }] }, async (session) => {
    const prompt = `Question: ${question}\n\n---\n${clip(context, LOCAL_MAX_CONTEXT)}`;
    let acc = '';
    if (typeof session.promptStreaming === 'function') {
      const stream = session.promptStreaming(prompt, signal ? { signal } : undefined);
      for await (const chunk of stream) {
        // The modern API yields deltas; the legacy one yielded the full
        // accumulated string each time. Detect which by checking whether the
        // chunk extends what we already have.
        const delta = chunk.startsWith(acc) && chunk.length >= acc.length ? chunk.slice(acc.length) : chunk;
        acc += delta;
        onToken?.(delta, acc);
      }
      return acc;
    }
    acc = await session.prompt(prompt, signal ? { signal } : undefined);
    onToken?.(acc, acc);
    return acc;
  });
}

/** Free-form single-shot generation — used by query rewriting and naming. */
export async function generate({ system, prompt, maxChars = 600, signal }) {
  return withSession({ initialPrompts: system ? [{ role: 'system', content: clip(system, 1500) }] : undefined }, async (session) => {
    const out = await session.prompt(clip(prompt, LOCAL_MAX_CONTEXT), signal ? { signal } : undefined);
    return (out || '').trim().slice(0, maxChars);
  });
}

/** Structured single-shot generation against a JSON schema. */
export async function generateJson({ system, prompt, schema, signal }) {
  return withSession({ initialPrompts: system ? [{ role: 'system', content: clip(system, 1500) }] : undefined }, async (session) => {
    let raw;
    try {
      raw = await session.prompt(clip(prompt, LOCAL_MAX_CONTEXT), { responseConstraint: schema, ...(signal ? { signal } : {}) });
    } catch {
      raw = await session.prompt(clip(prompt, LOCAL_MAX_CONTEXT), signal ? { signal } : undefined);
    }
    return extractJson(raw);
  });
}

// ---------- local embeddings ----------

// Relative weights for the three feature families. Whole words carry the most
// signal; bigrams add a little word order; character n-grams give partial
// credit for morphology so "mitochondria" and "mitochondrial" land near each
// other without any learned model.
const W_UNIGRAM = 1.0;
const W_BIGRAM = 0.55;
const W_CHARGRAM = 0.30;

// Salt for the sign hash. It has to differ from the bucket hash's input,
// otherwise sign and bucket are perfectly correlated and collisions stop
// cancelling.
const SIGN_SALT = 'sgn:';

function addFeature(vec, dim, feature, weight) {
  const idx = hash32(feature) % dim;
  // A second, independent hash picks the sign. Signed hashing makes
  // collisions cancel in expectation instead of always inflating a bucket,
  // which keeps the dot product an unbiased estimate of true overlap.
  const sign = (hash32(SIGN_SALT + feature) & 1) ? 1 : -1;
  vec[idx] += sign * weight;
}

/**
 * Deterministic hashed embedding. Same text always produces the same vector,
 * on any machine, forever — which matters because a vector written today has
 * to stay comparable to one written months from now.
 */
export function embed(text, dim = DIM) {
  const vec = new Float32Array(dim);
  const tokens = contentTokens(text || '');
  if (tokens.length === 0) return vec;

  // Sublinear term frequency: the tenth occurrence of a word says much less
  // than the second. Same reasoning as BM25's saturation term.
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  for (const [t, n] of tf) {
    const w = (1 + Math.log(n)) * W_UNIGRAM;
    addFeature(vec, dim, t, w);
    if (t.length > 5) {
      const grams = charNgrams(t, 4);
      const gw = (W_CHARGRAM * w) / Math.sqrt(grams.length);
      for (const g of grams) addFeature(vec, dim, 'c:' + g, gw);
    }
  }

  const bg = new Map();
  for (const b of bigrams(tokens)) bg.set(b, (bg.get(b) || 0) + 1);
  for (const [b, n] of bg) addFeature(vec, dim, 'b:' + b, (1 + Math.log(n)) * W_BIGRAM);

  let sum = 0;
  for (let i = 0; i < dim; i++) sum += vec[i] * vec[i];
  if (sum > 0) {
    const inv = 1 / Math.sqrt(sum);
    for (let i = 0; i < dim; i++) vec[i] *= inv;
  }
  return vec;
}

export function embedBatch(texts, dim = DIM) {
  return texts.map((t) => embed(t, dim));
}

/**
 * True for embedding spaces that are lexical rather than learned. Retrieval
 * uses this to lean harder on BM25 during fusion, since a hashed vector and
 * BM25 largely agree and shouldn't get to vote twice at full weight.
 */
export function isLexicalSpace(space) {
  return typeof space === 'string' && space.startsWith('local:');
}
