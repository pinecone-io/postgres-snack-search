// Presentational: every value is passed in, so no state and no fetching.

import { SHOPPERS } from "@/lib/shoppers";
import type { Receipt } from "@/lib/shopView";

// The shopper slots, in a fixed order that matches SHOPPERS so the panel's
// card positions are stable for the app's whole life.
const SHOPPER_IDS = SHOPPERS.map((s) => s.id);

/**
 * One permanent slot per shopper, each holding only that shopper's most
 * recent trip, plus a fixed-height detail area below them.
 *
 * The layout is deliberately rigid: the same six cards in the same places
 * for the app's whole life, and a detail area that's always present whether
 * or not anything is selected. A finished trip repaints one card's text in
 * place — nothing is inserted, removed, or reordered, so the page never
 * moves under the reader while shoppers are running. The previous design (an
 * append-only feed) grew and pushed everything below it down on every tick,
 * which made the whole page feel jumpy.
 */
export function ShopperPanel({
  trips,
  selected,
  pinned,
  lastSync,
  onSelect,
}: {
  trips: Map<string, Receipt>;
  selected: string | null;
  pinned: boolean;
  lastSync: { label: string; detail: string } | null;
  onSelect: (id: string) => void;
}) {
  const detail = selected ? trips.get(selected) : undefined;
  return (
    <div className="flex flex-col gap-3 border border-border bg-background p-3" data-panel="shoppers">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-xs font-bold tracking-wide text-muted-foreground uppercase">
          shoppers — what each one&apos;s last search returned
        </p>
        {lastSync && (
          <p className="font-mono text-[10px] tracking-wide text-primary uppercase">
            {lastSync.label}: {lastSync.detail}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {SHOPPER_IDS.map((id) => {
          const t = trips.get(id);
          const isSelected = selected === id;
          return (
            <button
              key={id}
              data-shopper={id}
              onClick={() => onSelect(id)}
              className={`flex h-20 flex-col items-start justify-between border p-2 text-left transition-colors duration-500 ${
                isSelected ? "border-primary bg-primary/5" : "border-border bg-card hover:border-primary/40"
              }`}
            >
              <span className="flex w-full items-baseline justify-between gap-2">
                <span className="font-mono text-xs font-bold text-foreground">{id}</span>
                {t && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {t.brainUsed === "llm" ? "llm" : "templated"}
                  </span>
                )}
              </span>
              <span className="line-clamp-2 w-full text-xs text-muted-foreground">
                {t ? `“${t.query}”` : "hasn't shopped yet"}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {t ? `${t.purchases.length} bought · ${(t.totalCents / 100).toFixed(2)}` : "—"}
              </span>
            </button>
          );
        })}
      </div>

      {/* Fixed height, not min-height: a receipt's row count varies with how
          many candidates got picked, and letting the container size to its
          contents moved everything below it on almost every trip. Overflow
          scrolls inside instead. */}
      <div className="h-56 overflow-y-auto border-t border-border pt-3" data-panel="shopper-detail">
        {detail ? (
          <ReceiptCard r={detail} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Press Start, or click a shopper above once they&apos;ve searched, to see every candidate Pinecone
            ranked for them and what Postgres said about each one.
          </p>
        )}
      </div>
      <p className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
        {pinned ? "held — click the same card again to follow the newest trip" : "following the newest trip"}
      </p>
    </div>
  );
}

/** The micro proof, per search: exactly what Pinecone ranked, exactly what
 * Postgres said about each one, and what actually got bought — reads like
 * test output rather than an abstract animation, on purpose. */
function ReceiptCard({ r }: { r: Receipt }) {
  const staleShown = r.rows.filter((row) => !row.inStock).length;
  return (
    <div className="animate-in fade-in slide-in-from-top-2 border-b border-border/50 py-2 text-sm duration-300">
      <p className="text-foreground">
        <span className="font-bold">{r.agentId}</span> <span className="text-muted-foreground">({r.brainUsed})</span>{" "}
        searched <span className="italic">&quot;{r.query}&quot;</span>
        {r.fallbackReason && <span className="text-muted-foreground"> — LLM call failed, used templated instead</span>}
      </p>
      <ul className="mt-1 flex flex-col gap-0.5 pl-1 font-mono text-xs">
        {r.rows.map((row, i) => (
          <li
            key={row.id}
            className={`flex items-center gap-1.5 ${row.inStock ? "text-foreground" : "text-muted-foreground line-through decoration-muted-foreground/50"}`}
          >
            <span className="w-4 shrink-0 text-right text-muted-foreground/70">{i + 1}.</span>
            <span className="flex-1 truncate">{row.name}</span>
            {!row.inStock ? (
              <span className="shrink-0 text-muted-foreground no-underline">✗ stale</span>
            ) : row.picked ? (
              <span className="shrink-0 text-primary no-underline">
                🛒 {row.outcome === "bought" ? "bought" : "lost the race"}
              </span>
            ) : (
              <span className="shrink-0 text-primary no-underline">✓</span>
            )}
          </li>
        ))}
      </ul>
      {r.hiddenCount > 0 && (
        <p className="pl-1 text-xs text-muted-foreground">
          +{r.hiddenCount} more ranked{r.hiddenStaleCount > 0 ? `, ${r.hiddenStaleCount} of those stale` : ""}
        </p>
      )}
      <p className="pl-1 text-xs">
        {r.purchases.length > 0 ? (
          <span className="font-mono font-bold text-primary">
            Cart: {r.purchases.length} item{r.purchases.length > 1 ? "s" : ""}, ${(r.totalCents / 100).toFixed(2)}
          </span>
        ) : (
          <span className="text-muted-foreground">Cart came up empty</span>
        )}
        {staleShown > 0 && (
          <span className="text-muted-foreground">
            {" "}
            · {staleShown} stale hit{staleShown > 1 ? "s" : ""} caught and hidden by Postgres
          </span>
        )}
      </p>
    </div>
  );
}
