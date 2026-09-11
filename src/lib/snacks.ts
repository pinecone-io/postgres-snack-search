// The shape of a snack as the /snacks browser renders it. Kept in its own
// module with no imports so a client component can take it as a prop type —
// the same reason the shopper roster lives in @/lib/shoppers. The rows come
// from Postgres (see getAllSnackEntries); nothing reads snacks.jsonl at
// runtime, only scripts/setupIndex.ts at setup time.

/** The only two categories in the catalog. Defined here, once, and imported
 * by the Drizzle schema, the queries, and the UI — so widening it is a single
 * edit rather than a hunt through string literals. */
export type SnackCategory = "savory" | "sweet";

export interface SnackEntry {
  id: string;
  name: string;
  text: string;
  category: SnackCategory;
}
