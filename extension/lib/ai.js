// AI provider façade. Three backends behind one surface:
//
//   openai  gpt-4o-mini + text-embedding-3-small     (paid, ~$0.001/page)
//   gemini  gemini-2.5-flash + gemini-embedding-001  (free tier)
//   local   Chrome's built-in Gemini Nano + a hashed local embedder
//           (no key, no network, no quota — see local.js for the honest
//           account of what the local embedder can and can't do)
//
// The important behaviour here is the fallback chain. If the configured cloud
// provider has no key, is rate-limited, or the machine is offline, calls fall
// through to the on-device model instead of failing. mem stays useful with
// zero configuration, which is the difference between "install it and it
// works" and "install it, go make an API key, come back".
//
// Every embedding is tagged with the space that produced it
// (`openai:1536`, `gemini:1536`, `local:1536`). Cosine between vectors from
// different models is meaningless, so the index refuses to mix them rather
// than quietly returning nonsense similarities.

import { getSetting, setSetting } from './env.js';
import { DIM } from './vec.js';
import * as local from './local.js';

export const EMBED_DIM = DIM;

export const PROVIDER = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    keyPrefix: 'sk-',
    getKeyUrl: 'https://platform.openai.com/api-keys',
    placeholder: 'sk-...',
    cost: 'About $0.001 per page (gpt-4o-mini + text-embedding-3-small).',
    needsKey: true,
    maxContext: 8000,
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    keyPrefix: 'AIza',
    getKeyUrl: 'https://aistudio.google.com/app/apikey',
    placeholder: 'AIza...',
    cost: 'Free tier (gemini-2.5-flash) covers most personal use.',
    needsKey: true,
    maxContext: 8000,
  },
  local: {
    id: 'local',
    name: 'On-device',
    keyPrefix: '',
    getKeyUrl: '',
    placeholder: '',
    cost: 'Runs entirely on this machine. No key, no network, no quota.',
    needsKey: false,
    maxContext: local.LOCAL_MAX_CONTEXT,
  },
};

export function spaceOf(provider) { return `${provider}:${DIM}`; }

// ---------- provider selection ----------

export async function currentProvider() {
  return (await getSetting('aiProvider')) || 'gemini';
}

export async function switchProvider(provider) {
  if (!PROVIDER[provider]) throw new Error(`Unknown provider: ${provider}`);
  await setSetting('aiProvider', provider);
}

/** Whether automatic fallback to the on-device model is enabled. Default on. */
export async function localFallbackEnabled() {
  const v = await getSetting('localFallback');
  return v === undefined ? true : !!v;
}

async function keyFor(provider) {
  if (!PROVIDER[provider]?.needsKey) return '';
  const keyName = provider === 'openai' ? 'openaiKey' : 'geminiKey';
  let key = await getSetting(keyName);
  if (!key && provider === 'openai') key = await getSetting('apiKey'); // pre-Gemini legacy
  return key || '';
}

/** Back-compat: throws NO_API_KEY when the configured provider has no key. */
export async function getApiKey() {
  const provider = await currentProvider();
  const key = await keyFor(provider);
  if (!key && PROVIDER[provider].needsKey) {
    const err = new Error(`No ${PROVIDER[provider].name} key set. Open settings and paste your key.`);
    err.code = 'NO_API_KEY';
    err.provider = provider;
    throw err;
  }
  return { provider, key };
}

/**
 * Ordered list of providers to attempt. The configured one first; the
 * on-device model appended as a fallback when it's enabled and usable.
 */
async function chain() {
  const configured = await currentProvider();
  const out = [];
  const key = await keyFor(configured);
  if (!PROVIDER[configured].needsKey || key) out.push({ provider: configured, key });
  if (configured !== 'local' && await localFallbackEnabled()) {
    if (await local.isReady()) out.push({ provider: 'local', key: '' });
  }
  if (out.length === 0) {
    // Nothing usable. Report against the configured provider so the UI can
    // offer the right call to action.
    if (configured !== 'local' && await localFallbackEnabled() && languageModelPresent()) {
      const err = new Error(`No ${PROVIDER[configured].name} key set, and the on-device model isn't ready yet. Add a key or finish the on-device download in Settings.`);
      err.code = 'NO_API_KEY';
      err.provider = configured;
      throw err;
    }
    const err = new Error(
      configured === 'local'
        ? "This browser's built-in AI isn't available. Add a Gemini or OpenAI key in Settings."
        : `No ${PROVIDER[configured].name} key set. Open settings and paste your key.`
    );
    err.code = 'NO_API_KEY';
    err.provider = configured;
    throw err;
  }
  return out;
}

