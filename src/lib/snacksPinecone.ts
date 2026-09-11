// All Pinecone access: semantic (dense vector), keyword (BM25), and hybrid
// (RRF fusion of both) search over the `snacks-hybrid` document-schema index,
// plus the write operations night sync and live sync use.
//
// Document-schema API, wire version 2026-07 (TS SDK 9.0.0): operations live
// on `index.documents.*`, and the namespace is bound to the index handle
// rather than passed per call. Index creation is in scripts/setupIndex.ts.
//
// Pinecone only ever returns ids and a score here — `includeFields` is
// deliberately empty. Everything a shopper sees (name, price, whether it's
// in stock) is read live from Postgres by hydrateSnacks, so a stale index
// can degrade result quality but can never show or sell something that's
// gone. See src/db/queries.ts.
import { Pinecone, type DocumentScoringMethod } from "@pinecone-database/pinecone";
import { env } from "@/lib/env";
import { hydrateSnacks, type Snack } from "@/db/queries";
import { reciprocalRankFuse, type RankedId } from "@/lib/rrf";

const INDEX_NAME = "snacks-hybrid";
const NAMESPACE = "__default__";
const EMBED_MODEL = "llama-text-embed-v2";

// How far past the requested topK to search Pinecone, so there's enough
// headroom left after dropping sold-out ids to still return topK results.
const OVERFETCH_FACTOR = 4;
const OVERFETCH_MIN = 40;

export type SnackSearchMode = "semantic" | "keyword" | "hybrid";

export interface SnackHit extends Snack {
  score: number;
  source: "dense" | "bm25" | "fused";
}

const pc = new Pinecone({ apiKey: env.PINECONE_API_KEY });
// Resolves the index host via describeIndex internally and caches it on this
// handle — no manual host-caching needed. The namespace is bound here, which
// is why none of the operations below take one.
const index = pc.index({ name: INDEX_NAME, namespace: NAMESPACE });

async function embedQuery(text: string): Promise<number[]> {
  const { data } = await pc.inference.embed({
    model: EMBED_MODEL,
    inputs: [text],
    parameters: { inputType: "query", truncate: "END" },
  });
  const [embedding] = data;
  if (!embedding || !("values" in embedding) || !embedding.values) {
    throw new Error("embed returned no dense values");
  }
  return embedding.values;
}

interface RawMatch {
  _id: string;
  _score: number;
}

async function documentsSearch(
  topK: number,
  scoreBy: DocumentScoringMethod[],
  filter?: Record<string, unknown>,
): Promise<RawMatch[]> {
  const { matches } = await index.documents.search({
    topK,
    scoreBy,
    includeFields: [],
    ...(filter ? { filter } : {}),
  });
  // 2026-07 types `_score` as nullable. Coerced here, at the one boundary
  // where matches enter the app, so nothing downstream has to think about
  // it — `/snacks` renders the score with `.toFixed(4)`, which would throw
  // on a null.
  return matches.map((m) => ({ _id: m._id, _score: m._score ?? 0 }));
}

async function semanticSearch(query: string, overfetchK: number, filter?: Record<string, unknown>): Promise<RankedId[]> {
  const values = await embedQuery(query);
  const matches = await documentsSearch(overfetchK, [{ type: "dense_vector", field: "embedding", values }], filter);
  return matches.map((m) => ({ id: m._id, score: m._score, source: "dense" }));
}

async function keywordSearch(query: string, overfetchK: number, filter?: Record<string, unknown>): Promise<RankedId[]> {
  // Multi-field BM25. Pinecone sums the two clause scores (pinned in
  // tests/contract). That is not the same as weighting them equally: BM25
  // normalizes by field length within each field, so `name` — short, usually
  // one occurrence — produces near-identical scores across documents and acts
  // as a flat bonus, while `text` does the actual ranking. To weight a field
  // deliberately, use a single `query_string` clause with a Lucene boost
  // (`name:(term)^5 OR text:(term)`), which this index accepts.
  const matches = await documentsSearch(
    overfetchK,
    [
      { type: "text", field: "name", query },
      { type: "text", field: "text", query },
    ],
    filter,
  );
  return matches.map((m) => ({ id: m._id, score: m._score, source: "bm25" }));
}

async function rankIds(
  query: string,
  mode: SnackSearchMode,
  overfetchK: number,
  filter?: Record<string, unknown>,
): Promise<RankedId[]> {
  if (mode === "semantic") return semanticSearch(query, overfetchK, filter);
  if (mode === "keyword") return keywordSearch(query, overfetchK, filter);
  const [dense, bm25] = await Promise.all([
    semanticSearch(query, overfetchK, filter),
    keywordSearch(query, overfetchK, filter),
  ]);
  return reciprocalRankFuse(dense, bm25);
}

/**
 * Removes documents from the index by id — the mechanism night sync uses
 * to make a sold-out snack stop showing up in search. Deletes land
 * asynchronously (verified live: a few seconds), same as any index update.
 */
export async function deleteFromIndex(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await index.documents.delete({ ids });
}

export interface SnackDocument {
  _id: string;
  name: string;
  text: string;
  category: string;
  embedding: number[];
  // Present only in live-sync mode: an un-declared metadata field, filtered
  // on with `$eq` in searchSnacksWithCandidates. An un-schematized boolean
  // field is filterable this way — but a filter of `{$eq: true}` excludes a
  // document missing the field entirely, same as one explicitly set to
  // false. Every document needs it written once (see restockShelves) before
  // live mode can return anything. Both behaviors are pinned by
  // tests/contract/pinecone.test.ts, since neither is a documented guarantee
  // for a field that isn't in the index schema.
  in_stock?: boolean;
}

