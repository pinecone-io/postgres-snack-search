// Step one of setup: create the Pinecone index and prepare the catalog for it.
//
// Reads snacks.jsonl (the committed source data — names, descriptions,
// categories), embeds every entry with Pinecone's own hosted
// llama-text-embed-v2 model, and writes snacks-for-pinecone.jsonl with the
// vectors attached. That prepared file is what `npm run db:seed`
// (buildCatalog) reads to fill Postgres and upsert the documents into
// Pinecone, so this script creates and prepares but does not ingest.
//
// Only needs PINECONE_API_KEY, on purpose: the index can be built before
// Postgres is configured at all.
//
// Usage: npm run setup:index   (or npm run setup, which chains all of it)
import { readFileSync, writeFileSync } from "node:fs";
import { Pinecone } from "@pinecone-database/pinecone";

const INDEX_NAME = "snacks-hybrid";
const EMBED_MODEL = "llama-text-embed-v2";
// llama-text-embed-v2's native output width; must match the schema below.
const EMBED_DIMENSION = 1024;
// The model's documented max_batch_size per /embed call.
const EMBED_BATCH_SIZE = 96;
const CLOUD = "aws";
const REGION = "us-east-1";
const SOURCE_FILE = "snacks.jsonl";
const PREPARED_FILE = "snacks-for-pinecone.jsonl";

interface SourceSnack {
  id: string;
  name: string;
  text: string;
  category: string;
}

async function main() {
  const apiKey = process.env.PINECONE_API_KEY;
  if (!apiKey) {
    throw new Error("PINECONE_API_KEY is required. Copy .env.example to .env and fill it in.");
  }
  const pc = new Pinecone({ apiKey });

  // `suppressConflicts` makes this a no-op when the index already exists, and
  // `waitUntilReady` does the readiness polling, so re-running setup is safe.
  // It also swallows the conflict raised while an index of the same name is
  // still being deleted — in which case nothing is created and the delete
  // then completes, leaving no index at all. The describeIndex below turns
  // that silent no-op into an error instead of letting setup embed 1,160
  // snacks against an index that isn't there.
  console.log(`Creating index "${INDEX_NAME}" (skipped if it already exists)...`);
  await pc.createIndex({
    name: INDEX_NAME,
    deployment: { deploymentType: "managed", cloud: CLOUD, region: REGION },
    schema: {
      fields: {
        // Two full-text fields, both with English analysis. `stemming` and
        // `stopWords` both default to false, so they are set explicitly:
        // without stemming a search for "popper" misses "Poppers", and
        // without stop-word removal "the" and "of" are scored like content.
        // Verified against a live index; pinned by tests/contract.
        name: { type: "string", fullTextSearch: { language: "en", stemming: true, stopWords: true } },
        text: { type: "string", fullTextSearch: { language: "en", stemming: true, stopWords: true } },
        // The dense half of hybrid search.
        embedding: { type: "dense_vector", dimension: EMBED_DIMENSION, metric: "cosine" },
        // `category` and `in_stock` are deliberately absent. A schema declares
        // only the fields you *search* — values you merely filter on are sent
        // as document metadata and indexed automatically at upsert time.
        // Declaring them here is rejected outright.
      },
    },
    waitUntilReady: true,
    suppressConflicts: true,
  });
  const created = await pc.describeIndex(INDEX_NAME).catch(() => null);
  if (!created) {
    throw new Error(
      `Index "${INDEX_NAME}" does not exist after createIndex. If you just deleted it, ` +
        `the delete was probably still in flight — wait a few seconds and re-run.`,
    );
  }
  console.log("Index ready.", JSON.stringify(created.schema?.fields ?? {}));

  const entries: SourceSnack[] = readFileSync(SOURCE_FILE, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  console.log(`Loaded ${entries.length} snacks from ${SOURCE_FILE}.`);

  const prepared: Record<string, unknown>[] = [];
  for (let i = 0; i < entries.length; i += EMBED_BATCH_SIZE) {
    const batch = entries.slice(i, i + EMBED_BATCH_SIZE);
    // Embedded as "name. text" so one vector carries both signals — the same
    // pairing the BM25 side searches across two fields.
    const { data } = await pc.inference.embed({
      model: EMBED_MODEL,
      inputs: batch.map((e) => `${e.name}. ${e.text}`),
      parameters: { inputType: "passage", truncate: "END" },
    });
    batch.forEach((entry, j) => {
      const values = (data[j] as { values?: number[] } | undefined)?.values;
      if (!values) throw new Error(`embed returned no dense values for ${entry.id}`);
      prepared.push({
        _id: entry.id,
        name: entry.name,
        text: entry.text,
        embedding: values,
        category: entry.category,
        // Written true up front so a from-scratch build lands with Live sync
        // already usable: its filter (`{in_stock: {$eq: true}}`) excludes a
        // document that lacks the field just as surely as one set to false.
        in_stock: true,
      });
    });
    console.log(`  embedded ${Math.min(i + EMBED_BATCH_SIZE, entries.length)}/${entries.length}`);
  }

  writeFileSync(PREPARED_FILE, prepared.map((d) => JSON.stringify(d)).join("\n") + "\n");
  console.log(`Wrote ${prepared.length} documents to ${PREPARED_FILE}.`);
  console.log("\nNext: npm run db:push && npm run db:seed  (or just npm run setup).");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
