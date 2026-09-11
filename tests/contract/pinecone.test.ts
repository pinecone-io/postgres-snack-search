// Contract tests against the real `snacks-hybrid` index, skipped without
// PINECONE_API_KEY. Run with `npm run test:contract` — deliberately outside
// `npm test`, so a rate-limited or slow index can't fail an ordinary run.
//
// These don't test the app's code so much as the assumptions the app is built
// on: partial-field updates, how `$eq: true` treats a missing field, the
// analyzer settings keyword search depends on, and how multiple scoring
// clauses combine. Each was established by hand against a live index.

import { Pinecone } from "@pinecone-database/pinecone";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Imported lazily in beforeAll: `@/lib/snacksPinecone` builds a Pinecone
// client at module load and reads a validated env, so a static import would
// throw for anyone without a key before describe.skipIf could skip the file.
let fetchLiveSearchFlags: (typeof import("@/lib/snacksPinecone"))["fetchLiveSearchFlags"];

const NS = "__tests__";
const INDEX = "snacks-hybrid";
const DIMENSION = 1024;

// Upserts are indexed asynchronously — a search or fetch immediately after
// one legitimately returns nothing. Everything here polls rather than sleeps
// a fixed amount, so a slow index makes the suite slower, not flaky.
const DEADLINE_MS = 45_000;
const POLL_MS = 1_500;

const key = process.env.PINECONE_API_KEY;
const pc = key ? new Pinecone({ apiKey: key }) : null;
// Namespace is bound to the handle in 2026-07, so the isolation assertion
// needs its own handle rather than a different argument.
const index = pc ? pc.index({ name: INDEX, namespace: NS }) : null;
const defaultIndex = pc ? pc.index({ name: INDEX, namespace: "__default__" }) : null;

const embedding = (seed: number) => Array.from({ length: DIMENSION }, (_, i) => Math.sin(seed + i) * 0.01);

const doc = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id,
  name: `contract test ${id}`,
  text: `a document that exists only for contract tests (${id})`,
  category: "savory",
  embedding: embedding(id.length),
  ...over,
});

const IDS = {
  partial: "zz_contract_partial",
  flagged: "zz_contract_flagged_false",
  missing: "zz_contract_no_flag",
  present: "zz_contract_flag_true",
};

/** Polls until `check` passes or the deadline expires, so tests wait exactly
 * as long as the index actually needs. */
