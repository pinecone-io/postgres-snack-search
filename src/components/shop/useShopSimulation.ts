"use client";

// Everything the shop simulation does: the polls, the ticks, the day/night
// actions, and the two derived tallies the page renders. ShopSimulation.tsx
// is the layout that consumes this.
//
// Every type here is imported with `import type` on purpose:
// @/lib/snacksPinecone builds a Pinecone client at module load and
// @/lib/shopperBrain reads @/lib/env, so a value import from either would
// throw in the browser.
import { useEffect, useMemo, useRef, useState } from "react";
import type { LlmCallLog as LlmCall, ShopperBrain } from "@/lib/shopperBrain";
import type { LowStockItem } from "@/components/shop/LowStockPanel";
import {
  buildReceipt,
  countGridStates,
  deriveCounts,
  flagsForRender,
  mergeFlagAnswers,
  pickFlagQueryIds,
  staleIdsOf,
  type CatalogItem,
  type FlagEntry,
  type Receipt,
} from "@/lib/shopView";
import type { LiveSearchFlag, SyncMode } from "@/lib/snacksPinecone";

const MAX_LLM_LOG = 8;
// How often the whole-shop grid re-polls Postgres for every snack's current
// state. Cheap query (a handful of small columns, one row per snack), so a
// ~1s cadence is fine for a demo. Exported because the grid's caption says
// the cadence out loud, and the two shouldn't be able to drift apart.
export const CATALOG_POLL_MS = 1200;
// LLM-driven shoppers make a real API call per turn, so a burst fires fewer
// of them, less often, than the free and instant templated ones.
const AUTO_TICK_MS: Record<ShopperBrain, number> = { templated: 900, llm: 2200 };
const BURST_SIZE: Record<ShopperBrain, number> = { templated: 4, llm: 2 };

