import { NextResponse } from "next/server";
import { getAllSnacksForGrid } from "@/db/queries";

export const runtime = "nodejs";

// Backs the whole-shop overview grid: every snack's real-time sync state,
// polled on an interval by the client. Small columns only (no description
// text), so one row per snack stays cheap enough to poll every second.
export async function GET() {
  try {
    const snacks = await getAllSnacksForGrid();
    return NextResponse.json({ snacks });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
