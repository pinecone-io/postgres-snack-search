import { NextResponse } from "next/server";
import { getSimulationState, getStockroomCounts } from "@/db/queries";

export const runtime = "nodejs";

export async function GET() {
  try {
    const [state, counts] = await Promise.all([getSimulationState(), getStockroomCounts()]);
    return NextResponse.json({ state, counts });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