export function useShopSimulation(totalSnacks: number) {
  const [day, setDay] = useState(1);
  const [tick, setTick] = useState(0);
  const [lowStock, setLowStock] = useState<LowStockItem[]>([]);
  // One slot per shopper, keyed by shopper id, holding only that shopper's
  // most recent trip. Fixed set of keys for the app's whole life, so the
  // panel below never grows, shrinks, or reorders — a new trip repaints one
  // card in place instead of pushing the page around.
  const [tripByShopper, setTripByShopper] = useState<Map<string, Receipt>>(new Map());
  // Which slot the detail area is showing. Follows the newest trip unless the
  // reader clicks a card to hold one still.
  const [selected, setSelected] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [lastSync, setLastSync] = useState<{ label: string; detail: string } | null>(null);
  const [llmLog, setLlmLog] = useState<LlmCall[]>([]);
  // The whole-shop grid's fixed layout: every id, sorted once (category,
  // then name, then id) and never reordered again — only per-id state
  // (below) changes, so the grid updates in place instead of reshuffling.
  const [catalogOrder, setCatalogOrder] = useState<string[]>([]);
  const [catalogById, setCatalogById] = useState<Map<string, CatalogItem>>(new Map());
  // Pinecone's own answer for the sold-out-but-still-indexed snacks: is each
  // document still something a search can return, or has its `in_stock`
  // flag flipped? Postgres can't answer this — see fetchLiveSearchFlags.
  const [indexFlags, setIndexFlags] = useState<Map<string, LiveSearchFlag>>(new Map());
  // Mirror of the above, so the poll below can read the current flags
  // synchronously to decide which ids still need asking about. Written only
  // in refreshIndexFlags, on the same two lines as the state it mirrors.
  const flagsRef = useRef<Map<string, FlagEntry>>(new Map());
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restockProgress, setRestockProgress] = useState<{ indexed: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [brain, setBrain] = useState<ShopperBrain>("templated");
  const [syncMode, setSyncMode] = useState<SyncMode>("batch");
  // Whether every doc in Pinecone currently has an `in_stock` field — Live
  // mode's filter excludes a document missing the field just as surely as
  // one flagged false, so switching to Live before a backfill would just
  // search into silence. Restock always backfills, so this flips true right
  // after one.
  const [pineconeBackfilled, setPineconeBackfilled] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Mirrors of the three values a tick reads. The auto-run interval closes
  // over the callbacks from the render that started it, so anything read
  // directly from render scope inside a tick would be frozen at that moment
  // — changing the brain, the sync mode, or the pin mid-run would do nothing
  // until the interval was rebuilt. Reading them from refs keeps a running
  // simulation responsive to the controls above it.
  const brainRef = useRef(brain);
  const syncModeRef = useRef(syncMode);
  const pinnedRef = useRef(pinned);
  useEffect(() => {
    brainRef.current = brain;
    syncModeRef.current = syncMode;
    pinnedRef.current = pinned;
  }, [brain, syncMode, pinned]);

  // Both polls are best-effort: a single failed poll (a dropped DB
  // connection, a transient 502) should leave the panel showing its last
  // known state and try again next interval, not throw an unhandled
  // rejection or blank the panel out with undefined data.
  async function refreshLowStock() {
    try {
      const res = await fetch("/api/sim/low-stock");
      if (!res.ok) return;
      const { snacks } = await res.json();
      setLowStock(snacks);
    } catch {
      // Next interval tick will retry.
    }
  }

  async function refreshCatalog() {
    try {
      const res = await fetch("/api/sim/catalog");
      if (!res.ok) return;
      const { snacks } = (await res.json()) as { snacks: CatalogItem[] };
      setCatalogById(new Map(snacks.map((s) => [s.id, s])));
      // The same ids exist for the app's whole life — set the order once,
      // from whichever poll happens to land first, and never touch it again.
      setCatalogOrder((prev) => (prev.length > 0 ? prev : snacks.map((s) => s.id)));
      // Chained off this same snapshot rather than run on its own interval,
      // so the flags the grid colors by always describe the exact set of
      // sold-out snacks the snapshot just reported.
      await refreshIndexFlags(snacks);
    } catch {
      // Next interval tick will retry.
    }
  }

  /**
   * Asks Pinecone what it currently thinks about the sold-out snacks whose
   * documents Postgres believes are still in the index — the only set where
   * the two systems can differ, and the only set worth a network call.
   * Deliberately incremental: an id already answered "filtered", or asked
   * FLAG_RECHECKS times, isn't asked again, so a burst of sellouts costs
   * one small fetch per poll instead of re-reading every sold-out document.
   */
  async function refreshIndexFlags(snacks: CatalogItem[]) {
    const staleIds = staleIdsOf(snacks);
    const known = flagsRef.current;
    const toAsk = pickFlagQueryIds(staleIds, known);

    let fetched: Record<string, LiveSearchFlag> = {};
    if (toAsk.length > 0) {
      try {
        const res = await fetch("/api/sim/index-flags", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: toAsk }),
        });
        if (!res.ok) return;
        ({ flags: fetched } = (await res.json()) as { flags: Record<string, LiveSearchFlag> });
      } catch {
        // Best-effort, same as the polls above: keep the last known answers
        // and try again next tick rather than blanking the grid.
        return;
      }
    }

    const next = mergeFlagAnswers(staleIds, known, fetched);
    flagsRef.current = next;
    setIndexFlags(flagsForRender(next));
  }

  // One-time load of wherever the simulation already is (day/tick/backfill
  // status) — the aggregate stock counts, below, come from the same polled
  // catalog data the whole-shop grid uses, not a separate fetch here, so
  // the bar and the grid can never disagree about what's in stock.
  useEffect(() => {
    fetch("/api/sim/state")
      .then((r) => r.json())
      .then(({ state }) => {
        setDay(state.currentDay);
        setTick(state.tickInDay);
        setPineconeBackfilled(Boolean(state.pineconeBackfilled));
      })
      .catch(() => {});
  }, []);

  // Both panels render a "Loading…" fallback until their first poll lands,
  // so there's no need to also fire an immediate call here — that would be
  // a bare setState-triggering call outside any callback, which is exactly
  // the pattern React's effect rules warn against. The interval's first
  // tick (well under a couple seconds) is the first fetch.
  useEffect(() => {
    const lowStockInterval = setInterval(refreshLowStock, CATALOG_POLL_MS);
    return () => clearInterval(lowStockInterval);
  }, []);

  useEffect(() => {
    const catalogInterval = setInterval(refreshCatalog, CATALOG_POLL_MS);
    return () => clearInterval(catalogInterval);
    // Intentionally empty: refreshCatalog reads nothing from render scope
    // that changes — the flag cache it consults lives in a ref precisely so
    // this interval can be set up once and never torn down mid-poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Drops a finished trip into its shopper's slot, replacing whatever that
   * shopper did last. The detail area follows it unless a card is pinned.
   *
   * Reads the pin from `pinnedRef`, not from render scope: a tick fired by
   * the auto-run interval runs inside a closure from whenever Start was
   * pressed, so the render-scope value would be whatever the pin was back
   * then, and pinning a card mid-run wouldn't hold it. */
  function recordTrip(receipt: Receipt) {
    setTripByShopper((prev) => new Map(prev).set(receipt.agentId, receipt));
    setSelected((cur) => (pinnedRef.current ? cur : receipt.agentId));
  }

  async function runOneTick() {
    try {
      const res = await fetch("/api/sim/tick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brain: brainRef.current, syncMode: syncModeRef.current }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "tick failed");
      setDay(json.day);
      setTick((t) => Math.max(t, json.tick));
      recordTrip(buildReceipt(json));
      if (json.llmCall) {
        setLlmLog((log) => [json.llmCall, ...log].slice(0, MAX_LLM_LOG));
      }
      refreshLowStock();
      refreshCatalog();
    } catch (e) {
      setError((e as Error).message);
      setRunning(false);
    }
  }

  /** Fires a burst of shoppers concurrently rather than one at a time, so
   * activity is dense enough to actually watch happen. Each one updates
   * the log independently as it resolves. */
  function runBurst() {
    setError(null);
    const size = BURST_SIZE[brainRef.current];
    for (let i = 0; i < size; i++) runOneTick();
  }

  async function endDay() {
    setBusy(true);
    setError(null);
    try {
      const syncRes = await fetch("/api/sim/night-sync", { method: "POST" });
      const sync = await syncRes.json();
      if (!syncRes.ok) throw new Error(sync.error ?? "night sync failed");
      const dayRes = await fetch("/api/sim/next-day", { method: "POST" });
      const state = await dayRes.json();
      if (!dayRes.ok) throw new Error(state.error ?? "advancing the day failed");
      setLastSync({
        label: `night sync — day ${day}`,
        detail: `${sync.removed} removed from search, ${sync.added} added`,
      });
      setDay(state.currentDay);
      setTick(state.tickInDay);
      refreshLowStock();
      refreshCatalog();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function restock() {
    setRunning(false);
    setBusy(true);
    setRestockProgress({ indexed: 0, total: totalSnacks });
    setError(null);
    try {
      await streamRestock(setRestockProgress);
      const { state } = await fetch("/api/sim/state").then((r) => r.json());
      setDay(state.currentDay);
      setTick(state.tickInDay);
      setPineconeBackfilled(Boolean(state.pineconeBackfilled));
      setTripByShopper(new Map());
      setSelected(null);
      setPinned(false);
      setLastSync(null);
      setLlmLog([]);
      // Restock re-upserts every document with `in_stock: true`, so every
      // cached answer is now wrong. (End day needs no equivalent: it makes
      // documents disappear from the sold-out-and-indexed set entirely, and
      // refreshIndexFlags rebuilds from that set every poll.)
      flagsRef.current = new Map();
      setIndexFlags(new Map());
      refreshLowStock();
      refreshCatalog();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRestockProgress(null);
      setBusy(false);
    }
  }

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(runBurst, AUTO_TICK_MS[brain]);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, brain]);

  // Derived from the same polled catalog data the whole-shop grid renders
  // from — not a separate fetch — so the reconciliation bar and the grid
  // are reading one shared snapshot and can never show two different
  // answers for the same instant, regardless of what triggered the change
  // (a click in this tab, night sync run from another tab, a curl call).
  const { inStock, searchable, returnable } = useMemo(
    () => deriveCounts(catalogById, indexFlags, totalSnacks),
    [catalogById, indexFlags, totalSnacks],
  );

  // Same snapshot, same gridState() call the squares use, so a legend count
  // and the squares it describes can't drift apart.
  const stateCounts = useMemo(() => countGridStates(catalogById, indexFlags), [catalogById, indexFlags]);

  /** Clicking a card holds it; clicking the held one lets go and the detail
   * area resumes following whoever shops next. */
  function selectShopper(id: string) {
    if (selected === id && pinned) setPinned(false);
    else {
      setSelected(id);
      setPinned(true);
    }
  }

  return {
    // What the page displays.
    day,
    tick,
    lowStock,
    llmLog,
    tripByShopper,
    selected,
    pinned,
    lastSync,
    catalogOrder,
    catalogById,
    indexFlags,
    inStock,
    searchable,
    returnable,
    stateCounts,
    // Control state.
    running,
    busy,
    restockProgress,
    error,
    brain,
    syncMode,
    pineconeBackfilled,
    // What the buttons do.
    setBrain,
    setSyncMode,
    setRunning,
    runBurst,
    endDay,
    restock,
    selectShopper,
  };
}

// Reads the reset route's NDJSON stream, reporting each page as it lands.
async function streamRestock(onProgress: (p: { indexed: number; total: number }) => void) {
  const res = await fetch("/api/sim/reset", { method: "POST" });
  if (!res.ok || !res.body) throw new Error(`restock failed (HTTP ${res.status})`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  let finished = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += value;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line);
      if (message.error) throw new Error(message.error);
      if ("snackCount" in message) finished = true;
      else onProgress(message);
    }
  }
  if (!finished) throw new Error("restock ended before the index rebuild finished");
}
