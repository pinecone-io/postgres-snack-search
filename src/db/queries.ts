import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./client";
import { inventoryEvents, simulationState, snacks } from "./schema";
import type { SnackCategory } from "@/lib/snacks";

export interface Snack {
  id: string;
  name: string;
  text: string;
  category: SnackCategory;
  priceCents: number;
  stockQty: number;
}

/**
 * Looks up snacks by id and returns them in the same order the ids were
 * given — Pinecone's ranking, not Postgres's — dropping any id that no
 * longer exists. `WHERE id = ANY(...)` doesn't preserve order on its own,
 * so this maps the rows and re-walks the original id list.
 */
export async function hydrateSnacks(ids: string[]): Promise<Snack[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: snacks.id,
      name: snacks.name,
      text: snacks.text,
      category: snacks.category,
      priceCents: snacks.priceCents,
      stockQty: snacks.stockQty,
    })
    .from(snacks)
    .where(inArray(snacks.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is Snack => r !== undefined);
}

export interface BoughtSnack {
  id: string;
  stockQty: number;
  priceCents: number;
}

/**
 * Attempts to sell one unit of a snack. Atomic: the WHERE clause only
 * matches (and decrements) a row that still has stock, so two concurrent
 * attempts can't both succeed against the last unit. Returns the updated
 * row, or null if there was nothing left to sell (or the id doesn't exist).
 */
export async function buyOne(id: string): Promise<BoughtSnack | null> {
  const rows = await db
    .update(snacks)
    .set({ stockQty: sql`${snacks.stockQty} - 1`, updatedAt: new Date() })
    .where(and(eq(snacks.id, id), sql`${snacks.stockQty} > 0`))
    .returning({ id: snacks.id, stockQty: snacks.stockQty, priceCents: snacks.priceCents });
  return rows[0] ?? null;
}

export async function logSaleAttempt(entry: {
  snackId: string | null;
  day: number;
  tick: number;
  agentId: string;
  query: string;
  outcome: "bought" | "not_found" | "sold_out";
  qty: number;
  priceCents?: number;
}) {
  await db.insert(inventoryEvents).values(entry);
}

/** Snacks that have stock but aren't searchable yet — tonight's upserts. */
export async function getSnacksToAddToIndex() {
  return db
    .select()
    .from(snacks)
    .where(and(eq(snacks.inIndex, false), sql`${snacks.stockQty} > 0`));
}

/** Snacks that sold out but are still searchable — tonight's deletes. */
export async function getSnacksToRemoveFromIndex() {
  return db
    .select({ id: snacks.id })
    .from(snacks)
    .where(and(eq(snacks.inIndex, true), eq(snacks.stockQty, 0)));
}

export async function markIndexed(ids: string[], inIndex: boolean) {
  if (ids.length === 0) return;
  await db.update(snacks).set({ inIndex, updatedAt: new Date() }).where(inArray(snacks.id, ids));
}

/**
 * The snacks closest to selling out — the thing worth watching, since with
 * over a thousand snacks the aggregate in-stock count barely moves, but a
 * handful of specific items visibly ticking down to zero is easy to follow.
 */
export async function getLowStockSnacks(limit = 8) {
  return db
    .select({ id: snacks.id, name: snacks.name, stockQty: snacks.stockQty, priceCents: snacks.priceCents })
    .from(snacks)
    .where(sql`${snacks.stockQty} > 0`)
    .orderBy(snacks.stockQty)
    .limit(limit);
}

/**
 * Every snack's real-time sync state, for the whole-shop overview grid.
 * Ordered by category then name then id — a fixed, deterministic sort so
 * the grid's positions never move between polls, only their colors. Three
 * states derivable from just these two columns: `stockQty > 0` is
 * available; `stockQty = 0 && inIndex` is stale (sold out, but the
 * document is still physically in Pinecone — the sync gap, made visible
 * instead of just counted); `stockQty = 0 && !inIndex` is gone (sold out
 * and actually removed).
 */
export async function getAllSnacksForGrid() {
  return db
    .select({ id: snacks.id, name: snacks.name, category: snacks.category, stockQty: snacks.stockQty, inIndex: snacks.inIndex })
    .from(snacks)
    .orderBy(snacks.category, snacks.name, snacks.id);
}

/**
 * Counts backing the aggregate stats: what's really in stock (`inStock`)
 * vs. what's still physically present in Pinecone (`searchable`, from
 * `inIndex`) — the same raw, mode-independent numbers the whole-shop grid
 * uses for its available/stale/gone split (see getAllSnacksForGrid). Only
 * a real delete (night sync) ever moves `searchable`; live sync's flag
 * flip is a query-time filter, not a change to what's physically indexed,
 * so it doesn't show up here — see the live-sale path in simulation.ts.
 */
export async function getStockroomCounts() {
  const [row] = await db
    .select({
      inStock: sql<number>`count(*) filter (where ${snacks.stockQty} > 0)`,
      searchable: sql<number>`count(*) filter (where ${snacks.inIndex})`,
    })
    .from(snacks);
  return row;
}

/** Every snack's descriptive fields, for the /snacks browser. Ordered by id
 * so the list is stable between requests. */
export async function getAllSnackEntries() {
  return db
    .select({ id: snacks.id, name: snacks.name, text: snacks.text, category: snacks.category })
    .from(snacks)
    .orderBy(snacks.id);
}

/** How many snacks exist. Read at request time rather than hardcoded, so
 * the shop works unchanged after someone extends the catalog with
 * `npm run generate:snacks`. */
export async function getSnackCount(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(snacks);
  return Number(row.n);
}

export async function getSimulationState() {
  const [row] = await db.select().from(simulationState).where(eq(simulationState.id, 1));
  return row;
}

/** Flips once restockShelves has re-upserted every doc with an `in_stock`
 * field — the gate the UI uses to decide whether Live sync mode is safe to
 * turn on (see the `in_stock` field's doc comment in snacksPinecone.ts). */
export async function setPineconeBackfilled(value: boolean) {
  await db.update(simulationState).set({ pineconeBackfilled: value }).where(eq(simulationState.id, 1));
}

export async function advanceTick() {
  const [row] = await db
    .update(simulationState)
    .set({ tickInDay: sql`${simulationState.tickInDay} + 1` })
    .where(eq(simulationState.id, 1))
    .returning();
  return row;
}

export async function advanceDay() {
  const [row] = await db
    .update(simulationState)
    .set({ currentDay: sql`${simulationState.currentDay} + 1`, tickInDay: 0 })
    .where(eq(simulationState.id, 1))
    .returning();
  return row;
}
