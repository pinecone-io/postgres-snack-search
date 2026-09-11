import { NextRequest, NextResponse } from "next/server";

import { searchSnacks, type SnackSearchMode } from "@/lib/snacksPinecone";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { query, mode } = (await req.json()) as { query?: string; mode?: SnackSearchMode };
  if (!query?.trim()) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }
  if (mode !== "semantic" && mode !== "keyword" && mode !== "hybrid") {
    return NextResponse.json({ error: "mode must be semantic, keyword, or hybrid" }, { status: 400 });
  }

  const started = Date.now();
  try {
    const hits = await searchSnacks(query, mode);
    return NextResponse.json({ hits, meta: { mode, latencyMs: Date.now() - started } });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
