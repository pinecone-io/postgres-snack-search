// Two ways to fill the shop, deliberately kept separate. They were one
// function that read the prepared JSONL for both jobs, which made Restock
// 502 on any deployment — that file is 23MB and gitignored, so it isn't
// there — and meant the app's central claim, that Pinecone is rebuildable
// from Postgres alone, was demonstrated by re-reading the file the index
// came from. Keeping `npm run db:seed` on the file also means editing
// snacks.jsonl and re-running setup actually reloads the catalog.
import { readFileSync } from "node:fs";
import { asc, sql } from "drizzle-orm";
import { db } from "./client";
import { inventoryEvents, simulationState, snacks } from "./schema";
import { upsertToIndex } from "@/lib/snacksPinecone";
import type { SnackCategory } from "@/lib/snacks";

const SEED = 42;
const PREPARED_FILE = "snacks-for-pinecone.jsonl";

// How many documents go to Pinecone per call, and how many rows per insert.
const UPSERT_BATCH = 96;
const INSERT_BATCH = 200;

// Units per snack after a restock. The default range is realistic, but slow
// to demo: with 1,160 snacks it takes a long run before anything sells out,
// and sellouts are what the two sync modes differ on. Set SEED_STOCK_QTY=1
// in .env to put a single unit on every shelf, so the first shopper to pick
// something sells it out. This is read here, rather than only fixed up
// afterward with `npm run stock`, because Restock is not optional: Live sync
// mode stays locked until a Restock has written the `in_stock` field to
// every Pinecone document, so any stock level set by hand gets overwritten
// the moment you go set up Live mode.
const FIXED_STOCK_QTY = process.env.SEED_STOCK_QTY ? Number(process.env.SEED_STOCK_QTY) : null;
if (FIXED_STOCK_QTY !== null && (!Number.isInteger(FIXED_STOCK_QTY) || FIXED_STOCK_QTY < 1)) {
  throw new Error(`SEED_STOCK_QTY must be a positive integer, got "${process.env.SEED_STOCK_QTY}"`);
}

// Fixed seed, so building the catalog twice from the same file produces the
// same prices and the same opening stock. Only `buildCatalog` uses it —
// a restock leaves prices alone (a shop that restocks doesn't re-price
// itself) and draws new stock levels in SQL.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PreparedDoc {
  _id: string;
  name: string;
  text: string;
  category: SnackCategory;
  embedding: number[];
}

function loadPreparedDocs(file: string): PreparedDoc[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    throw new Error(`${file} is missing — run \`npm run setup:index\` to generate it.`);
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Cold start: replaces the catalog with the contents of the prepared JSONL,
 * then upserts every document into Pinecone so the index matches the rows
 * that were just written.
 *
 * Truncates `snacks`, `inventory_events` and `simulation_state` — it builds
 * the catalog rather than refilling it, so this is not what the Restock
 * button calls.
 */
export async function buildCatalog(options: { syncIndex?: boolean; file?: string } = {}) {
  const { syncIndex = true, file = PREPARED_FILE } = options;
  const random = mulberry32(SEED);
  const docs = loadPreparedDocs(file);

  const rows = docs.map((doc) => ({
    id: doc._id,
    name: doc.name,
    text: doc.text,
    category: doc.category,
    priceCents: Math.round(150 + random() * 550), // $1.50–$7.00
    // Drawn from the seeded RNG either way, so the price sequence above
    // stays identical whether or not stock is being overridden.
    stockQty: ((n) => FIXED_STOCK_QTY ?? n)(Math.round(5 + random() * 35)), // 5–40 units by default
    embedding: doc.embedding,
    inIndex: true,
  }));

  await db.execute(sql`truncate table ${inventoryEvents}, ${snacks}, ${simulationState} restart identity cascade`);

  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    await db.insert(snacks).values(rows.slice(i, i + INSERT_BATCH));
  }
  await db.insert(simulationState).values({ id: 1, currentDay: 1, tickInDay: 0, pineconeBackfilled: syncIndex });

  if (syncIndex) {
    for (let i = 0; i < docs.length; i += UPSERT_BATCH) {
      await upsertToIndex(docs.slice(i, i + UPSERT_BATCH).map((doc) => ({ ...doc, in_stock: true })));
    }
  }

  return { snackCount: rows.length };
}

/**
 * What the Restock button does: refills every shelf, clears the day's sales,
 * and rebuilds the Pinecone index from the `snacks` table.
 *
 * Postgres keeps each snack's embedding next to the row it describes, so
 * this needs no embedding calls and no prepared file — the index is derived
 * from the system of record, which is the point being taught.
 *
 * Prices are left alone. A restock puts stock back on shelves; it doesn't
 * re-price the shop.
 */
export async function restockShelves() {
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(snacks);
  if (count === 0) {
    throw new Error("The snacks table is empty — run `npm run setup` to build the catalog first.");
  }

  await db.update(snacks).set({
    // 5–40 units, matching buildCatalog's range, unless SEED_STOCK_QTY pins it.
    stockQty: FIXED_STOCK_QTY ?? sql`5 + floor(random() * 36)`,
    // Night sync deletes sold-out documents from Pinecone and flips this to
    // false; the re-upsert below puts every one of them back, so every row
    // is searchable again by the time this returns.
    inIndex: true,
    updatedAt: new Date(),
  });

  await db.execute(sql`truncate table ${inventoryEvents} restart identity`);
  await db.delete(simulationState);
  await db.insert(simulationState).values({ id: 1, currentDay: 1, tickInDay: 0, pineconeBackfilled: true });

  // Paged rather than loaded at once: 1,160 × 1024 floats is a lot to hold
  // in memory for no reason, and Pinecone takes them a batch at a time
  // regardless.
  for (let offset = 0; offset < count; offset += UPSERT_BATCH) {
    const page = await db
      .select({
        _id: snacks.id,
        name: snacks.name,
        text: snacks.text,
        category: snacks.category,
        embedding: snacks.embedding,
      })
      .from(snacks)
      .orderBy(asc(snacks.id))
      .limit(UPSERT_BATCH)
      .offset(offset);
    if (page.length === 0) break;
    // Idempotent: re-upserting a document Pinecone already has is a no-op
    // in effect, so this doesn't need to know what was deleted mid-run.
    // `in_stock: true` on every doc is what makes Live sync mode's filter
    // safe to turn on afterward — a filter of `{in_stock: {$eq: true}}`
    // excludes a document missing the field just as surely as one flagged
    // false, so this backfill has to run before Live mode can return
    // anything (see pineconeBackfilled / the Live toggle's gating).
    await upsertToIndex(page.map((row) => ({ ...row, in_stock: true })));
  }

  return { snackCount: count };
}
