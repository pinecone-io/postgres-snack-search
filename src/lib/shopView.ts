// The `/shop` page's derivations, pulled out of ShopSimulation.tsx so they
// can be tested without a browser, a DOM, or credentials. Everything here is
// a pure function of data the component already has; the component keeps the
// state, the effects, and the fetching, and calls into this for every "what
// should this number / colour be" decision.
//
// `LiveSearchFlag` is imported as a type only. That matters: its module
// builds a Pinecone client at import time, so a value import would drag a
// required API key into both the browser bundle and the unit tests.
import type { LiveSearchFlag } from "@/lib/snacksPinecone";
import type { CandidateResult, Purchase } from "@/lib/simulation";
import type { ShopperBrain } from "@/lib/shopperBrain";

// How many of a search's ranked candidates a receipt shows by default —
// raised automatically to include anything actually picked, so a purchase is
// never hidden behind "+N more".
export const RECEIPT_DISPLAY_CAP = 6;

// How many polls in a row the app will re-ask Pinecone about one document
// before treating its answer as settled. "filtered" is a terminal answer
// (nothing flips a flag back to true except Restock or a night-sync
// re-upsert, both of which clear the cache), but "hit" is not: a sale's flag
// write takes a few real seconds to propagate, so a just-sold-out document
// legitimately reads as a hit for a poll or two before flipping. Re-asking a
// handful of times covers that window; stopping after it keeps a large
// backlog of batch-mode sellouts from being re-queried forever.
export const FLAG_RECHECKS = 5;

export interface CatalogItem {
  id: string;
  name: string;
  category: string;
  stockQty: number;
  inIndex: boolean;
}

/** One row of a search receipt: a single Pinecone-ranked candidate, tagged
 * with what Postgres actually says about it right now. */
export interface ReceiptRow {
  id: string;
  name: string;
  inStock: boolean;
  picked: boolean;
  outcome?: "bought" | "sold_out";
}

/** A shopper's whole trip: what Pinecone returned, what Postgres said about
 * each candidate, and what actually got bought. */
export interface Receipt {
  key: string;
  agentId: string;
  brainUsed: ShopperBrain;
  query: string;
  fallbackReason?: string;
  rows: ReceiptRow[];
  hiddenCount: number;
  hiddenStaleCount: number;
  purchases: { snackName: string; priceCents: number }[];
  totalCents: number;
}

/** One document's last known index-side answer, plus how many times it's
 * been asked — see FLAG_RECHECKS. */
export interface FlagEntry {
  flag: LiveSearchFlag;
  checks: number;
}

/** What one square in the whole-shop grid is showing. */
export type GridState = "available" | "stale" | "filtered" | "gone";

export interface TickResponse {
  day: number;
  tick: number;
  agentId: string;
  brainUsed: ShopperBrain;
  query: string;
  fallbackReason?: string;
  candidates: CandidateResult[];
  purchases: Purchase[];
}

/**
 * Turns one tick's raw candidates into a receipt: always shows whatever got
 * picked, fills the rest up to the display cap in Pinecone's own rank order,
 * and counts what's left off (and how much of that is stale) rather than
 * silently dropping it.
 */
export function buildReceipt(json: TickResponse): Receipt {
  const { candidates, purchases } = json;
  const forcedIds = new Set(candidates.filter((c) => c.picked).map((c) => c.id));
  const shown = candidates.filter((c, i) => i < RECEIPT_DISPLAY_CAP || forcedIds.has(c.id));
  const shownIds = new Set(shown.map((c) => c.id));
  const hidden = candidates.filter((c) => !shownIds.has(c.id));
  return {
    key: `${json.day}-${json.tick}-${json.agentId}-${Math.random()}`,
    agentId: json.agentId,
    brainUsed: json.brainUsed,
    query: json.query,
    fallbackReason: json.fallbackReason,
    rows: shown.map((c) => ({ id: c.id, name: c.name, inStock: c.inStock, picked: c.picked, outcome: c.outcome })),
    hiddenCount: hidden.length,
    hiddenStaleCount: hidden.filter((c) => !c.inStock).length,
    purchases: purchases.map((p) => ({ snackName: p.snackName, priceCents: p.priceCents })),
    totalCents: purchases.reduce((sum, p) => sum + p.priceCents, 0),
  };
}

/** The sold-out snacks whose documents Postgres still believes are in the
 * index — the only set where Postgres and Pinecone can disagree, and so the
 * only set worth asking Pinecone about. */