async function until<T>(what: string, get: () => Promise<T>, check: (v: T) => boolean): Promise<T> {
  const started = Date.now();
  let last: T = await get();
  while (!check(last)) {
    if (Date.now() - started > DEADLINE_MS) {
      throw new Error(`timed out after ${DEADLINE_MS}ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    last = await get();
  }
  return last;
}

type FetchedDocs = Record<string, Record<string, unknown> | undefined>;

async function fetchDocs(ids: string[], fields: string[]): Promise<FetchedDocs> {
  const { documents } = await index!.documents.fetch({ ids, includeFields: fields });
  return documents as FetchedDocs;
}

describe.skipIf(!key)("Pinecone document-schema contract", () => {
  beforeAll(async () => {
    ({ fetchLiveSearchFlags } = await import("@/lib/snacksPinecone"));

    await index!.documents.upsert({
      documents: [
        doc(IDS.partial, { in_stock: true }),
        doc(IDS.flagged, { in_stock: false }),
        doc(IDS.missing), // deliberately no `in_stock` field at all
        doc(IDS.present, { in_stock: true }),
      ],
    });
    await until(
      "the test documents to be fetchable",
      () => fetchDocs(Object.values(IDS), ["name"]),
      (docs) => Object.values(IDS).every((id) => docs[id] !== undefined),
    );
  }, DEADLINE_MS + 10_000);

  afterAll(async () => {
    if (index) await index.documents.delete({ ids: Object.values(IDS) });
  });

  it("keeps the test namespace isolated from the shop's data", async () => {
    // Everything below writes to the index the running app uses. If this ever
    // fails, the rest of this suite is corrupting the developer's catalog.
    const { documents } = await defaultIndex!.documents.fetch({
      ids: Object.values(IDS),
      includeFields: ["name"],
    });
    expect(Object.keys(documents ?? {})).toEqual([]);
  });

  it("treats documents.update as a partial-field patch, not a replace", async () => {
    // The premise of live sync's cost claim: flipping one flag must not
    // require re-sending the embedding. If this regresses, `setLiveInStock`
    // silently starts destroying documents.
    const before = (await fetchDocs([IDS.partial], ["name", "text", "category", "embedding"]))[IDS.partial]!;
    expect(before.name).toBe(`contract test ${IDS.partial}`);
    expect((before.embedding as number[]).length).toBe(DIMENSION);

    await index!.documents.update({ documents: [{ _id: IDS.partial, in_stock: false }] });

    const after = await until(
      "the flag flip to land",
      () => fetchDocs([IDS.partial], ["name", "text", "category", "embedding", "in_stock"]),
      (docs) => docs[IDS.partial]?.in_stock === false,
    );
    const patched = after[IDS.partial]!;

    expect(patched.in_stock).toBe(false);
    expect(patched.name).toBe(before.name);
    expect(patched.text).toBe(before.text);
    expect(patched.category).toBe(before.category);
    expect((patched.embedding as number[]).length).toBe(DIMENSION);
    expect(patched.embedding).toEqual(before.embedding);
  });

  it("excludes a document whose in_stock flag is false from a $eq: true filter", async () => {
    const matches = await until(
      "the flagged document to be searchable",
      async () => {
        const res = await index!.documents.search({
          topK: 20,
          scoreBy: [{ type: "dense_vector", field: "embedding", values: embedding(IDS.flagged.length) }],
          includeFields: ["in_stock"],
        });
        return res.matches;
      },
      (m) => m.some((x) => x._id === IDS.flagged),
    );
    expect(matches.map((m) => m._id)).toContain(IDS.flagged);

    const filtered = await index!.documents.search({
      topK: 20,
      scoreBy: [{ type: "dense_vector", field: "embedding", values: embedding(IDS.flagged.length) }],
      includeFields: ["in_stock"],
      filter: { in_stock: { $eq: true } },
    });
    expect(filtered.matches.map((m) => m._id)).not.toContain(IDS.flagged);
  });

  it("also excludes a document that has no in_stock field at all", async () => {
    // This is why Live sync stays locked until a Restock has backfilled the
    // field: an absent field is excluded exactly like an explicit false, so
    // switching to Live mode on an un-backfilled index searches into silence.
    const filtered = await index!.documents.search({
      topK: 50,
      scoreBy: [{ type: "dense_vector", field: "embedding", values: embedding(IDS.missing.length) }],
      includeFields: ["in_stock"],
      filter: { in_stock: { $eq: true } },
    });
    expect(filtered.matches.map((m) => m._id)).not.toContain(IDS.missing);
  });

  it("still returns flagged-true documents through the same filter", async () => {
    // The negative tests above would also pass if the filter matched nothing
    // at all, so pin the positive case too.
    const filtered = await until(
      "the in-stock document to pass the filter",
      async () => {
        const res = await index!.documents.search({
          topK: 50,
          scoreBy: [{ type: "dense_vector", field: "embedding", values: embedding(IDS.present.length) }],
          includeFields: ["in_stock"],
          filter: { in_stock: { $eq: true } },
        });
        return res.matches;
      },
      (m) => m.some((x) => x._id === IDS.present),
    );
    expect(filtered.map((m) => m._id)).toContain(IDS.present);
    for (const m of filtered) expect((m as unknown as { in_stock?: boolean }).in_stock).toBe(true);
  });

  it("returns ids and scores only when includeFields is empty", async () => {
    // The architectural rule this app is built to demonstrate: Pinecone hands
    // back a ranking, and Postgres supplies every fact a shopper sees.
    // Polled, like every other search here: beforeAll confirms the fixtures
    // are *fetchable*, which happens before they are *searchable*. Asserting
    // on an unpolled search made this test fail intermittently.
    const matches = await until(
      "the fixtures to become searchable",
      async () => {
        const res = await index!.documents.search({
          topK: 5,
          scoreBy: [{ type: "dense_vector", field: "embedding", values: embedding(3) }],
          includeFields: [],
        });
        return res.matches;
      },
      (m) => m.length > 0,
    );
    for (const m of matches) {
      expect(m._id).toBeTypeOf("string");
      expect(m._score).toBeTypeOf("number");
      expect(Object.keys(m).filter((k) => !k.startsWith("_"))).toEqual([]);
    }
  });

  it("reports a document Pinecone has never heard of as absent", async () => {
    // The app's own mapping, on the one branch that needs no fixture. Read
    // only, so it is safe to run against the live namespace.
    const flags = await fetchLiveSearchFlags(["zz_contract_definitely_not_a_real_id"]);
    expect(flags).toEqual({ zz_contract_definitely_not_a_real_id: "absent" });
  });

  it("reads flags back for many ids in one call", async () => {
    const flags = await fetchLiveSearchFlags(["zz_nope_1", "zz_nope_2", "zz_nope_3"]);
    expect(Object.keys(flags)).toHaveLength(3);
    expect(new Set(Object.values(flags))).toEqual(new Set(["absent"]));
  });

  it("stems query terms, so a singular query matches a plural document", async () => {
    // `stemming` and `stopWords` both default to false. Shipped that way once:
    // "poppers" matched, "popper" returned nothing at all, and keyword search
    // was exact-token matching without anyone noticing. Schemas are immutable,
    // so recovering from it meant deleting and rebuilding the index — which is
    // why this is pinned rather than left to a code review.
    //
    // Reads the shop's own documents, since the point is the live index's
    // analyzer settings, not a fixture's.
    const search = (query: string) =>
      defaultIndex!.documents.search({
        topK: 3,
        scoreBy: [{ type: "text", field: "name", query }],
        includeFields: [],
      });

    const plural = await search("poppers");
    const singular = await search("popper");

    expect(plural.matches.length).toBeGreaterThan(0);
    expect(singular.matches.map((m) => m._id)).toEqual(plural.matches.map((m) => m._id));
  });

  it("scores multiple text clauses by summing them", async () => {
    // What `keywordSearch` relies on: two `text` clauses in one scoreBy are
    // summed, not max'd and not silently reduced to the last one. Worth
    // pinning because the app reads the combined score as a single ranking
    // signal — and because a field whose scores barely vary then acts as a
    // flat bonus rather than as a ranking signal. See keywordSearch.
    const q = "chocolate";
    const one = (field: string) =>
      defaultIndex!.documents.search({ topK: 10, scoreBy: [{ type: "text", field, query: q }], includeFields: [] });

    const [byName, byText, byBoth] = await Promise.all([
      one("name"),
      one("text"),
      defaultIndex!.documents.search({
        topK: 10,
        scoreBy: [
          { type: "text", field: "name", query: q },
          { type: "text", field: "text", query: q },
        ],
        includeFields: [],
      }),
    ]);

    const nameScore = new Map(byName.matches.map((m) => [m._id, m._score ?? 0]));
    const textScore = new Map(byText.matches.map((m) => [m._id, m._score ?? 0]));
    const checked = byBoth.matches.filter((m) => nameScore.has(m._id) && textScore.has(m._id));

    expect(checked.length).toBeGreaterThan(0);
    for (const m of checked) {
      expect(m._score ?? 0).toBeCloseTo(nameScore.get(m._id)! + textScore.get(m._id)!, 3);
    }
  });
});
