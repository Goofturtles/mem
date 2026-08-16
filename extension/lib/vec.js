// Vector math for mem's retrieval index.
//
// Three ideas carry the whole file:
//
//   1. Every vector is L2-normalised at write time. That turns cosine
//      similarity into a plain dot product, which removes two square roots
//      and a division from the innermost loop of every query.
//
//   2. The corpus-wide scan runs over int8-quantised vectors packed into one
//      contiguous typed array — 4× less memory than Float32 and 16× less than
//      the plain JS number arrays mem used to keep in IndexedDB, and one
//      binary structured-clone read instead of N. Each vector carries its own
//      scale rather than sharing a global one: at 1536 dimensions a unit
//      vector's typical component is around 0.025, so a fixed scale of 127
//      would map it to ±3 and throw away most of the int8 range. See
//      quantize() for the measured difference.
//
//   3. Candidates that survive the approximate scan get rescored against
//      exact Float32 vectors. Approximate-then-exact is the standard shape
//      for this; it means quantisation error can cost us ordering inside the
//      candidate set but never silently drops a document from it.

export const QUANT_SCALE = 127;

// Width of every vector mem stores. Both cloud providers are configured to
// emit this, and the on-device embedder targets it too, so a single packed
// matrix serves all of them. Quantisation is what makes the width affordable;
// shrinking the width instead would have stranded every embedding written
// before v2.
export const DIM = 1536;

// ---------- construction ----------

/** Copy any array-like of numbers into a Float32Array. */
export function toFloat32(a) {
  if (a instanceof Float32Array) return a;
  if (!a) return null;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i];
  return out;
}

/**
 * L2-normalise into a new Float32Array. A zero vector stays zero — callers
 * treat an all-zero vector as "no embedding" rather than dividing by zero.
 */
export function normalize(a) {
  const v = toFloat32(a);
  if (!v || v.length === 0) return v;
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  if (sum === 0) return v;
  const inv = 1 / Math.sqrt(sum);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

/** True when every component is zero (our sentinel for "not embedded"). */
export function isZero(v) {
  if (!v || v.length === 0) return true;
  for (let i = 0; i < v.length; i++) if (v[i] !== 0) return false;
  return true;
}

// ---------- quantisation ----------

/**
 * Float32 → Int8 with a per-vector scale.
 *
 * The scale matters more than it looks. Components of a unit vector shrink
 * as 1/√dim, so at 1536 dimensions a typical component is around 0.025. A
 * fixed scale of 127 would map that to ±3 — roughly seven usable levels out
 * of 255, and similarity error over a percent, which the test harness
 * measured directly. Scaling by the vector's own largest component instead
 * spends the full int8 range on the values actually present, cutting that
 * error by about an order of magnitude for the same storage.
 *
 * Returns { q, scale } where v[i] ≈ q[i] * scale.
 */
export function quantize(v) {
  const q = new Int8Array(v.length);
  let maxAbs = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i] < 0 ? -v[i] : v[i];
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs === 0) return { q, scale: 0 };
  const inv = QUANT_SCALE / maxAbs;
  for (let i = 0; i < v.length; i++) {
    let x = Math.round(v[i] * inv);
    if (x > 127) x = 127;
    else if (x < -127) x = -127;
    q[i] = x;
  }
  return { q, scale: maxAbs / QUANT_SCALE };
}

/** Int8 + scale → approximate Float32. Inverse of quantize, minus rounding. */
export function dequantize(q, scale) {
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i] * scale;
  return out;
}

// ---------- similarity ----------

/** Dot product of two equal-length vectors. Zero when lengths disagree. */
export function dot(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Cosine similarity for vectors that may not be normalised. Prefer dot() on
 * anything that came out of the index — those are normalised already.
 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : d / denom;
}

/**
 * Score a quantised query against `count` quantised vectors packed
 * back-to-back in `matrix`. Returns a Float32Array of approximate cosine
 * similarities, one per row.
 *
 * The division by QUANT_SCALE² is hoisted out of the loop; the inner loop is
 * integer multiply-accumulate, which is the fastest thing we can do here
 * without SIMD.
 */
export function scanPacked(queryQ, queryScale, matrix, scales, dim, count) {
  const scores = new Float32Array(count);
  if (!queryQ || queryQ.length !== dim || !matrix || !queryScale) return scores;
  for (let row = 0; row < count; row++) {
    const rowScale = scales[row];
    if (!rowScale) continue;
    const base = row * dim;
    let s = 0;
    for (let i = 0; i < dim; i++) s += queryQ[i] * matrix[base + i];
    scores[row] = s * queryScale * rowScale;
  }
  return scores;
}

/** Read row `row` out of a packed matrix as its own Int8Array view. */
export function rowOf(matrix, dim, row) {
  return matrix.subarray(row * dim, row * dim + dim);
}

