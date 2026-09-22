// Real Postgres, skipped without DATABASE_URL. Run with `npm run test:db`.

import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";


let db: (typeof import("@/db/client"))["db"];
let snacks: (typeof import("@/db/schema"))["snacks"];
let buyOne: (typeof import("@/db/queries"))["buyOne"];
let hydrateSnacks: (typeof import("@/db/queries"))["hydrateSnacks"];

const PREFIX = "zz_test_";
const id = (suffix: string) => `${PREFIX}${suffix}`;

const row = (suffix: string, stockQty: number, priceCents = 100) => ({
  id: id(suffix),
  name: `test snack ${suffix}`,
  text: `a snack that exists only for tests (${suffix})`,
  category: "savory" as const,
  priceCents,
  stockQty,
  inIndex: true,
});

const created: string[] = [];

async function insert(...rows: ReturnType<typeof row>[]) {
  await db.insert(snacks).values(rows);
  created.push(...rows.map((r) => r.id));
}

describe.skipIf(!process.env.DATABASE_URL)("Postgres queries", () => {
  beforeAll(async () => {
    ({ db } = await import("@/db/client"));
    ({ snacks } = await import("@/db/schema"));
    ({ buyOne, hydrateSnacks } = await import("@/db/queries"));

    // Leftovers from an interrupted previous run would break the assertions
    // below, so clear the namespace first.
    await db.delete(snacks).where(inArray(snacks.id, [id("order-1"), id("order-2"), id("order-3"), id("race")]));
  });

  afterAll(async () => {
    if (created.length > 0) await db.delete(snacks).where(inArray(snacks.id, created));
  });

  describe("hydrateSnacks", () => {
    it("returns rows in the order the ids were given, not Postgres's order", async () => {
      // This is the one that silently ruins search quality if it regresses:
      // Pinecone's ranking lives entirely in the order of the id list, and
      // `WHERE id = ANY(...)` does not preserve it.
      await insert(row("order-1", 5), row("order-2", 5), row("order-3", 5));

      const requested = [id("order-3"), id("order-1"), id("order-2")];
      const got = await hydrateSnacks(requested);
      expect(got.map((s) => s.id)).toEqual(requested);

      // A different permutation must come back in that order too, so the
      // first result isn't just Postgres coincidentally agreeing.
      const reversed = [id("order-2"), id("order-3"), id("order-1")];
      expect((await hydrateSnacks(reversed)).map((s) => s.id)).toEqual(reversed);
    });

    it("drops ids that no longer exist instead of returning holes", async () => {
      const got = await hydrateSnacks([id("order-1"), id("does-not-exist"), id("order-2")]);
      expect(got.map((s) => s.id)).toEqual([id("order-1"), id("order-2")]);
    });

    it("returns nothing for an empty id list without querying", async () => {
      expect(await hydrateSnacks([])).toEqual([]);
    });

    it("carries the fields the storefront renders", async () => {
      const [got] = await hydrateSnacks([id("order-1")]);
      expect(got).toMatchObject({
        id: id("order-1"),
        name: "test snack order-1",
        category: "savory",
        priceCents: 100,
        stockQty: 5,
      });
    });
  });

  describe("buyOne", () => {
    it("really does run concurrent queries on separate connections", async () => {
      // Guard for the test below rather than for the app: if the pool ever
      // serialized these onto one connection, the race test would pass
      // without having raced anything, and would stop being evidence for the
      // atomicity claim it exists to check.
      const results = await Promise.all(
        Array.from({ length: 8 }, () => db.execute(sql`select pg_backend_pid() as pid`)),
      );
      const pids = new Set(results.map((r) => (r as unknown as { pid: number }[])[0].pid));
      expect(pids.size).toBeGreaterThan(1);
    });

    it("lets exactly one of many concurrent buyers take the last unit", async () => {
      // The app's core safety claim. The atomic decrement is what makes a
      // burst of concurrent shoppers safe rather than a double-sold bug, so
      // this asserts on the winner/loser split — not just the final stock,
      // which a serialized run would also satisfy.
      await insert(row("race", 1));

      const attempts = await Promise.all(Array.from({ length: 8 }, () => buyOne(id("race"))));
      const winners = attempts.filter((a) => a !== null);
      const losers = attempts.filter((a) => a === null);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(7);
      expect(winners[0]!.stockQty).toBe(0);

      const [after] = await hydrateSnacks([id("race")]);
      expect(after.stockQty).toBe(0);
    });

    it("refuses to sell below zero", async () => {
      expect(await buyOne(id("race"))).toBeNull();
      const [after] = await hydrateSnacks([id("race")]);
      expect(after.stockQty).toBe(0);
    });

    it("decrements one unit at a time and reports the price", async () => {
      await insert(row("order-1-again", 3, 250));
      const first = await buyOne(id("order-1-again"));
      expect(first).toMatchObject({ stockQty: 2, priceCents: 250 });
      const second = await buyOne(id("order-1-again"));
      expect(second!.stockQty).toBe(1);
    });

    it("returns null for an id that does not exist", async () => {
      expect(await buyOne(id("never-created"))).toBeNull();
    });
  });
});
