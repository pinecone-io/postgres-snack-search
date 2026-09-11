import { describe, expect, it } from "vitest";
import { reciprocalRankFuse, RRF_K, type RankedId } from "@/lib/rrf";

const dense = (...ids: string[]): RankedId[] => ids.map((id) => ({ id, score: 0, source: "dense" }));
const bm25 = (...ids: string[]): RankedId[] => ids.map((id) => ({ id, score: 0, source: "bm25" }));

/** The contribution one list makes for a given 1-based rank. */
const rrf = (rank: number) => 1 / (RRF_K + rank);

describe("reciprocalRankFuse", () => {
  it("scores each id as the sum of 1/(K+rank) over the lists it appears in", () => {
    const fused = reciprocalRankFuse(dense("a", "b", "c"), bm25("c", "a", "d"));
    const byId = new Map(fused.map((f) => [f.id, f]));

    expect(byId.get("a")!.score).toBeCloseTo(rrf(1) + rrf(2), 12);
    expect(byId.get("c")!.score).toBeCloseTo(rrf(3) + rrf(1), 12);
    expect(byId.get("b")!.score).toBeCloseTo(rrf(2), 12);
    expect(byId.get("d")!.score).toBeCloseTo(rrf(3), 12);
  });

  it("orders by fused score, not by either list's own ranking", () => {
    // "c" is only third for dense but first for BM25, which is enough to put
    // it ahead of "b" (second for dense, absent from BM25) — and behind "a",
    // which placed highly in both.
    const fused = reciprocalRankFuse(dense("a", "b", "c"), bm25("c", "a", "d"));
    expect(fused.map((f) => f.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("ranks an id both retrievers merely liked above one a single retriever loved", () => {
    // This is the whole reason fusion exists, so it's worth pinning: being
    // third on both lists beats being first on one and absent from the other.
    const fused = reciprocalRankFuse(dense("solo", "x", "agreed"), bm25("y", "z", "agreed"));
    expect(fused[0].id).toBe("agreed");
    expect(fused[0].score).toBeCloseTo(rrf(3) + rrf(3), 12);
    expect(fused[0].score).toBeGreaterThan(rrf(1));
  });

  it("labels ids found by both retrievers 'fused' and keeps the single source otherwise", () => {
    const fused = reciprocalRankFuse(dense("a", "b"), bm25("a", "d"));
    const source = new Map(fused.map((f) => [f.id, f.source]));
    expect(source.get("a")).toBe("fused");
    expect(source.get("b")).toBe("dense");
    expect(source.get("d")).toBe("bm25");
  });

  it("returns each id exactly once even when both lists contain it", () => {
    const fused = reciprocalRankFuse(dense("a", "b", "c"), bm25("a", "b", "c"));
    expect(fused).toHaveLength(3);
    expect(new Set(fused.map((f) => f.id)).size).toBe(3);
  });

  it("passes a single list through in order when the other is empty", () => {
    expect(reciprocalRankFuse(dense("a", "b"), []).map((f) => f.id)).toEqual(["a", "b"]);
    expect(reciprocalRankFuse([], bm25("a", "b")).map((f) => f.source)).toEqual(["bm25", "bm25"]);
  });

  it("handles two empty lists", () => {
    expect(reciprocalRankFuse([], [])).toEqual([]);
  });

  it("ignores the incoming per-list scores entirely, using only rank", () => {
    // Pinecone's dense scores and BM25 scores aren't on a comparable scale,
    // which is why fusion reads position instead. A wildly different input
    // score must not change the outcome.
    const a = reciprocalRankFuse(dense("a", "b"), bm25("b", "a"));
    const b = reciprocalRankFuse(
      [
        { id: "a", score: 999, source: "dense" },
        { id: "b", score: -5, source: "dense" },
      ],
      [
        { id: "b", score: 0.001, source: "bm25" },
        { id: "a", score: 42, source: "bm25" },
      ],
    );
    expect(a).toEqual(b);
  });
});
