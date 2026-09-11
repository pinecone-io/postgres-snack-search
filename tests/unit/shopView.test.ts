import { describe, expect, it } from "vitest";
import {
  buildReceipt,
  deriveCounts,
  flagsForRender,
  gridState,
  mergeFlagAnswers,
  pickFlagQueryIds,
  staleIdsOf,
  countGridStates,
  RECEIPT_DISPLAY_CAP,
  type CatalogItem,
  type FlagEntry,
} from "@/lib/shopView";
import type { LiveSearchFlag } from "@/lib/snacksPinecone";

const item = (id: string, stockQty: number, inIndex: boolean): CatalogItem => ({
  id,
  name: `snack ${id}`,
  category: "savory",
  stockQty,
  inIndex,
});

const catalog = (...items: CatalogItem[]) => new Map(items.map((i) => [i.id, i]));
const flags = (entries: Record<string, LiveSearchFlag>) => new Map(Object.entries(entries));
const cache = (entries: Record<string, FlagEntry>) => new Map(Object.entries(entries));

describe("staleIdsOf", () => {
  it("selects only snacks that are sold out and still believed to be indexed", () => {
    const snacks = [
      item("in-stock-indexed", 3, true),
      item("in-stock-unindexed", 3, false),
      item("stale", 0, true),
      item("gone", 0, false),
    ];
    expect(staleIdsOf(snacks)).toEqual(["stale"]);
  });

  it("returns an empty list for a fully stocked shop", () => {
    expect(staleIdsOf([item("a", 1, true), item("b", 5, true)])).toEqual([]);
  });
});

describe("pickFlagQueryIds", () => {
  it("asks about ids it has never seen", () => {
    expect(pickFlagQueryIds(["a", "b"], cache({}))).toEqual(["a", "b"]);
  });

  it("never re-asks about a document already known to be filtered", () => {
    // "filtered" is terminal until a Restock, which clears the cache — so
    // re-asking would be a pure waste of a Pinecone call.
    const known = cache({ a: { flag: "filtered", checks: 1 } });
    expect(pickFlagQueryIds(["a"], known)).toEqual([]);
  });

  it("keeps asking about a 'hit' until the recheck budget runs out", () => {
    // A just-sold-out document reads as a hit for a poll or two while the
    // flag write propagates, so giving up after one answer would mean the
    // square never turns green.
    expect(pickFlagQueryIds(["a"], cache({ a: { flag: "hit", checks: 1 } }), 5)).toEqual(["a"]);
    expect(pickFlagQueryIds(["a"], cache({ a: { flag: "hit", checks: 4 } }), 5)).toEqual(["a"]);
    expect(pickFlagQueryIds(["a"], cache({ a: { flag: "hit", checks: 5 } }), 5)).toEqual([]);
  });

  it("treats 'absent' as non-terminal, since it is still within the budget", () => {
    expect(pickFlagQueryIds(["a"], cache({ a: { flag: "absent", checks: 1 } }), 5)).toEqual(["a"]);
  });

  it("only asks about ids in the current stale set", () => {
    const known = cache({ old: { flag: "hit", checks: 0 } });
    expect(pickFlagQueryIds(["new"], known)).toEqual(["new"]);
  });
});

describe("mergeFlagAnswers", () => {
  it("records a fresh answer with one check against it", () => {
    const next = mergeFlagAnswers(["a"], cache({}), { a: "filtered" });
    expect(next.get("a")).toEqual({ flag: "filtered", checks: 1 });
  });

  it("advances the check count each time an id is actually answered", () => {
    const first = mergeFlagAnswers(["a"], cache({}), { a: "hit" });
    const second = mergeFlagAnswers(["a"], first, { a: "hit" });
    const third = mergeFlagAnswers(["a"], second, { a: "filtered" });
    expect(first.get("a")).toEqual({ flag: "hit", checks: 1 });
    expect(second.get("a")).toEqual({ flag: "hit", checks: 2 });
    expect(third).toEqual(new Map([["a", { flag: "filtered", checks: 3 }]]));
  });

  it("leaves an id untouched when the response omits it, so it gets asked again", () => {
    // The failure this guards against: counting a check for an unanswered id
    // would burn the recheck budget on nothing, and the document would be
    // marked settled as a "hit" while its flag was already false.
    const known = cache({ a: { flag: "hit", checks: 2 } });
    const next = mergeFlagAnswers(["a"], known, {});
    expect(next.get("a")).toEqual({ flag: "hit", checks: 2 });
    expect(pickFlagQueryIds(["a"], next, 5)).toEqual(["a"]);
  });

  it("drops ids that have left the stale set", () => {
    // Restocked, or actually deleted by night sync — either way the cache
    // must not keep growing.
    const known = cache({ leaving: { flag: "filtered", checks: 1 }, staying: { flag: "hit", checks: 1 } });
    const next = mergeFlagAnswers(["staying"], known, {});
    expect([...next.keys()]).toEqual(["staying"]);
  });

  it("omits an id that is stale but has no answer and no history", () => {
    const next = mergeFlagAnswers(["never-answered"], cache({}), {});
    expect(next.size).toBe(0);
  });

  it("does not mutate the cache it was given", () => {
    const known = cache({ a: { flag: "hit", checks: 1 } });
    mergeFlagAnswers(["a"], known, { a: "filtered" });
    expect(known.get("a")).toEqual({ flag: "hit", checks: 1 });
  });
});

