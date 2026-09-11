// A handful of shoppers taking turns browsing the storefront. Each trip,
// one shopper searches once and tries to fill a cart of 3-5 items from the
// results. Buying is checked live against the stockroom (see
// src/db/queries.ts), so a shopper never actually walks off with something
// that's already gone. What the search index sees, though, depends on the
// sync mode: in "batch" mode it's whatever night sync last published; in
// "live" mode, a sellout flips that snack's `in_stock` flag in Pinecone
// immediately, so the very next search can filter it out (once that flip
// actually propagates — still a real, if shorter, delay, not zero).
import { advanceTick, buyOne, getStockroomCounts, logSaleAttempt } from "@/db/queries";
import { searchSnacksWithCandidates, setLiveInStock, type CandidateSquare, type SyncMode } from "@/lib/snacksPinecone";
import { getShopperQuery, SHOPPERS, type LlmCallLog, type ShopperBrain } from "@/lib/shopperBrain";

const MIN_CART = 3;
const MAX_CART = 5;
const CANDIDATE_POOL_SIZE = 24;

export interface CandidateResult extends CandidateSquare {
  picked: boolean;
  outcome?: "bought" | "sold_out";
}

export interface Purchase {
  snackId: string;
  snackName: string;
  priceCents: number;
}

export interface TickResult {
  day: number;
  tick: number;
  agentId: string;
  query: string;
  brainUsed: ShopperBrain;
  fallbackReason?: string;
  llmCall?: LlmCallLog;
  candidates: CandidateResult[];
  purchases: Purchase[];
  counts: { inStock: number; searchable: number };
  syncMode: SyncMode;
}

/** Picks `count` distinct items at random from `pool` without replacement. */
function sampleWithoutReplacement<T>(pool: T[], count: number): T[] {
  const copy = [...pool];
  const picks: T[] = [];
  while (copy.length > 0 && picks.length < count) {
    const i = Math.floor(Math.random() * copy.length);
    picks.push(copy.splice(i, 1)[0]);
  }
  return picks;
}

/** Runs one shopper's trip: decide what to search for, search once, then
 * try to fill a cart of 3-5 items from the in-stock results. */
export async function runTick(brain: ShopperBrain = "templated", syncMode: SyncMode = "batch"): Promise<TickResult> {
  const state = await advanceTick();
  const shopper = SHOPPERS[Math.floor(Math.random() * SHOPPERS.length)];
  const { query, brainUsed, fallbackReason, llmCall } = await getShopperQuery(shopper, brain);

  const { results, candidates } = await searchSnacksWithCandidates(query, "hybrid", CANDIDATE_POOL_SIZE, syncMode);

  const cartSize = MIN_CART + Math.floor(Math.random() * (MAX_CART - MIN_CART + 1));
  const picks = sampleWithoutReplacement(results, Math.min(cartSize, results.length));

  const purchases: Purchase[] = [];
  const outcomeById = new Map<string, "bought" | "sold_out">();

  for (const pick of picks) {
    const sold = await buyOne(pick.id);
    if (sold) {
      purchases.push({ snackId: pick.id, snackName: pick.name, priceCents: sold.priceCents });
      outcomeById.set(pick.id, "bought");
      if (sold.stockQty === 0 && syncMode === "live") {
        // Flips the flag, not `inIndex` — `inIndex` means "physically
        // present in Pinecone," and stays true until night sync actually
        // deletes the document (see getSnacksToRemoveFromIndex). Live mode
        // doesn't skip that step; it adds a faster, filter-based exclusion
        // on top of it. Flipping inIndex here instead would make night
        // sync think this item was already removed and skip deleting it
        // for real — the document would sit in Pinecone forever, flagged
        // out in Live mode but silently back in results the moment
        // someone switches to Batch mode. Fire-and-forget: the sale is
        // already committed, and this write is the slow half.
        setLiveInStock(pick.id, false).catch((e) => console.error("live sync: setLiveInStock failed", e));
      }
    } else {
      // Lost the race — another shopper bought the last unit between this
      // search and this attempt. The atomic decrement in buyOne is what
      // makes that safe rather than a double-sold bug.
      outcomeById.set(pick.id, "sold_out");
    }
  }

  await Promise.all(
    picks.map((pick) =>
      logSaleAttempt({
        snackId: pick.id,
        day: state.currentDay,
        tick: state.tickInDay,
        agentId: shopper.id,
        query,
        outcome: outcomeById.get(pick.id)!,
        qty: outcomeById.get(pick.id) === "bought" ? 1 : 0,
        priceCents: purchases.find((p) => p.snackId === pick.id)?.priceCents,
      }),
    ),
  );
  if (picks.length === 0) {
    await logSaleAttempt({
      snackId: null,
      day: state.currentDay,
      tick: state.tickInDay,
      agentId: shopper.id,
      query,
      outcome: "not_found",
      qty: 0,
    });
  }

  const counts = await getStockroomCounts();
  const pickedIds = new Set(picks.map((p) => p.id));

  return {
    day: state.currentDay,
    tick: state.tickInDay,
    agentId: shopper.id,
    query,
    brainUsed,
    fallbackReason,
    llmCall,
    candidates: candidates.map((c) => ({ ...c, picked: pickedIds.has(c.id), outcome: outcomeById.get(c.id) })),
    purchases,
    counts,
    syncMode,
  };
}
