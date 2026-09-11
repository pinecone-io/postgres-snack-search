import { NextResponse } from "next/server";
import { fetchLiveSearchFlags } from "@/lib/snacksPinecone";

export const runtime = "nodejs";

// Upper bound on ids per request, so a bug in the caller can't turn one
// poll into a hundred Pinecone fetches. The client asks about far fewer
// than this in practice — see refreshIndexFlags in
// src/components/shop/useShopSimulation.ts.
const MAX_IDS = 600;

// Backs the grid's and the reconciliation bar's "can search still return
// this?" state by reading `in_stock` off Pinecone directly. POST rather
// than GET because the client supplies the id list: it only asks about
// documents whose flag it doesn't already consider settled, which keeps
// this to a handful of ids per poll instead of every sold-out snack.
export async function POST(req: Request) {
  try {
    const { ids } = (await req.json()) as { ids?: string[] };
    if (!Array.isArray(ids) || ids.length === 0) return NextResponse.json({ flags: {} });
    const flags = await fetchLiveSearchFlags(ids.slice(0, MAX_IDS));
    return NextResponse.json({ flags });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