describe("flagsForRender", () => {
  it("reduces the cache to plain flags", () => {
    const entries = cache({ a: { flag: "filtered", checks: 3 }, b: { flag: "hit", checks: 1 } });
    expect(flagsForRender(entries)).toEqual(new Map([["a", "filtered"], ["b", "hit"]]));
  });
});

describe("deriveCounts", () => {
  it("reports the whole catalog before the first poll lands", () => {
    // A shop that looks full until proven otherwise, rather than one that
    // flashes empty on load.
    expect(deriveCounts(new Map(), new Map(), 1160)).toEqual({
      inStock: 1160,
      searchable: 1160,
      returnable: 1160,
    });
  });

  it("counts stock from Postgres and documents from in_index", () => {
    const c = catalog(item("a", 2, true), item("b", 0, true), item("c", 0, false));
    expect(deriveCounts(c, new Map(), 3)).toEqual({ inStock: 1, searchable: 2, returnable: 2 });
  });

  it("subtracts documents Pinecone's own flag excludes from search", () => {
    const c = catalog(item("a", 2, true), item("b", 0, true), item("d", 0, true));
    const f = flags({ b: "filtered", d: "hit" });
    // Three indexed documents, one flagged out: two remain returnable.
    expect(deriveCounts(c, f, 3)).toEqual({ inStock: 1, searchable: 3, returnable: 2 });
  });

  it("also subtracts documents Pinecone no longer has at all", () => {
    const c = catalog(item("a", 0, true), item("b", 0, true));
    expect(deriveCounts(c, flags({ a: "absent", b: "hit" }), 2)).toEqual({
      inStock: 0,
      searchable: 2,
      returnable: 1,
    });
  });

  it("leaves returnable equal to searchable when no flag has been read yet", () => {
    // Batch mode's steady state: sellouts accumulate as documents that a
    // search can still return, which is exactly the exposure being taught.
    const c = catalog(item("a", 0, true), item("b", 0, true), item("c", 1, true));
    expect(deriveCounts(c, new Map(), 3)).toEqual({ inStock: 1, searchable: 3, returnable: 3 });
  });

  it("treats an in-stock item flagged out of search as unreturnable", () => {
    // Shouldn't happen — only sold-out ids get looked up — but if a flag
    // write ever went wrong, the honest reading is that a search cannot
    // return that document, so the bar should show the shortfall rather
    // than hide it.
    const c = catalog(item("a", 5, true));
    expect(deriveCounts(c, flags({ a: "filtered" }), 1)).toEqual({
      inStock: 1,
      searchable: 1,
      returnable: 0,
    });
  });

  it("never counts an unindexed snack as searchable, whatever its stock", () => {
    const c = catalog(item("a", 9, false), item("b", 0, false));
    expect(deriveCounts(c, new Map(), 2)).toEqual({ inStock: 1, searchable: 0, returnable: 0 });
  });
});

describe("gridState", () => {
  it("calls anything with stock available, regardless of index state", () => {
    expect(gridState({ stockQty: 1, inIndex: true }, undefined)).toBe("available");
    expect(gridState({ stockQty: 1, inIndex: false }, undefined)).toBe("available");
    expect(gridState({ stockQty: 1, inIndex: true }, "hit")).toBe("available");
  });

  it("calls a sold-out, unindexed snack gone", () => {
    expect(gridState({ stockQty: 0, inIndex: false }, undefined)).toBe("gone");
  });

  it("calls a sold-out snack gone when Pinecone no longer has the document", () => {
    // Postgres hasn't caught up to the delete yet; Pinecone is the authority
    // on whether the document is there.
    expect(gridState({ stockQty: 0, inIndex: true }, "absent")).toBe("gone");
  });

  it("calls a sold-out snack filtered once its flag is confirmed false", () => {
    expect(gridState({ stockQty: 0, inIndex: true }, "filtered")).toBe("filtered");
  });

  it("calls a sold-out snack stale while a search can still return it", () => {
    expect(gridState({ stockQty: 0, inIndex: true }, "hit")).toBe("stale");
  });

  it("defaults an unanswered sold-out snack to stale, not filtered", () => {
    // The conservative reading: an unknown is reported as exposure rather
    // than as already handled, so the bar never claims a gap is closed
    // before the index has confirmed it.
    expect(gridState({ stockQty: 0, inIndex: true }, undefined)).toBe("stale");
  });
});