/** Adds (or restores) documents in the index — night sync's other half.
 * A full replace: every field must be present, which is why this is the
 * expensive path (see setLiveInStock for the cheap one). */
export async function upsertToIndex(documents: SnackDocument[]): Promise<void> {
  if (documents.length === 0) return;
  await index.documents.upsert({ documents });
}

/**
 * Live sync's one moment of index mutation: flips a single snack's
 * `in_stock` flag the instant it sells out, so a live-mode search can
 * filter it out before night sync ever runs. Unlike upsertToIndex, this is
 * a real partial-field patch — `documents.update` (distinct from
 * `documents.upsert`) leaves every other field on the document untouched,
 * confirmed empirically against a live document (name and embedding both
 * survived a `{_id, in_stock}`-only update). That's the real cost of live
 * mode: one small field write per sale, not a full re-embed-sized upsert.
 */
export async function setLiveInStock(id: string, inStock: boolean): Promise<void> {
  await index.documents.update({ documents: [{ _id: id, in_stock: inStock }] });
}

/** What a live-mode search would do right now with one document, read off
 * the index itself rather than guessed at from Postgres. */
export type LiveSearchFlag =
  /** `in_stock: true` — a live-mode search still ranks and returns this. */
  | "hit"
  /** `in_stock` false, or the field absent: the live filter (`$eq: true`)
   * excludes both cases, so the document is in the index but unreachable
   * by search. */
  | "filtered"
  /** Pinecone returned nothing for this id — the document is already gone. */
  | "absent";

// fetchDocuments takes a list of ids per call; 100 keeps each request small
// since only the `in_stock` field comes back, not embeddings.
const FLAG_FETCH_CHUNK = 100;

/**
 * Reads the `in_stock` flag back off documents by id. This is the one place
 * the app asks Pinecone about a fact instead of Postgres, and it's
 * deliberate: Postgres knows a snack sold out, but only Pinecone knows
 * whether the flag write that hides it from search has landed yet. Deriving
 * the answer from Postgres instead would mean reporting a document as
 * filtered while the fire-and-forget write in the live-sale path (see
 * simulation.ts) might have failed or still be in flight — and that
 * in-flight window is exactly the propagation delay this app exists to show
 * honestly rather than paper over.
 */
export async function fetchLiveSearchFlags(ids: string[]): Promise<Record<string, LiveSearchFlag>> {
  const flags: Record<string, LiveSearchFlag> = {};
  for (let i = 0; i < ids.length; i += FLAG_FETCH_CHUNK) {
    const chunk = ids.slice(i, i + FLAG_FETCH_CHUNK);
    const { documents } = await index.documents.fetch({
      ids: chunk,
      includeFields: ["in_stock"],
    });
    for (const id of chunk) {
      const doc = documents[id] as { in_stock?: unknown } | undefined;
      flags[id] = doc === undefined ? "absent" : doc.in_stock === true ? "hit" : "filtered";
    }
  }
  return flags;
}

export interface CandidateSquare {
  id: string;
  name: string;
  inStock: boolean;
}

export interface SearchWithCandidates {
  results: SnackHit[];
  /** The full ranked pool Pinecone returned, in Pinecone's order, each
   * tagged with whether Postgres currently says it's in stock — this is
   * what makes the "candidate pool vs. what's real" split visible instead
   * of just asserted. */
  candidates: CandidateSquare[];
}

// The two sync strategies this app demonstrates. In "batch" (the default)
// Pinecone never carries stock, so search can lag a full night behind a
// sellout. "live" is the deliberate exception — see setLiveInStock — and
// filters on an `in_stock` flag written the moment a sale happens, subject
// to the index's normal propagation delay of a few seconds.
export type SyncMode = "batch" | "live";

const LIVE_IN_STOCK_FILTER = { in_stock: { $eq: true } };

export async function searchSnacksWithCandidates(
  query: string,
  mode: SnackSearchMode,
  topK = 20,
  syncMode: SyncMode = "batch",
): Promise<SearchWithCandidates> {
  const overfetchK = Math.max(OVERFETCH_MIN, topK * OVERFETCH_FACTOR);
  const filter = syncMode === "live" ? LIVE_IN_STOCK_FILTER : undefined;
  const ranked = await rankIds(query, mode, overfetchK, filter);

  // Pinecone's ranking decides order; Postgres decides what's real. Hydrate
  // in Pinecone's order, drop anything that's actually sold out, then trim
  // to what was asked for.
  const ids = ranked.map((r) => r.id);
  const hydrated = await hydrateSnacks(ids);
  const byId = new Map(hydrated.map((s) => [s.id, s]));
  const rankById = new Map(ranked.map((r) => [r.id, r]));

  const candidates: CandidateSquare[] = ids
    .map((id) => byId.get(id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((s) => ({ id: s.id, name: s.name, inStock: s.stockQty > 0 }));

  const results = hydrated
    .filter((s) => s.stockQty > 0)
    .slice(0, topK)
    .map((snack) => {
      const r = rankById.get(snack.id)!;
      return { ...snack, score: r.score, source: r.source };
    });

  return { results, candidates };
}

export async function searchSnacks(query: string, mode: SnackSearchMode, topK = 20): Promise<SnackHit[]> {
  return (await searchSnacksWithCandidates(query, mode, topK)).results;
}
