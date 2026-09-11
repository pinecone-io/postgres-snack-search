// Presentational: every value is passed in, so no state and no fetching.
// Types come in with `import type` because @/lib/snacksPinecone builds a
// Pinecone client at module load, which throws in the browser.

import { gridState, type CatalogItem, type GridState } from "@/lib/shopView";
import type { LiveSearchFlag } from "@/lib/snacksPinecone";

/** The grid's key, doubling as a live tally: each row sits next to its own
 * colour and current count, with the longer explanation in its `title`. */
const LEGEND: { state: GridState; fill: string; label: string; detail: string }[] = [
  {
    state: "available",
    fill: "bg-primary",
    label: "in stock",
    detail: "Postgres still has units on the shelf.",
  },
  {
    state: "stale",
    fill: "bg-amber-500",
    label: "stale",
    detail:
      "Sold out, and a search can still return it — the exposure Postgres hydration has to catch. In Batch mode this is where sellouts pile up until you end the day.",
  },
  {
    state: "filtered",
    fill: "bg-emerald-500",
    label: "filtered",
    detail:
      "Sold out and flagged in_stock: false, read back off Pinecone. The document is still in the index; search skips it. This is what Live mode adds.",
  },
  {
    state: "gone",
    fill: "bg-muted-foreground/40",
    label: "deleted",
    detail: "Sold out and the document is actually gone from Pinecone — night sync ran.",
  },
];

export function GridLegend({ counts }: { counts: Record<GridState, number> }) {
  return (
    <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1" data-panel="grid-legend">
      {LEGEND.map((l) => (
        <span key={l.state} title={l.detail} className="flex items-center gap-1.5 text-xs">
          <span className={`size-2.5 shrink-0 ${l.fill}`} />
          <span className="text-muted-foreground">{l.label}</span>
          <span className="font-mono font-bold text-foreground">{counts[l.state]}</span>
        </span>
      ))}
      <span className="text-xs text-muted-foreground">
        blue → amber → green, a second or two apart, is live sync propagating
      </span>
    </div>
  );
}

// Square size floor. Columns are filled responsively from this rather than
// fixed to a count, so the grid reflows to the viewport and stays correct for
// any catalog size — an earlier version hardcoded 58 columns because 1160
// happens to factor as 58 × 20, which quietly broke if the catalog changed.
const GRID_MIN_SQUARE_PX = 11;

/** The whole catalog, one square per snack, positions fixed by
 * `order` forever — only each square's color changes as `byId` refreshes,
 * so a color transition (see the CSS class below) is itself the "when did
 * this change" signal, with no separate flash/timer state to keep in sync. */
export function ShopGrid({
  order,
  byId,
  flags,
}: {
  order: string[];
  byId: Map<string, CatalogItem>;
  flags: Map<string, LiveSearchFlag>;
}) {
  return (
    <div
      className="grid gap-px"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${GRID_MIN_SQUARE_PX}px, 1fr))` }}
    >
      {order.map((id) => {
        const s = byId.get(id);
        if (!s) return <div key={id} className="aspect-square" />;
        const state = gridState(s, flags.get(id));
        const fill =
          state === "available"
            ? "bg-primary"
            : state === "filtered"
              ? "bg-emerald-500"
              : state === "stale"
                ? "bg-amber-500"
                : "bg-muted-foreground/40";
        const label =
          state === "available"
            ? "in stock"
            : state === "filtered"
              ? "sold out — document still in Pinecone, but flagged out of search"
              : state === "stale"
                ? "sold out — document still in Pinecone and a search can still return it"
                : "sold out — document deleted from Pinecone";
        return (
          <div key={id} title={`${s.name} — ${label}`} className={`aspect-square transition-colors duration-500 ${fill}`} />
        );
      })}
    </div>
  );
}