export function staleIdsOf(snacks: CatalogItem[]): string[] {
  return snacks.filter((s) => s.stockQty === 0 && s.inIndex).map((s) => s.id);
}

/**
 * Which of those ids still need a network call. Skips anything already
 * answered "filtered" (terminal) and anything asked FLAG_RECHECKS times
 * (settled), so a burst of sellouts costs one small fetch rather than a
 * re-read of every sold-out document.
 */
export function pickFlagQueryIds(staleIds: string[], known: Map<string, FlagEntry>, maxChecks = FLAG_RECHECKS): string[] {
  return staleIds.filter((id) => {
    const e = known.get(id);
    return e === undefined || (e.flag !== "filtered" && e.checks < maxChecks);
  });
}

/**
 * Folds a batch of answers into the flag cache.
 *
 * Rebuilt from `staleIds` rather than mutated, so an id that leaves the set
 * (restocked, or actually deleted by night sync) drops out instead of
 * accumulating. `checks` only advances for ids this batch actually answered:
 * an id that was asked but came back missing from the response keeps its
 * previous answer and its previous count, so it gets asked again next poll
 * instead of being wrongly marked settled.
 */
export function mergeFlagAnswers(
  staleIds: string[],
  known: Map<string, FlagEntry>,
  fetched: Record<string, LiveSearchFlag>,
): Map<string, FlagEntry> {
  const next = new Map<string, FlagEntry>();
  for (const id of staleIds) {
    const prev = known.get(id);
    const answer = fetched[id];
    const flag = answer ?? prev?.flag;
    if (flag) next.set(id, { flag, checks: (prev?.checks ?? 0) + (answer ? 1 : 0) });
  }
  return next;
}

/** Drops the bookkeeping, leaving just what each id's flag is — the shape
 * the grid and the counts read from. */
export function flagsForRender(entries: Map<string, FlagEntry>): Map<string, LiveSearchFlag> {
  return new Map(Array.from(entries, ([id, e]) => [id, e.flag]));
}

/**
 * The three numbers behind the sync-gap bars.
 *
 * `searchable` counts documents physically in the index; `returnable`
 * subtracts the ones Pinecone's own `in_stock` flag currently excludes. Both
 * are derived from the same catalog snapshot the grid renders from, so the
 * bar and the grid cannot disagree about a given instant.
 *
 * Before the first poll lands there's nothing to count, so this reports the
 * whole catalog rather than three zeros, which would flash an empty shop on
 * every load.
 */
export function deriveCounts(
  catalogById: Map<string, CatalogItem>,
  indexFlags: Map<string, LiveSearchFlag>,
  totalSnacks: number,
): { inStock: number; searchable: number; returnable: number } {
  if (catalogById.size === 0) {
    return { inStock: totalSnacks, searchable: totalSnacks, returnable: totalSnacks };
  }
  let inStock = 0;
  let searchable = 0;
  let unreachable = 0;
  for (const s of catalogById.values()) {
    if (s.stockQty > 0) inStock++;
    if (s.inIndex) {
      searchable++;
      // Only sold-out documents ever get a flag looked up, so anything still
      // in stock has no entry here and counts as reachable.
      const flag = indexFlags.get(s.id);
      if (flag === "filtered" || flag === "absent") unreachable++;
    }
  }
  return { inStock, searchable, returnable: searchable - unreachable };
}

/**
 * What colour one snack's square should be. Postgres decides the first two
 * branches, Pinecone the rest.
 *
 * A sold-out-and-indexed snack with no answer yet — or an answer of "hit" —
 * stays "stale", which is the conservative reading: stale means "a search can
 * still return this," so an unknown is reported as exposure rather than as
 * already handled.
 */
export function gridState(item: { stockQty: number; inIndex: boolean }, flag: LiveSearchFlag | undefined): GridState {
  if (item.stockQty > 0) return "available";
  if (!item.inIndex || flag === "absent") return "gone";
  if (flag === "filtered") return "filtered";
  return "stale";
}

/**
 * How many snacks are currently in each of the grid's four states, so the
 * legend can carry live counts rather than just naming colours. Derived from
 * the same snapshot the grid renders from and through the same `gridState`
 * call, so a legend number and the squares it describes can never disagree.
 */
export function countGridStates(
  catalogById: Map<string, CatalogItem>,
  indexFlags: Map<string, LiveSearchFlag>,
): Record<GridState, number> {
  const counts: Record<GridState, number> = { available: 0, stale: 0, filtered: 0, gone: 0 };
  for (const item of catalogById.values()) {
    counts[gridState(item, indexFlags.get(item.id))]++;
  }
  return counts;
}
