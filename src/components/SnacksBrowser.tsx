"use client";

import { useMemo, useState } from "react";

import type { SnackEntry } from "@/lib/snacks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const PAGE_SIZE = 48;

type CategoryFilter = "all" | "savory" | "sweet";

export function SnacksBrowser({ entries }: { entries: SnackEntry[] }) {
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [page, setPage] = useState(0);

  const filtered = useMemo(
    () => (category === "all" ? entries : entries.filter((e) => e.category === category)),
    [entries, category],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  function selectCategory(next: CategoryFilter) {
    setCategory(next);
    setPage(0);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex gap-2">
        {(["all", "savory", "sweet"] as const).map((c) => (
          <Button
            key={c}
            variant={category === c ? "default" : "outline"}
            size="sm"
            onClick={() => selectCategory(c)}
          >
            {c === "all" ? "All" : c[0].toUpperCase() + c.slice(1)}
          </Button>
        ))}
      </div>

      <p className="font-mono text-xs text-muted-foreground">
        {filtered.length} of {entries.length} entries
        {pageCount > 1 && ` · page ${clampedPage + 1} of ${pageCount}`}
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((entry) => (
          <div key={entry.id} className="flex flex-col gap-2 border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-bold text-foreground">{entry.name}</h3>
              <Badge variant={entry.category === "sweet" ? "default" : "secondary"} className="shrink-0">
                {entry.category}
              </Badge>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">{entry.text}</p>
            <span className="font-mono text-[10px] text-muted-foreground/70">{entry.id}</span>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">No entries in this category.</p>
      )}

      {pageCount > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}>
            Previous
          </Button>
          <span className="font-mono text-xs text-muted-foreground">
            {clampedPage + 1} / {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={clampedPage >= pageCount - 1}
            onClick={() => setPage(clampedPage + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
