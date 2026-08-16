// Text processing shared by chunking, BM25, and the on-device embedder.
//
// The chunker is the piece that matters most. Until now a 60,000-character
// document got exactly one embedding, computed over its title plus the first
// 2,000 characters — so a fact on page 12 was semantically unreachable no
// matter how the user phrased the question. Chunking makes the whole document
// addressable.

// ---------- tokenisation ----------

// Deliberately short list. Aggressive stopword removal hurts BM25 on the kind
// of short, entity-heavy text mem indexes (titles, subjects, event names), so
// this only drops words that carry essentially no discriminative weight.
export const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'at', 'by', 'for', 'with',
  'to', 'from', 'in', 'on', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'as', 'so', 'than', 'then',
  'there', 'here', 'i', 'you', 'we', 'they', 'he', 'she', 'my', 'your', 'our',
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could',
  'should', 'about', 'into', 'over', 'up', 'out', 'no', 'not',
]);

/**
 * Lowercase word tokens.
 *
 * Unicode-aware on purpose. An ASCII-only pattern produced *zero* tokens for
 * Cyrillic, Greek, Hebrew, Arabic and Devanagari text, and mangled accented
 * Latin ("café" → "caf"), so those memories had no BM25 representation at all
 * and were unfindable by any word they actually contained.
 *
 * CJK is handled separately: it isn't space-delimited and has no letter
 * boundaries to match on, so each character becomes its own token. That is a
 * crude form of the bigram indexing real CJK search uses, but it makes the
 * text searchable instead of invisible.
 */
/**
 * Bump whenever tokenize() or contentTokens() changes what they produce.
 *
 * BM25 postings and every hashed local embedding on disk were produced by the
 * analyzer of their day. If queries start using a different one, terms
 * silently stop matching documents that do contain them — a failure that
 * looks like bad relevance rather than a bug. The index stores this version
 * and rebuilds itself locally (no API calls) when it doesn't match.
 *
 * 1 → ASCII-only, non-Latin scripts produced no tokens at all.
 * 2 → Unicode-aware, with CJK split per character and mixed runs preserved.
 */
export const ANALYZER_VERSION = 2;

// A single character is enough to be a token, because a CJK character is a
// token on its own; length filtering happens in contentTokens.
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’·-]*/gu;
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;

export function tokenize(s) {
  const lower = (s || '').toLowerCase();
  const words = lower.match(WORD_RE) || [];
  if (!CJK_RE.test(lower)) return words.filter((w) => w.length >= 2);

  // Mixed scripts are the norm, not the exception — "Windows11の設定" matches
  // as one word. Splitting the CJK characters out while discarding the rest
  // would throw away exactly the most searchable tokens (product names,
  // years, model numbers), so each run is emitted separately: Latin and digit
  // runs as words, CJK characters individually.
  const out = [];
  for (const w of words) {
    if (!CJK_RE.test(w)) {
      if (w.length >= 2) out.push(w);
      continue;
    }
    let run = '';
    for (const ch of w) {
      if (CJK_RE.test(ch)) {
        if (run.length >= 2) out.push(run);
        run = '';
        out.push(ch);
      } else {
        run += ch;
      }
    }
    if (run.length >= 2) out.push(run);
  }
  return out;
}