function languageModelPresent() {
  const g = typeof globalThis !== 'undefined' ? globalThis : self;
  return !!(g.LanguageModel || g.ai?.languageModel);
}

/** Errors worth falling through to the next provider for. */
function isFallbackWorthy(e) {
  if (!e) return false;
  if (e.code === 'NO_API_KEY' || e.code === 'RATE_LIMIT' || e.code === 'LOCAL_UNAVAILABLE') return true;
  const s = e.status || 0;
  if (s === 401 || s === 403 || s === 429 || (s >= 500 && s < 600)) return true;
  return /network|failed to fetch|offline|load failed/i.test(e.message || '');
}

/**
 * Run `fn` against each provider in the chain until one succeeds.
 * `fn(provider, key)` — the last error is rethrown if every provider fails.
 */
async function viaChain(fn, { label = 'call' } = {}) {
  const providers = await chain();
  let lastErr;
  for (let i = 0; i < providers.length; i++) {
    const { provider, key } = providers[i];
    try {
      return await fn(provider, key);
    } catch (e) {
      if (!e.provider) e.provider = provider;
      lastErr = e;
      const more = i < providers.length - 1;
      if (more && isFallbackWorthy(e)) {
        console.warn(`[mem] ${label} failed on ${provider} (${e.code || e.status || e.message}); falling back to ${providers[i + 1].provider}`);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** Which provider a call would actually use right now. */
export async function effectiveProvider() {
  try {
    const c = await chain();
    return c[0].provider;
  } catch {
    return await currentProvider();
  }
}

export async function activeSpace() {
  return spaceOf(await effectiveProvider());
}

// ---------- text clipping ----------

function clipForLLM(text, maxChars = 8000) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.75);
  const tail = maxChars - head - 32;
  return text.slice(0, head) + '\n\n…[content truncated]…\n\n' + text.slice(-tail);
}

// ---------- shared schema ----------

const SUMMARY_FIELDS = ['summary', 'tags', 'keyFacts', 'contentType'];
const CONTENT_TYPES = ['article', 'paper', 'documentation', 'discussion', 'reference', 'tutorial', 'other'];
const ENTITY_KINDS = ['person', 'org', 'place', 'concept', 'product', 'event'];

const OPENAI_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '2-3 sentence summary in plain English. State the main point.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Semantic concept tags, not generic keywords.' },
    keyFacts: { type: 'array', items: { type: 'string' } },
    contentType: { type: 'string', enum: CONTENT_TYPES },
    entities: {
      type: 'array',
      description: 'Named people, organisations, places, products, events, and the specific concepts this is really about.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          kind: { type: 'string', enum: ENTITY_KINDS },
        },
        required: ['name', 'kind'],
        additionalProperties: false,
      },
    },
  },
  required: [...SUMMARY_FIELDS, 'entities'],
  additionalProperties: false,
};

const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: '2-3 sentence summary in plain English. State the main point.' },
    tags: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Semantic concept tags, not generic keywords.' },
    keyFacts: { type: 'ARRAY', items: { type: 'STRING' } },
    contentType: { type: 'STRING', enum: CONTENT_TYPES },
    entities: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { name: { type: 'STRING' }, kind: { type: 'STRING', enum: ENTITY_KINDS } },
        required: ['name', 'kind'],
      },
    },
  },
  required: [...SUMMARY_FIELDS, 'entities'],
};

const SUMMARY_SYSTEM = `You are extracting structured memory from content the user just read. Be concrete and faithful — never invent facts.

tags: describe concepts ("perovskite stability", "vector databases"), not generic keywords ("science", "tech"). 3-6 of them.
keyFacts: up to 5 specific, checkable claims actually stated in the text.
entities: the named people, organisations, places, products and events that appear, plus the specific concepts the piece is really about. Use the name as written. Skip anything incidental — a navigation link or a cookie banner is not an entity.`;

