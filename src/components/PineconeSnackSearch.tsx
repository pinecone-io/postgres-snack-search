"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SnackHit, SnackSearchMode } from "@/lib/snacksPinecone";
import { CodePeek } from "@/components/CodePeek";
import { INDEX_SCHEMA_SOURCE, SAMPLE_DOCUMENT } from "@/lib/codeSamples";

const MODES: { value: SnackSearchMode; label: string }[] = [
  { value: "semantic", label: "Semantic" },
  { value: "keyword", label: "Keyword" },
  { value: "hybrid", label: "Hybrid" },
];

const SOURCE_LABEL: Record<SnackHit["source"], string> = {
  dense: "dense",
  bm25: "bm25",
  fused: "fused",
};

export function PineconeSnackSearch() {
  const [query, setQuery] = useState("something crunchy for a road trip");
  const [mode, setMode] = useState<SnackSearchMode>("semantic");
  const [hits, setHits] = useState<SnackHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  async function runSearch() {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/snacks-search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, mode }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "search failed");
      setHits(json.hits);
      setLatencyMs(json.meta.latencyMs);
    } catch (e) {
      setError((e as Error).message);
      setHits(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 border border-border bg-card p-6">
      <div>
        <p className="font-mono text-xs font-bold tracking-wide text-muted-foreground uppercase">
          live pinecone search
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Type in a query, using keywords (like &quot;chocolate&quot;) or cravings (&quot;I&apos;m craving something spicy and crispy&quot;)
        </p>
        <CodePeek
          summary="see the code"
          panels={[
            {
              label: "the index",
              code: INDEX_SCHEMA_SOURCE,
              caption: "scripts/setupIndex.ts · index snacks-hybrid · namespace __default__",
            },
            {
              label: "one document",
              code: SAMPLE_DOCUMENT,
              caption: "1,160 documents · 1,024-float embedding elided",
            },
          ]}
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSearch()}
          placeholder="Try a query…"
          className="flex-1"
        />
        <div className="flex gap-2">
          {MODES.map((m) => (
            <Button
              key={m.value}
              variant={mode === m.value ? "default" : "outline"}
              size="sm"
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </Button>
          ))}
          <Button size="sm" onClick={runSearch} disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {hits && (
        <>
          <p className="font-mono text-xs text-muted-foreground">
            {hits.length} hits · {mode} · {latencyMs}ms
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {hits.map((hit) => (
              <div key={hit.id} className="flex flex-col gap-2 border border-border bg-background p-4">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-bold text-foreground">{hit.name}</h3>
                  <Badge variant={hit.category === "sweet" ? "default" : "secondary"} className="shrink-0">
                    {hit.category}
                  </Badge>
                </div>
                <p className="text-sm leading-relaxed text-muted-foreground">{hit.text}</p>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-bold text-foreground">
                    ${(hit.priceCents / 100).toFixed(2)}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">{hit.stockQty} in stock</span>
                </div>
                <span className="font-mono text-[10px] text-muted-foreground/70">
                  {hit.id} · {SOURCE_LABEL[hit.source]} · {hit.score.toFixed(4)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