// ---------- ranking ----------

/**
 * Top-k by score. `allow` optionally filters by row index — used to apply a
 * time-window prefilter without materialising a second array.
 *
 * Linear scan with a small insertion-sorted buffer: for the k≈60 we use, this
 * beats sorting the whole score array by a wide margin.
 */
export function topK(scores, k, allow = null) {
  const out = [];
  for (let i = 0; i < scores.length; i++) {
    if (allow && !allow(i)) continue;
    const s = scores[i];
    if (out.length < k) {
      out.push({ i, score: s });
      if (out.length === k) out.sort((a, b) => b.score - a.score);
      continue;
    }
    if (s <= out[k - 1].score) continue;
    // Insert into the sorted buffer, drop the tail.
    let pos = k - 1;
    while (pos > 0 && out[pos - 1].score < s) pos--;
    out.splice(pos, 0, { i, score: s });
    out.length = k;
  }
  if (out.length < k) out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Reciprocal Rank Fusion.
 *
 * Takes several ranked lists and merges them by summing 1/(K + rank). It
 * needs no score normalisation, which matters here because BM25 scores are
 * unbounded and cosine scores live in [-1, 1] — the old code's
 * `0.7 * cosine + 0.3 * normalisedLexical` blend was comparing quantities
 * with no shared meaning, so one strong lexical hit could distort the whole
 * ranking. Rank position is the only thing RRF trusts.
 *
 * K = 60 is the constant from the original RRF paper; it damps the
 * difference between rank 1 and rank 2 so a single list can't dominate.
 *
 * lists: [{ ids: string[], weight?: number }]
 * Returns [{ id, score, ranks: { [listName]: rank } }] sorted descending.
 */
export function rrf(lists, { k = 60 } = {}) {
  const acc = new Map();
  for (const list of lists) {
    const weight = list.weight ?? 1;
    const name = list.name || 'list';
    for (let rank = 0; rank < list.ids.length; rank++) {
      const id = list.ids[rank];
      let e = acc.get(id);
      if (!e) { e = { id, score: 0, ranks: {} }; acc.set(id, e); }
      e.score += weight / (k + rank + 1);
      e.ranks[name] = rank + 1;
    }
  }
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

/**
 * Maximal Marginal Relevance.
 *
 * Greedily picks the item that maximises
 *   lambda * relevance - (1 - lambda) * maxSimilarityToAlreadyPicked
 *
 * This is what stops six near-identical history rows for the same article
 * from consuming every context slot handed to the model. lambda = 1 is pure
 * relevance (no diversification); lambda = 0 is pure novelty.
 *
 * items:  [{ id, score, vec? }]
 * getVec: optional accessor if vectors aren't inline on the items
 */
export function mmr(items, { lambda = 0.7, k = 8, getVec = null } = {}) {
  if (items.length === 0) return [];
  const vecOf = (it) => (getVec ? getVec(it) : it.vec);

  // Relevance is compared against similarity, which lives in [-1, 1], so
  // scores are scaled into [0, 1] to make lambda mean the same thing whether
  // the input is an RRF sum, a cosine, or a BM25 value.
  //
  // Divide by the maximum rather than min-max normalising. Min-max pins the
  // lowest-scoring item at exactly zero, which means it can never win on
  // novelty no matter how different it is — with lambda 0.7 it would need a
  // diversity bonus of 0.7 against a maximum available bonus of 0.3. In a
  // small candidate pool that is precisely the item worth surfacing, so
  // min-max quietly defeated the purpose of running MMR at all.
  const scores = items.map((it) => it.score);
  const max = Math.max(...scores);
  const rel = max > 0
    ? items.map((it) => Math.max(0, it.score) / max)
    // All-zero or negative scores carry no relevance signal; fall back to
    // rank order so the pass still diversifies rather than dividing by zero.
    : items.map((_, i) => 1 - i / items.length);

  const picked = [];
  const pickedVecs = [];
  const remaining = items.map((_, i) => i);

  while (picked.length < Math.min(k, items.length) && remaining.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let r = 0; r < remaining.length; r++) {
      const i = remaining[r];
      let maxSim = 0;
      const v = vecOf(items[i]);
      if (v && pickedVecs.length > 0) {
        for (const pv of pickedVecs) {
          if (!pv) continue;
          const s = dot(v, pv);
          if (s > maxSim) maxSim = s;
        }
      }
      const val = lambda * rel[i] - (1 - lambda) * maxSim;
      if (val > bestVal) { bestVal = val; bestIdx = r; }
    }
    const chosen = remaining.splice(bestIdx, 1)[0];
    picked.push(items[chosen]);
    pickedVecs.push(vecOf(items[chosen]));
  }
  return picked;
}