const ANSWER_SYSTEM = `You are the user's second memory. Answer using the snippets below as your full source of truth — paraphrase, synthesize, and describe what was in them with confidence.

Each snippet has:
- A relative timestamp ("12 min ago", "2h ago") — quote as given.
- A source tag: [web], [history], [drive], [gmail], [youtube], [calendar], [classroom], [file].
- A content marker:
   • [content] = real material — the passage shown is the part of the document that actually matched the question. Describe it freely and pull specific facts, names, numbers, and claims from it. Be generous with detail.
   • [title-only] = you only have the title. Say "you opened [title]" — don't fabricate what was on the page.

WHAT GOOD ANSWERS LOOK LIKE

With [content] for an article:
  "2h ago you read Andy Matuschak's piece on spaced repetition [#1] — he argues that the spacing effect is one of the most robust findings in cognitive science, and that tools like Anki automate the interval scheduling so you can offload it from working memory."

NOT good (too vague):
  "2h ago you read about spaced repetition [#1]."

With [content] for a video:
  "Yesterday evening you watched 3Blue1Brown's introduction to neural networks [#2] — Grant walks through how a 4-layer network distinguishes digits, showing what each hidden layer detects and why backprop adjusts weights using gradient descent."

With [content] for an email:
  "Jamie Chen wrote yesterday confirming the project meeting moves to Thursday 3pm in the Bio lab and asked you to bring your unit 3 notes [#3]."

With only [title-only]:
  "Earlier you opened the Stack Overflow question on useEffect dependency arrays [#1] and a Wikipedia page on mitochondria [#2]." (Don't invent what they said.)

RULES
1. Don't invent facts not in the snippets. Paraphrasing or summarising a [content] snippet is not inventing.
2. Cite with [#N] for every specific claim drawn from a snippet.
3. Use relative timestamps as given.
4. If several snippets disagree, say so and cite both sides — that contrast is often the most useful thing you can tell the user.
5. If the snippets genuinely don't address the question, say so once: "I don't see that in your memory."

VOICE
The user's own — specific, confident, fluent. Lean into detail when [content] supports it.`;

// ---------- retry ----------

async function retryable(fn, { maxAttempts = 3 } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e.status || 0;
      const isRetryable = status === 429 || (status >= 500 && status < 600) || /network|fetch/i.test(e.message);
      attempt++;
      if (!isRetryable || attempt >= maxAttempts) {
        if (status === 429) {
          const providerHint = /openai\.com/i.test(e.message) ? 'openai'
            : /generativelanguage\.googleapis|gemini/i.test(e.message) ? 'gemini'
            : null;
          const friendly = new Error('Rate limit — wait a minute or switch provider in Settings.');
          friendly.code = 'RATE_LIMIT';
          friendly.status = 429;
          if (providerHint) friendly.provider = providerHint;
          friendly.cause = e;
          throw friendly;
        }
        throw e;
      }
      const waits = [2000, 5000, 15000];
      const wait = waits[Math.min(attempt - 1, waits.length - 1)] + Math.random() * 500;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function* sseLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const ln of lines) {
      if (ln.startsWith('data:')) yield ln.slice(5).trim();
    }
  }
}

// ---------- OpenAI ----------

const OPENAI_BASE = 'https://api.openai.com/v1';
const OPENAI_CHAT_MODEL = 'gpt-4o-mini';
const OPENAI_EMBED_MODEL = 'text-embedding-3-small';

async function openaiPost(path, body, key) {
  return retryable(async () => {
    const res = await fetch(`${OPENAI_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      const err = new Error(`OpenAI ${path} ${res.status}: ${t.slice(0, 400)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  });
}

async function openaiSummarize({ title, url, text, key }) {
  const user = `Title: ${title}\nURL: ${url}\n\n---\n${clipForLLM(text)}`;
  const data = await openaiPost('/chat/completions', {
    model: OPENAI_CHAT_MODEL,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'memory_extract', strict: true, schema: OPENAI_SCHEMA } },
    temperature: 0.2,
  }, key);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned no summary');
  return JSON.parse(content);
}