describe("buildReceipt", () => {
  const candidate = (id: string, over: Partial<{ inStock: boolean; picked: boolean }> = {}) => ({
    id,
    name: `snack ${id}`,
    inStock: over.inStock ?? true,
    picked: over.picked ?? false,
  });

  const tick = (candidates: ReturnType<typeof candidate>[], purchases: { snackId: string; snackName: string; priceCents: number }[] = []) => ({
    day: 1,
    tick: 2,
    agentId: "alex",
    brainUsed: "templated" as const,
    query: "something spicy",
    candidates,
    purchases,
  });

  it("shows candidates in Pinecone's order, up to the display cap", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const r = buildReceipt(tick(ids.map((id) => candidate(id))));
    expect(r.rows).toHaveLength(RECEIPT_DISPLAY_CAP);
    expect(r.rows.map((row) => row.id)).toEqual(ids.slice(0, RECEIPT_DISPLAY_CAP));
    expect(r.hiddenCount).toBe(ids.length - RECEIPT_DISPLAY_CAP);
  });

  it("always includes a picked candidate, even one ranked past the cap", () => {
    // A purchase must never be hidden behind "+N more" — the receipt's job is
    // to show what actually happened.
    const ids = ["a", "b", "c", "d", "e", "f", "g", "deep"];
    const r = buildReceipt(tick(ids.map((id) => candidate(id, { picked: id === "deep" }))));
    expect(r.rows.map((row) => row.id)).toContain("deep");
    expect(r.rows).toHaveLength(RECEIPT_DISPLAY_CAP + 1);
    expect(r.hiddenCount).toBe(ids.length - r.rows.length);
  });

  it("counts how many of the hidden candidates were stale", () => {
    const shown = ["a", "b", "c", "d", "e", "f"].map((id) => candidate(id));
    const hidden = [candidate("h1", { inStock: false }), candidate("h2"), candidate("h3", { inStock: false })];
    const r = buildReceipt(tick([...shown, ...hidden]));
    expect(r.hiddenCount).toBe(3);
    expect(r.hiddenStaleCount).toBe(2);
  });

  it("sums the cart", () => {
    const r = buildReceipt(
      tick([candidate("a", { picked: true }), candidate("b", { picked: true })], [
        { snackId: "a", snackName: "snack a", priceCents: 250 },
        { snackId: "b", snackName: "snack b", priceCents: 175 },
      ]),
    );
    expect(r.totalCents).toBe(425);
    expect(r.purchases.map((p) => p.snackName)).toEqual(["snack a", "snack b"]);
  });

  it("handles a search that returned nothing", () => {
    const r = buildReceipt(tick([]));
    expect(r.rows).toEqual([]);
    expect(r.hiddenCount).toBe(0);
    expect(r.hiddenStaleCount).toBe(0);
    expect(r.totalCents).toBe(0);
  });

  it("carries the shopper, query, and fallback reason through unchanged", () => {
    const r = buildReceipt({ ...tick([]), brainUsed: "llm", fallbackReason: "gemini timed out" });
    expect(r.agentId).toBe("alex");
    expect(r.query).toBe("something spicy");
    expect(r.brainUsed).toBe("llm");
    expect(r.fallbackReason).toBe("gemini timed out");
  });
});

describe("countGridStates", () => {
  it("tallies the four states the grid paints", () => {
    const c = catalog(
      item("a", 3, true),
      item("b", 1, false),
      item("stale", 0, true),
      item("filtered", 0, true),
      item("deleted", 0, false),
    );
    expect(countGridStates(c, flags({ filtered: "filtered", stale: "hit" }))).toEqual({
      available: 2,
      stale: 1,
      filtered: 1,
      gone: 1,
    });
  });

  it("always totals the catalog it was given", () => {
    // The legend sits above the grid and describes the same squares, so any
    // snack missing from this tally would be a square the legend can't explain.
    const c = catalog(item("a", 0, true), item("b", 0, true), item("c", 2, true));
    const counts = countGridStates(c, flags({ a: "filtered" }));
    expect(counts.available + counts.stale + counts.filtered + counts.gone).toBe(c.size);
  });

  it("returns all zeros before the first poll lands", () => {
    expect(countGridStates(new Map(), new Map())).toEqual({ available: 0, stale: 0, filtered: 0, gone: 0 });
  });
});
