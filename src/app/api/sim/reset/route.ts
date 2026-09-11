import { NextResponse } from "next/server";
import { restockShelves } from "@/db/seed";

export const runtime = "nodejs";

// Refills every shelf and rebuilds the entire Pinecone index from the
// `snacks` table alone — names, categories and stored embeddings. No
// prepared file, no embedding calls, so this works on a deployment.
export async function POST() {
  try {
    const result = await restockShelves();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