async function openaiEmbedBatch(texts, key) {
  const data = await openaiPost('/embeddings', {
    model: OPENAI_EMBED_MODEL,
    input: texts.map((t) => clipForLLM(t, 6000)),
    dimensions: DIM,
  }, key);
  return (data.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function openaiChat({ system, user, key, temperature = 0.3 }) {
  const data = await openaiPost('/chat/completions', {
    model: OPENAI_CHAT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature,
  }, key);
  return data.choices?.[0]?.message?.content || '';
}

async function openaiChatStream({ system, user, key, onToken, signal, temperature = 0.3 }) {
  const res = await retryable(async () => {
    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: OPENAI_CHAT_MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature,
        stream: true,
      }),
      signal,
    });
    if (!r.ok) {
      const t = await r.text();
      const err = new Error(`OpenAI stream ${r.status}: ${t.slice(0, 300)}`);
      err.status = r.status;
      throw err;
    }
    return r;
  });
  let acc = '';
  for await (const chunk of sseLines(res.body)) {
    if (chunk === '[DONE]') break;
    try {
      const delta = JSON.parse(chunk).choices?.[0]?.delta?.content;
      if (delta) { acc += delta; onToken?.(delta, acc); }
    } catch { /* skip malformed line */ }
  }
  return acc;
}

async function openaiTestKey(key) {
  await openaiPost('/embeddings', { model: OPENAI_EMBED_MODEL, input: 'ping', dimensions: DIM }, key);
}

// ---------- Gemini ----------

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_CHAT_MODEL = 'gemini-2.5-flash';
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';

