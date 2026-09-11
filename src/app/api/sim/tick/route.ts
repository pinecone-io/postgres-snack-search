import { NextRequest, NextResponse } from "next/server";
import { runTick } from "@/lib/simulation";
import type { ShopperBrain } from "@/lib/shopperBrain";
import type { SyncMode } from "@/lib/snacksPinecone";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { brain, syncMode } = (await req.json().catch(() => ({}))) as { brain?: ShopperBrain; syncMode?: SyncMode };
  try {
    const result = await runTick(brain === "llm" ? "llm" : "templated", syncMode === "live" ? "live" : "batch");
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
