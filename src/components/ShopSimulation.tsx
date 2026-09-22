"use client";

// The `/shop` page's layout. All of its behaviour — polling, ticks, night
// sync, restock — lives in useShopSimulation; everything below is markup
// and the props it feeds to the four panels.
import { Button } from "@/components/ui/button";
import { LlmCallLog } from "@/components/shop/LlmCallLog";
import { LowStockPanel } from "@/components/shop/LowStockPanel";
import { GridLegend, ShopGrid } from "@/components/shop/ShopGrid";
import { ReconciliationBar } from "@/components/shop/ReconciliationBar";
import { ShopperPanel } from "@/components/shop/ShopperPanel";
import { CATALOG_POLL_MS, useShopSimulation } from "@/components/shop/useShopSimulation";

export function ShopSimulation({ totalSnacks }: { totalSnacks: number }) {
  const {
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
    running,
    busy,
    restockProgress,
    error,
    brain,
    syncMode,
    pineconeBackfilled,
    setBrain,
    setSyncMode,
    setRunning,
    runBurst,
    endDay,
    restock,
    selectShopper,
  } = useShopSimulation(totalSnacks);

  return (
    <div className="flex flex-col gap-4 border border-border bg-card p-6">
      <div>
        <p className="font-mono text-xs font-bold tracking-wide text-muted-foreground uppercase">How the simulation works</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Start the simulation, and shoppers will start querying and getting recommendations to buy snacks from Pinecone. They&apos;ll buy a couple at random, and with only
          one of everything in stock, the store will quickly empty. Inventory and recommendations served is visualized in the grid below.

          Templated uses pre-generated data, and the LLM mode calls Gemini-Flash-3.8 live to simulate real behavior and generated queries. All the queries are logged below, along
          with the tool calls.

          Sync can happen two ways, once at the end of the day via Batch, and live, using the Documents API. Restock resets the application.

        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {syncMode === "batch" ? (
            <>
              <span className="font-bold text-foreground">Syncing:</span> Choose Batch Mode to show how Pinecone can handle bulk updates from Postgres, or Live mode,
              to show how quickly Pinecone can deal with updates on the fly.
            </>
          ) : (
            <>
              <span className="font-bold text-foreground">Live sync:</span> a sellout writes an <code>in_stock</code>{" "}
              flag straight into Pinecone using a field-level update and search
              filters on it.&quot;
            </>
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-sm font-bold text-foreground">Day {day}</span>
        <span className="font-mono text-xs text-muted-foreground">tick {tick}</span>
        <div className="flex gap-2">
          <Button size="sm" variant={brain === "templated" ? "default" : "outline"} onClick={() => setBrain("templated")}>
            Templated
          </Button>
          <Button size="sm" variant={brain === "llm" ? "default" : "outline"} onClick={() => setBrain("llm")}>
            LLM
          </Button>
        </div>
        <div
          className="flex gap-2"
          title={pineconeBackfilled ? undefined : "Restock the shop first — Live mode needs every item flagged in Pinecone"}
        >
          <Button size="sm" variant={syncMode === "batch" ? "default" : "outline"} onClick={() => setSyncMode("batch")}>
            Batch sync
          </Button>
          <Button
            size="sm"
            variant={syncMode === "live" ? "default" : "outline"}
            disabled={!pineconeBackfilled}
            onClick={() => setSyncMode("live")}
          >
            Live sync
          </Button>
        </div>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant={running ? "outline" : "default"} onClick={() => setRunning((r) => !r)}>
            {running ? "Pause" : "Start"}
          </Button>
          <Button size="sm" variant="outline" onClick={runBurst} disabled={running || busy}>
            Next shoppers
          </Button>
          <Button size="sm" variant="outline" onClick={endDay} disabled={busy}>
            End day (sync)
          </Button>
          <Button size="sm" variant="outline" onClick={restock} disabled={busy}>
            {restockProgress ? "Restocking…" : "Restock"}
          </Button>
        </div>
      </div>

      {restockProgress && (
        <div>
          <p className="font-mono text-xs text-muted-foreground">
            Rebuilding the Pinecone index from Postgres: {restockProgress.indexed.toLocaleString()} /{" "}
            {restockProgress.total.toLocaleString()} snacks embedded and upserted
          </p>
          <div className="mt-1 h-1.5 w-full bg-muted">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${(100 * restockProgress.indexed) / restockProgress.total}%` }}
            />
          </div>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Directly under the controls on purpose: this is the thing to watch
          while clicking them, so a sale's effect lands in the same glance as
          the button that caused it. */}
      <div className="border border-border bg-background p-3">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">

          <p className="font-mono text-[10px] text-muted-foreground">
            {totalSnacks} snacks · by category · stock from postgres, flags from pinecone, every{" "}
            {(CATALOG_POLL_MS / 1000).toFixed(1)}s
          </p>
        </div>
        <GridLegend counts={stateCounts} />
        {catalogOrder.length > 0 ? (
          <ShopGrid order={catalogOrder} byId={catalogById} flags={indexFlags} />
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </div>

      <ReconciliationBar
        inStock={inStock}
        searchable={searchable}
        returnable={returnable}
        total={totalSnacks}
        syncMode={syncMode}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <LowStockPanel items={lowStock} />
        <LlmCallLog calls={llmLog} brain={brain} />
      </div>

      <ShopperPanel
        trips={tripByShopper}
        selected={selected}
        pinned={pinned}
        lastSync={lastSync}
        onSelect={selectShopper}
      />
    </div>
  );
}
