// Reciprocal rank fusion, following Pinecone's documented method:
// https://docs.pinecone.io/guides/search/reciprocal-rank-fusion
//
// RRF is client-side by design — it works on the results of any Pinecone
// search. This matches the documented formula: sum 1 / (k + rank) over every
// list a document appears in, with 1-based rank and k = 60.
//
// Split out of snacksPinecone.ts so it can be tested without credentials:
// that module builds a Pinecone client at import time, so importing it
// requires a real API key. Fusion is arithmetic over two lists and
// shouldn't need one.

export interface RankedId {
  id: string;
  score: number;
  source: "dense" | "bm25" | "fused";
}

/** The constant from the original RRF paper, and the value Pinecone's docs
 * use. Large enough that the difference between rank 1 and rank 2 doesn't
 * swamp the contribution of appearing in both lists at all — which is the
 * signal fusion exists to reward. */
export const RRF_K = 60;

/**
 * Combines the dense and BM25 rankings into one ordered list. Each list
 * contributes `1 / (K + rank)` using 1-based rank, so an id present in both
 * gets both contributions and outranks an id that only one retriever liked.
 *
 * Ranks are fused, not scores. Cosine similarity and BM25 are on different
 * scales with no meaningful conversion, so as Pinecone's guide puts it,
 * adding or averaging the raw scores is not meaningful and one signal
 * usually dominates. Fusing positions needs no normalization or weighting.
 * An id in both lists is relabeled "fused"; an id from a single list keeps
 * that list's own source, so the UI can say where a result came from.
 */
export function reciprocalRankFuse(dense: RankedId[], bm25: RankedId[]): RankedId[] {
  const scores = new Map<string, { score: number; inBoth: boolean; source: RankedId["source"] }>();
  const add = (list: RankedId[]) => {
    list.forEach((hit, i) => {
      const rrf = 1 / (RRF_K + i + 1);
      const existing = scores.get(hit.id);
      if (existing) {
        existing.score += rrf;
        existing.inBoth = true;
      } else {
        scores.set(hit.id, { score: rrf, inBoth: false, source: hit.source });
      }
    });
  };
  add(dense);
  add(bm25);
  return Array.from(scores.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .map(([id, v]) => ({ id, score: v.score, source: v.inBoth ? "fused" : v.source }));
}
