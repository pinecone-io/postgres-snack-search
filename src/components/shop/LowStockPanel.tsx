// Presentational; the polling that keeps this list current is in
// useShopSimulation.
export interface LowStockItem {
  id: string;
  name: string;
  stockQty: number;
  priceCents: number;
}

/** The shelves closest to selling out — the leading edge of the sync gap,
 * since these are the snacks about to disagree with the index. */
export function LowStockPanel({ items }: { items: LowStockItem[] }) {
  return (
    <div className="border border-border bg-background p-3">
      <p className="mb-2 font-mono text-xs font-bold tracking-wide text-muted-foreground uppercase">running low</p>
      {items.length === 0 && <p className="text-sm text-muted-foreground">Loading…</p>}
      <ul className="flex flex-col gap-1">
        {items.map((s) => (
          <li key={s.id} className="flex items-center justify-between text-sm transition-all duration-300">
            <span className="truncate text-foreground">{s.name}</span>
            <span className="font-mono text-xs font-bold text-primary">{s.stockQty} left</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
