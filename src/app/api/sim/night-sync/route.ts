import { NextResponse } from "next/server";
import { getSnacksToAddToIndex, getSnacksToRemoveFromIndex, markIndexed } from "@/db/queries";
import { deleteFromIndex, upsertToIndex } from "@/lib/snacksPinecone";

export const runtime = "nodejs";

// The one moment the search index catches up to the stockroom: anything
// sold out gets pulled from search for good, anything newly stocked gets
// added. Everything in between — the whole day's browsing and buying —
// happens against whatever the index looked like this morning.
export async function POST() {
  try {
    const [toRemove, toAdd] = await Promise.all([getSnacksToRemoveFromIndex(), getSnacksToAddToIndex()]);

    if (toRemove.length > 0) {
      await deleteFromIndex(toRemove.map((s) => s.id));
      await markIndexed(
        toRemove.map((s) => s.id),
        false,
      );
    }

    if (toAdd.length > 0) {
      await upsertToIndex(
        toAdd.map((s) => ({
          _id: s.id,
          name: s.name,
          text: s.text,
          category: s.category,
          embedding: s.embedding,
          in_stock: true,
        })),
      );
      await markIndexed(
        toAdd.map((s) => s.id),
        true,
      );
    }

    return NextResponse.json({ removed: toRemove.length, added: toAdd.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
