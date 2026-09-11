import { NextResponse } from "next/server";
import { getLowStockSnacks } from "@/db/queries";

export const runtime = "nodejs";

export async function GET() {
  try {
    const snacks = await getLowStockSnacks(8);
    return NextResponse.json({ snacks });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
