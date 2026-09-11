// Source strings for the "see the code" panels on /snacks.
//
// Kept here rather than inlined in the component so they can sit next to a
// note about where each one comes from — these are copies, and a copy that
// drifts from the real thing teaches the wrong lesson. If you change the
// index schema or the document shape, change these too:
//
//   INDEX_SCHEMA_SOURCE  mirrors the createIndex call in scripts/setupIndex.ts
//   SAMPLE_DOCUMENT      mirrors a real line of snacks-for-pinecone.jsonl,
//                        with the 1024-float embedding elided
//
// No imports on purpose: this is read by a client component.

/** The index as `scripts/setupIndex.ts` creates it. */
export const INDEX_SCHEMA_SOURCE = `const fts = { language: "en", stemming: true, stopWords: true };

await pc.createIndex({
  name: "snacks-hybrid",
  deployment: { deploymentType: "managed", cloud: "aws", region: "us-east-1" },
  schema: {
    fields: {
      name: { type: "string", fullTextSearch: fts },
      text: { type: "string", fullTextSearch: fts },
      embedding: { type: "dense_vector", dimension: 1024, metric: "cosine" },
    },
  },
});`;

/** One real document, as written by `npm run setup:index`. */
export const SAMPLE_DOCUMENT = `{
  "_id": "doc_001",
  "name": "Bacon Jalapeño Poppers",
  "text": "Crispy bacon-wrapped jalapeño poppers stuffed with
           cream cheese and sharp cheddar…",
  "embedding": [-0.0224, -0.0201, 0.0167, 0.0294, …],
  "category": "savory",
  "in_stock": true
}`;