/** Tokens with stopwords removed — what the index actually stores. */
export function contentTokens(s) {
  const out = [];
  for (const t of tokenize(s)) {
    // Single characters survive only for CJK, where one character is a
    // meaningful token; elsewhere they carry no signal.
    if (t.length < 2 && !CJK_RE.test(t)) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

/** Adjacent token pairs. Cheap way to give a bag-of-words model some order. */
export function bigrams(tokens) {
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i++) out.push(tokens[i] + '_' + tokens[i + 1]);
  return out;
}

/**
 * Character n-grams of a single token. Gives the on-device embedder partial
 * credit for morphology — "mitochondria" and "mitochondrial" share most of
 * their 4-grams, so they land near each other without any learned model.
 */
export function charNgrams(token, n = 4) {
  if (token.length <= n) return [token];
  const out = [];
  for (let i = 0; i + n <= token.length; i++) out.push(token.slice(i, i + n));
  return out;
}

/**
 * FNV-1a, 32-bit. Deterministic across sessions and machines, which the
 * on-device embedder depends on — a vector written today has to stay
 * comparable to one written next month.
 */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------- chunking ----------

const DEFAULTS = {
  target: 1100,   // aim for chunks of about this many characters
  max: 1800,      // hard ceiling before a chunk is force-split
  min: 260,       // below this, fold into the neighbouring chunk
  overlap: 180,   // characters of trailing context repeated into the next chunk
};

/**
 * Split `text` into atoms that tile the string exactly: atom[i].end ===
 * atom[i+1].start, atom[0].start === 0, last atom's end === text.length.
 *
 * Exact tiling is what lets the chunker guarantee full coverage — every
 * character belongs to some atom, and every atom belongs to some chunk.
 * Boundaries prefer blank lines, then sentence enders, then single newlines.
 */
function atomize(text, max) {
  const bounds = [];
  const re = /\n[ \t]*\n|(?<=[.!?…][)"'”’\]]*)\s+|\n/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (end > 0 && end < text.length) bounds.push(end);
    if (re.lastIndex === m.index) re.lastIndex++; // zero-width guard
  }
  bounds.push(text.length);

  const atoms = [];
  let start = 0;
  for (const end of bounds) {
    if (end <= start) continue;
    // A single "sentence" longer than the hard ceiling (minified JS, a table
    // with no punctuation, a wall of CJK) gets force-split on whitespace so
    // one pathological run can't produce a giant chunk.
    if (end - start > max) {
      let cursor = start;
      while (end - cursor > max) {
        let cut = text.lastIndexOf(' ', cursor + max);
        if (cut <= cursor) cut = cursor + max;
        else cut += 1;
        atoms.push({ start: cursor, end: cut });
        cursor = cut;
      }
      if (cursor < end) atoms.push({ start: cursor, end });
    } else {
      atoms.push({ start, end });
    }
    start = end;
  }
  if (atoms.length === 0 && text.length > 0) atoms.push({ start: 0, end: text.length });
  return atoms;
}

/**
 * Chunk a document.
 *
 * Returns [{ text, start, end, i }] where `text === source.slice(start, end)`.
 *
 * Guarantees, all asserted by the test harness:
 *   - the union of [start, end) covers [0, text.length)
 *   - chunks are ordered and each is at most `max` characters
 *   - consecutive chunks overlap by roughly `overlap` characters, so a fact
 *     that straddles a boundary survives intact in one of the two
 */
export function chunkText(text, opts = {}) {
  const { target, max, min, overlap } = { ...DEFAULTS, ...opts };
  const src = text || '';
  if (src.length === 0) return [];
  if (src.length <= target) return [{ text: src, start: 0, end: src.length, i: 0 }];

  const atoms = atomize(src, max);
  const chunks = [];
  let cur = [];           // atom indices in the chunk being built
  let curLen = 0;

  const flush = () => {
    if (cur.length === 0) return;
    const start = atoms[cur[0]].start;
    const end = atoms[cur[cur.length - 1]].end;
    chunks.push({ start, end });
    cur = [];
    curLen = 0;
  };

  for (let a = 0; a < atoms.length; a++) {
    const len = atoms[a].end - atoms[a].start;
    if (curLen > 0 && curLen + len > target) {
      flush();
      // Re-open with trailing atoms from the chunk we just closed so the new
      // chunk carries `overlap` characters of lead-in context.
      const prev = chunks[chunks.length - 1];
      let back = a - 1;
      let carried = 0;
      const carry = [];
      while (back >= 0 && atoms[back].start >= prev.start && carried + (atoms[back].end - atoms[back].start) <= overlap) {
        carry.unshift(back);
        carried += atoms[back].end - atoms[back].start;
        back--;
      }
      cur = carry;
      curLen = carried;
    }
    cur.push(a);
    curLen += len;
  }
  flush();

  // Fold a runt tail into its predecessor rather than embedding a fragment
  // that's too short to mean anything on its own.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    if (last.end - last.start < min) {
      chunks[chunks.length - 2].end = last.end;
      chunks.pop();
    }
  }

  // Coverage repair. The overlap logic can only ever move a chunk's start
  // earlier, never later, so gaps shouldn't occur — but a gap would silently
  // make a slice of the document unsearchable, which is exactly the failure
  // this whole module exists to eliminate. Cheap to guarantee, so guarantee it.
  for (let i = 1; i < chunks.length; i++) {
    if (chunks[i].start > chunks[i - 1].end) chunks[i].start = chunks[i - 1].end;
  }
  if (chunks.length > 0) {
    chunks[0].start = 0;
    chunks[chunks.length - 1].end = src.length;
  }

  return chunks.map((c, i) => ({ text: src.slice(c.start, c.end), start: c.start, end: c.end, i }));
}

/**
 * Trim a passage to `maxChars` on a word boundary. Used when handing evidence
 * to the model — we'd rather lose a trailing clause than a leading fact.
 */
export function clipPassage(s, maxChars = 900) {
  const t = (s || '').trim();
  if (t.length <= maxChars) return t;
  const cut = t.lastIndexOf(' ', maxChars);
  return t.slice(0, cut > maxChars * 0.6 ? cut : maxChars).trim() + '…';
}
