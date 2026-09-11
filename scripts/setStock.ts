// Sets every snack's stock to the same number, without touching Pinecone.
//
// This exists for demoing and testing. Restock (`db:seed`) gives each snack a
// randomized 5-40 units, which is realistic but slow to watch: with a
// thousand snacks it takes a long run before anything actually sells out, and
// sellouts are the whole point of the shop simulation. `npm run stock -- 1`
// puts one unit on every shelf, so the first shopper to pick something sells
// it out and both sync modes show their behavior immediately.
//
// Deliberately Postgres-only: it changes stock, which Pinecone never carries
// (see the note on `in_stock` in src/lib/snacksPinecone.ts), so there's
// nothing to re-sync. `in_index` and the `in_stock` flags are left exactly as
// they were, so this doesn't disturb whatever sync state you're looking at.
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { snacks } from "../src/db/schema";

const qty = Number(process.argv[2] ?? 1);
if (!Number.isInteger(qty) || qty < 0) {
  console.error(`Usage: npm run stock -- <non-negative integer>  (got "${process.argv[2]}")`);
  process.exit(1);
}

db.update(snacks)
  .set({ stockQty: qty, updatedAt: new Date() })
  .then(() => db.select({ n: sql<number>`count(*)` }).from(snacks))
  .then(([{ n }]) => {
    console.log(`Set stock to ${qty} for all ${n} snacks.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