async function geminiPost(path, body, key) {
  return retryable(async () => {
    const res = await fetch(`${GEMINI_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      const err = new Error(`Gemini ${path} ${res.status}: ${t.slice(0, 400)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  });
}

async function geminiSummarize({ title, url, text, key }) {
  const user = `Title: ${title}\nURL: ${url}\n\n---\n${clipForLLM(text)}`;
  const data = await geminiPost(`/models/${GEMINI_CHAT_MODEL}:generateContent`, {
    systemInstruction: { parts: [{ text: SUMMARY_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA },
  }, key);
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Gemini returned no summary');
  return JSON.parse(content);
}

async function geminiEmbedBatch(texts, key) {
  const out = new Array(texts.length);
  const CHUNK = 100; // Gemini caps batchEmbedContents at 100 requests.
  for (let i = 0; i < texts.length; i += CHUNK) {
    const slice = texts.slice(i, i + CHUNK);
    const data = await geminiPost(`/models/${GEMINI_EMBED_MODEL}:batchEmbedContents`, {
      requests: slice.map((t) => ({
        model: `models/${GEMINI_EMBED_MODEL}`,
        content: { parts: [{ text: clipForLLM(t, 6000) }] },
        outputDimensionality: DIM,
      })),
    }, key);
    const embeddings = data.embeddings || [];
    for (let j = 0; j < embeddings.length; j++) out[i + j] = embeddings[j].values;
  }
  return out;
}

async function geminiChat({ system, user, key, temperature = 0.3 }) {
  const data = await geminiPost(`/models/${GEMINI_CHAT_MODEL}:generateContent`, {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature },
  }, key);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function geminiChatStream({ system, user, key, onToken, signal, temperature = 0.3 }) {
  const res = await retryable(async () => {
    const r = await fetch(`${GEMINI_BASE}/models/${GEMINI_CHAT_MODEL}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature },
      }),
      signal,
    });
    if (!r.ok) {
      const t = await r.text();
      const err = new Error(`Gemini stream ${r.status}: ${t.slice(0, 300)}`);
      err.status = r.status;
      throw err;
    }
    return r;
  });
  let acc = '';
  for await (const chunk of sseLines(res.body)) {
    try {
      const text = JSON.parse(chunk).candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) { acc += text; onToken?.(text, acc); }
    } catch { /* skip malformed */ }
  }
  return acc;
}

async function geminiTestKey(key) {
  await geminiPost(`/models/${GEMINI_EMBED_MODEL}:embedContent`, {
    content: { parts: [{ text: 'ping' }] },
    outputDimensionality: DIM,
  }, key);
}

// ---------- context formatting ----------

function humanRelativeTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 0) {
    const future = -s;
    if (future < 3600) return `in ${Math.floor(future / 60)} min`;
    if (future < 86400) return `in ${Math.floor(future / 3600)}h`;
    return `in ${Math.floor(future / 86400)}d`;
  }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400 / 7)}w ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function hasMeaningfulContent(m) {
  const title = (m.title || '').trim().toLowerCase();
  const summary = (m.summary || '').trim();
  if (!summary) return false;
  if (summary.toLowerCase() === title) return false;
  if (summary.length < 40) return false;
  return true;
}

/**
 * Build the context block handed to the model.
 *
 * The key change from earlier versions: when retrieval supplies an `evidence`
 * passage — the chunk that actually matched the query — that passage is what
 * the model sees. Previously every snippet was the first ~1800 characters of
 * the document regardless of what was asked, so a question about something
 * halfway through a long page was answered from its introduction.
 */
export function formatContext(memories, { budget = 9000 } = {}) {
  const perItem = Math.max(400, Math.floor(budget / Math.max(1, memories.length)));
  return memories.map((m, i) => {
    const when = humanRelativeTime(m.createdAt);
    const sourceTag = m.sourceKind ? ` [${m.sourceKind}]` : '';
    const hasContent = hasMeaningfulContent(m) || !!m.evidence;
    const contentTag = hasContent ? ' [content]' : ' [title-only]';
    let body = '';
    if (hasContent) {
      if (m.evidence) {
        // Lead with the summary for orientation, then the matched passage.
        if (m.summary && m.summary !== m.title) body += `\n${m.summary}`;
        body += `\n\nMatched passage:\n${m.evidence.slice(0, perItem)}`;
      } else {
        body = `\n${m.summary}`;
        if (m.text && m.text !== m.summary && m.text !== m.title) {
          const remaining = Math.max(0, perItem - body.length);
          const extra = m.text.slice(0, remaining).trim();
          if (extra && extra !== m.summary) body += `\n\n${extra}`;
        }
      }
    }
    const facts = hasContent && (m.keyFacts || []).length > 0
      ? `\nKey facts: ${m.keyFacts.join(' • ')}`
      : '';
    const author = m.author ? ` · by ${m.author}` : '';
    return `[#${i + 1}] (${when}${sourceTag}${contentTag}${author}) ${m.title}\n${m.url}${body}${facts}`;
  }).join('\n\n');
}

// ---------- public API ----------

export async function summarize({ title, url, text }) {
  return viaChain(async (provider, key) => {
    if (provider === 'local') return local.summarize({ title, url, text });
    const raw = provider === 'openai'
      ? await openaiSummarize({ title, url, text, key })
      : await geminiSummarize({ title, url, text, key });
    return {
      summary: raw.summary || '',
      tags: (raw.tags || []).slice(0, 6),
      keyFacts: (raw.keyFacts || []).slice(0, 5),
      contentType: CONTENT_TYPES.includes(raw.contentType) ? raw.contentType : 'other',
      entities: (raw.entities || [])
        .filter((e) => e && e.name && ENTITY_KINDS.includes(e.kind))
        .slice(0, 12),
    };
  }, { label: 'summarize' });
}

// Small LRU of query embeddings, keyed by provider + text. Saves a round-trip
// when the user re-asks a question or retries after a rate limit.
const EMBED_CACHE_MAX = 50;
const embedCache = new Map();
function cacheKey(provider, text) { return `${provider}␟${text}`; }
function cacheGet(provider, text) {
  const k = cacheKey(provider, text);
  if (!embedCache.has(k)) return null;
  const v = embedCache.get(k);
  embedCache.delete(k);
  embedCache.set(k, v); // refresh LRU position
  return v;
}
function cacheSet(provider, text, v) {
  const k = cacheKey(provider, text);
  embedCache.delete(k);
  embedCache.set(k, v);
  if (embedCache.size > EMBED_CACHE_MAX) embedCache.delete(embedCache.keys().next().value);
}
export function clearEmbedCache() { embedCache.clear(); }

/**
 * Embed one or more texts. Returns { vectors, space, provider } — callers
 * need the space to store alongside the vectors so the index never compares
 * across embedding models.
 */
export async function embedMany(texts) {
  if (!texts || texts.length === 0) return { vectors: [], space: null, provider: null };
  return viaChain(async (provider, key) => {
    if (provider === 'local') {
      return { vectors: local.embedBatch(texts), space: local.LOCAL_SPACE, provider };
    }
    const space = spaceOf(provider);
    const CHUNK = provider === 'openai' ? 256 : 100;
    // Gemini's free tier allows roughly 15 requests per minute; pacing keeps
    // a large scan under the cap instead of burning the quota in seconds.
    const interBatchDelay = provider === 'openai' ? 0 : 4500;
    const out = new Array(texts.length);
    for (let i = 0; i < texts.length; i += CHUNK) {
      const slice = texts.slice(i, i + CHUNK);
      const vectors = provider === 'openai'
        ? await openaiEmbedBatch(slice, key)
        : await geminiEmbedBatch(slice, key);
      for (let j = 0; j < vectors.length; j++) out[i + j] = vectors[j];
      if (interBatchDelay > 0 && i + CHUNK < texts.length) {
        await new Promise((r) => setTimeout(r, interBatchDelay));
      }
    }
    return { vectors: out, space, provider };
  }, { label: 'embed' });
}

/** Single embedding with an LRU cache. Returns { vector, space, provider }. */
export async function embedOne(text) {
  const provider = await effectiveProvider();
  const cached = cacheGet(provider, text);
  if (cached) return cached;
  const { vectors, space, provider: used } = await embedMany([text]);
  const result = { vector: vectors[0], space, provider: used };
  if (vectors[0]) cacheSet(used, text, result);
  return result;
}

/** Back-compat: bare vector, no space tag. Prefer embedOne. */
export async function embed(text) {
  return (await embedOne(text)).vector;
}

export async function embedForMemory({ title, summary, tags, text }) {
  const composed = [
    title,
    summary,
    Array.isArray(tags) ? tags.join(', ') : '',
    text?.slice(0, 2000) || '',
  ].filter(Boolean).join('\n\n');
  return embedOne(composed);
}

/** Back-compat wrapper returning bare vectors. */
export async function embedBatch(texts) {
  return (await embedMany(texts)).vectors;
}

export async function answerFromMemories({ question, memories }) {
  const context = formatContext(memories);
  return viaChain(async (provider, key) => {
    const user = `Question: ${question}\n\n---\n${context}`;
    if (provider === 'local') {
      return local.generate({ system: ANSWER_SYSTEM, prompt: user, maxChars: 2000 });
    }
    return provider === 'openai'
      ? openaiChat({ system: ANSWER_SYSTEM, user, key })
      : geminiChat({ system: ANSWER_SYSTEM, user, key });
  }, { label: 'answer' });
}

/**
 * Streaming answer. `history` carries prior conversation turns so follow-up
 * questions have something to refer back to.
 */
export async function answerFromMemoriesStreaming({ question, memories, history = [], onToken, signal }) {
  return viaChain(async (provider, key) => {
    const budget = provider === 'local' ? 2600 : 9000;
    const context = formatContext(memories, { budget });
    const priorTurns = history.length
      ? 'Earlier in this conversation:\n' + history.map((t) => `Q: ${t.question}\nA: ${t.answer.slice(0, 400)}`).join('\n\n') + '\n\n---\n'
      : '';
    const user = `${priorTurns}Question: ${question}\n\n---\n${context}`;
    console.log(`[mem] recall via ${provider}`);
    if (provider === 'local') {
      return local.answerStream({ system: ANSWER_SYSTEM, question, context: `${priorTurns}${context}`, onToken, signal });
    }
    return provider === 'openai'
      ? openaiChatStream({ system: ANSWER_SYSTEM, user, key, onToken, signal })
      : geminiChatStream({ system: ANSWER_SYSTEM, user, key, onToken, signal });
  }, { label: 'recall' });
}

// ---------- daily narrative ----------

const NARRATIVE_SYSTEM = `You are writing the user's daily journal in their own voice. The structured data below lists what they read, watched, communicated about, and have to do today, plus what's coming up.

Write 2-3 short paragraphs in flowing prose. Be specific and substantive — pull real detail from every [content] item. Generic summaries that just name the title are wrong.

EXAMPLE OF THE LEVEL OF DETAIL YOU SHOULD HIT

DATA INPUT:
- [content] "Why spaced repetition beats cramming" · 1h ago
  detail: Reviews material at expanding intervals, exploiting the spacing effect to consolidate memory more durably than cramming. Anki and SuperMemo automate scheduling.
- [content] "Re: project meeting Thursday 3pm" · Jamie Chen · 4h ago
  detail: Confirmed for Thursday 3pm in the Bio lab. Bring your unit 3 notes.
- [content] "Bio lab — project presentation" · Calendar · in 24h
  detail: Bio lab project presentation. Bring slides + cell respiration model. Attendees: Jamie Chen, Mr. Patel.

GOOD OUTPUT:
"You started the morning on Andy Matuschak's piece on spaced repetition — the spacing effect, he argues, is one of the most robust findings in cognitive science, and tools like Anki automate the interval scheduling so you can offload it from working memory. Jamie Chen wrote 4h ago to confirm the project meeting moves to Thursday at 3pm in the Bio lab and asked you to bring your unit 3 notes.

Coming up tomorrow is the Bio lab project presentation with Jamie Chen and Mr. Patel — you'll need slides plus the cell respiration model."

WHY THAT'S GOOD: it weaves in actual details from the snippets. It doesn't just say "you read about spaced repetition and got an email and have a meeting".

RULES
- [content] items: describe what was IN the page/email/event using the snippet detail. Be substantive.
- [title-only] items: just name them — don't invent.
- Use specific titles, names, course names, attendees, times.
- Quote relative times exactly ("1h ago", "in 24h").
- No headings or bullets — flowing prose.`;

function formatDailyForLLM(summaryData) {
  const { groups, dayLabel, humanRelative } = summaryData;
  const lines = [`# ${dayLabel}`];
  const sections = [
    ['read', 'Read today'],
    ['watched', 'Watched today'],
    ['communicated', 'Communicated about'],
    ['toDo', 'Calendar / to do'],
    ['classroom', 'Classroom'],
    ['other', 'Other'],
  ];
  for (const [key, label] of sections) {
    if (!groups[key] || groups[key].length === 0) continue;
    lines.push(`\n${label}:`);
    for (const m of groups[key]) {
      const due = m.extra?.due;
      const isUpcoming = (due && due > Date.now()) || m.createdAt > Date.now();
      const when = humanRelative(isUpcoming ? (due || m.createdAt) : m.createdAt);
      const hasContent = hasMeaningfulContent(m);
      const contentTag = hasContent ? '[content]' : '[title-only]';
      const author = m.author ? ` · ${m.author}` : '';
      const extras = [];
      if (m.extra?.courseName) extras.push(`course: ${m.extra.courseName}`);
      if (m.extra?.submitted === false && m.extra?.due) extras.push('NOT TURNED IN');
      if (m.extra?.submitted === true) extras.push('turned in');
      const meta = extras.length ? ` (${extras.join(', ')})` : '';
      lines.push(`- ${contentTag} ${m.title}${author} — ${when}${meta}`);
      if (hasContent) {
        lines.push(`  detail: ${m.summary.slice(0, 320)}`);
        if ((m.keyFacts || []).length > 0) lines.push(`  facts: ${m.keyFacts.slice(0, 3).join(' • ')}`);
      }
    }
  }
  return lines.join('\n');
}

export async function dailyNarrativeStreaming(summaryData, { onToken, signal } = {}) {
  const data = formatDailyForLLM(summaryData);
  return viaChain(async (provider, key) => {
    console.log(`[mem] daily narrative via ${provider}`);
    if (provider === 'local') {
      return local.answerStream({
        system: NARRATIVE_SYSTEM,
        question: 'Write the journal entry.',
        context: data,
        onToken,
        signal,
      });
    }
    return provider === 'openai'
      ? openaiChatStream({ system: NARRATIVE_SYSTEM, user: data, key, onToken, signal, temperature: 0.5 })
      : geminiChatStream({ system: NARRATIVE_SYSTEM, user: data, key, onToken, signal, temperature: 0.5 });
  }, { label: 'narrative' });
}

// ---------- small utility generations ----------

/**
 * Rewrite a follow-up into a standalone query.
 *
 * Without this, multi-turn conversation cannot work: "why?" embeds to
 * nothing useful and retrieves nothing. Resolving it against the prior turns
 * first is what lets the second and third questions in a thread actually
 * find their sources.
 */
export async function rewriteQuery({ question, history }) {
  if (!history || history.length === 0) return question;
  const convo = history.map((t) => `Q: ${t.question}\nA: ${(t.answer || '').slice(0, 300)}`).join('\n\n');
  const system = `Rewrite the user's latest question so it stands alone without the conversation. Resolve pronouns and references ("it", "that", "why", "the second one") into explicit terms drawn from the conversation. Keep it short — this is a search query, not a sentence. Output only the rewritten query, nothing else. If the question already stands alone, output it unchanged.`;
  const user = `${convo}\n\nLatest question: ${question}\n\nStandalone query:`;
  try {
    const out = await viaChain(async (provider, key) => {
      if (provider === 'local') return local.generate({ system, prompt: user, maxChars: 200 });
      return provider === 'openai'
        ? openaiChat({ system, user, key, temperature: 0 })
        : geminiChat({ system, user, key, temperature: 0 });
    }, { label: 'rewrite' });
    const cleaned = (out || '').trim().replace(/^["']|["']$/g, '').split('\n')[0];
    return cleaned.length > 2 && cleaned.length < 300 ? cleaned : question;
  } catch {
    // A failed rewrite must never block the actual question.
    return question;
  }
}

/** One-line title + one-sentence gist for a cluster of memories. */
export async function nameCluster({ items, kind = 'session' }) {
  const listing = items.slice(0, 18).map((m) => `- ${m.title}${m.summary && m.summary !== m.title ? ` — ${m.summary.slice(0, 140)}` : ''}`).join('\n');
  const system = `You name clusters of a person's activity. Reply with JSON only: {"title": string, "gist": string}.
title: 3-6 words naming what this ${kind} was about, in the user's voice ("Debugging the auth redirect", "Reading up on perovskites"). No quotes, no trailing punctuation.
gist: one sentence, max 20 words, saying what they were actually doing.
Be concrete. Never use the words "various", "miscellaneous", or "assorted".`;
  const user = `Items in this ${kind}:\n${listing}\n\nJSON:`;
  const schema = {
    type: 'object',
    properties: { title: { type: 'string' }, gist: { type: 'string' } },
    required: ['title', 'gist'],
    additionalProperties: false,
  };
  return viaChain(async (provider, key) => {
    if (provider === 'local') {
      const j = await local.generateJson({ system, prompt: user, schema });
      if (!j?.title) throw new Error('no cluster name');
      return { title: String(j.title).slice(0, 80), gist: String(j.gist || '').slice(0, 200) };
    }
    if (provider === 'openai') {
      const data = await openaiPost('/chat/completions', {
        model: OPENAI_CHAT_MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_schema', json_schema: { name: 'cluster_name', strict: true, schema } },
        temperature: 0.3,
      }, key);
      const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
      return { title: String(parsed.title || '').slice(0, 80), gist: String(parsed.gist || '').slice(0, 200) };
    }
    const data = await geminiPost(`/models/${GEMINI_CHAT_MODEL}:generateContent`, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { title: { type: 'STRING' }, gist: { type: 'STRING' } },
          required: ['title', 'gist'],
        },
      },
    }, key);
    const parsed = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
    return { title: String(parsed.title || '').slice(0, 80), gist: String(parsed.gist || '').slice(0, 200) };
  }, { label: 'nameCluster' });
}

// ---------- key testing ----------

export async function testKey({ provider, key } = {}) {
  if (!provider) provider = await currentProvider();
  if (provider === 'local') {
    const s = await local.status();
    if (!s.ready) throw new Error(s.supported ? 'On-device model is not ready yet.' : 'This browser has no built-in AI.');
    return;
  }
  if (!key) key = await keyFor(provider);
  if (!key) {
    const err = new Error(`No ${PROVIDER[provider].name} key set.`);
    err.code = 'NO_API_KEY';
    throw err;
  }
  if (provider === 'openai') return openaiTestKey(key);
  return geminiTestKey(key);
}

export { local, ANSWER_SYSTEM, CONTENT_TYPES, ENTITY_KINDS };
