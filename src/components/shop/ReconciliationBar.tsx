// Presentational: every value is passed in, so no state and no fetching.
// Types come in with `import type` because @/lib/snacksPinecone builds a
// Pinecone client at module load, which throws in the browser.

import type { SyncMode } from "@/lib/snacksPinecone";

/**
 * The macro proof, three bars over the whole catalog:
 *
 *   documents in pinecone  — what's physically in the index (`inIndex`)
 *   a search can return    — those minus the ones whose `in_stock` flag,
 *                            read live off Pinecone, excludes them
 *   actually in stock      — Postgres's ground truth
 *
 * The middle bar is what separates the two sync modes. In batch mode it
 * sits on top of the first one, because nothing filters anything and every
 * sold-out document is still a live hit. In live mode it drops to meet the
 * third, because each sale writes a flag that takes the document out of
 * search without deleting it. Same catalog, same sellouts, and the gap
 * that closes is a different one.
 */
export function ReconciliationBar({
  inStock,
  searchable,
  returnable,
  total,
  syncMode,
}: {
  inStock: number;
  searchable: number;
  returnable: number;
  total: number;
  syncMode: SyncMode;
}) {
  const flaggedOut = Math.max(0, searchable - returnable);
  const exposed = Math.max(0, returnable - inStock);
  return (
    <div className="flex flex-col gap-2 border border-border bg-background p-3" data-panel="sync-gap">
      <p className="font-mono text-xs font-bold tracking-wide text-muted-foreground uppercase">the sync gap</p>
      <div className="flex flex-col gap-1.5">
        <BarRow label="docs in pinecone" value={searchable} total={total} />
        <BarRow label="search can return" value={returnable} total={total} />
        <BarRow label="actually in stock" value={inStock} total={total} />
      </div>
      <p className="text-xs text-muted-foreground">
        {exposed > 0 ? (
          <>
            <span className="font-mono font-bold text-primary">{exposed}</span> sold-out snack
            {exposed > 1 ? "s" : ""} a search can still return right now — Postgres hydration is the only thing
            keeping {exposed > 1 ? "them" : "it"} out of what a shopper sees.{" "}
            {syncMode === "batch"
              ? 'Batch mode closes that only by deleting the documents, on "End day (sync)".'
              : "In Live mode this should fall back to zero within a few seconds as each sale's flag write propagates."}
          </>
        ) : (
          "Everything a search can return is actually in stock right now."
        )}{" "}
        {flaggedOut > 0 && (
          <>
            <span className="font-mono font-bold text-primary">{flaggedOut}</span> more document
            {flaggedOut > 1 ? "s are" : " is"} still physically in the index but flagged{" "}
            <code>in_stock: false</code>, so search never ranks {flaggedOut > 1 ? "them" : "it"}. Deleting{" "}
            {flaggedOut > 1 ? "them" : "it"} for real still happens on &quot;End day (sync)&quot;.
          </>
        )}
      </p>
    </div>
  );
}

function BarRow({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-32 shrink-0 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <div className="h-3 flex-1 bg-muted-foreground/15">
        <div className="h-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-14 shrink-0 text-right font-mono text-xs font-bold text-foreground">{value}</span>
    </div>
  );
}
