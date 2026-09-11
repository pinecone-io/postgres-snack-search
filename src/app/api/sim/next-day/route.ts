import { NextResponse } from "next/server";
import { advanceDay } from "@/db/queries";

export const runtime = "nodejs";

export async function POST() {
  try {
    const state = await advanceDay();
    // No row means the simulation state was never seeded. Reported as an
    // error rather than returned, because the client reads `currentDay`
    // straight off this response.
    if (!state) throw new Error("No simulation state — run `npm run db:seed` first.");
    return NextResponse.json(state);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
