import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import type { SnackCategory } from "@/lib/snacks";

// The shop's stockroom ledger: what's on the shelf, what it costs, and how
// many are left. This is the one place that gets edited directly — search
// results are a search of a copy of this data, refreshed at night.
export const snacks = pgTable("snacks", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  text: text("text").notNull(),
  // Narrowed at the type level rather than described in a comment, so every
  // query returns the union and callers don't have to re-assert it.
  category: text("category").notNull().$type<SnackCategory>(),
  priceCents: integer("price_cents").notNull(),
  stockQty: integer("stock_qty").notNull(),
  // Whether this snack's document is physically present in Pinecone. Only a
  // real delete moves it: night sync flips it to false when it removes a
  // sold-out document, and back to true when it re-adds one. A sale never
  // touches it — live sync's `in_stock` flag is a query-time filter, not a
  // removal, and flipping this from the sale path would make night sync
  // skip the delete and leave the document in the index for good.
  inIndex: boolean("in_index").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// One row per sale attempt during the simulation. Doubles as the shop's
// sales ledger and as the recorded trace of a simulation run: replaying a
// day is just reading these rows back in order.
export const inventoryEvents = pgTable("inventory_events", {
  id: serial("id").primaryKey(),
  // Null when the shopper's search came back empty — there's no snack to
  // point at, but the attempt (and the miss) is still worth recording.
  snackId: text("snack_id").references(() => snacks.id),
  day: integer("day").notNull(),
  tick: integer("tick").notNull(),
  agentId: text("agent_id").notNull(),
  query: text("query").notNull(),
  outcome: text("outcome").notNull(), // "bought" | "not_found" | "sold_out"
  qty: integer("qty").notNull(), // 1 on a sale, 0 otherwise
  priceCents: integer("price_cents"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// A single row tracking where the simulation is right now, so "Next day"
// and "Run night sync" have somewhere to read and advance from.
export const simulationState = pgTable("simulation_state", {
  id: integer("id").primaryKey().default(1),
  currentDay: integer("current_day").notNull().default(1),
  tickInDay: integer("tick_in_day").notNull().default(0),
  // Whether every doc in Pinecone has an `in_stock` field yet. Live sync
  // mode filters on that field, and a filter that excludes documents where
  // the field is missing entirely (confirmed empirically) would return
  // nothing until a full re-upsert has run — so the UI gates the Live
  // toggle on this rather than risk a silently empty search.
  pineconeBackfilled: boolean("pinecone_backfilled").notNull().default(false),
});
