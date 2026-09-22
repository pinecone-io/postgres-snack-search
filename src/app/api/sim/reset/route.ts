import { restockShelves } from "@/db/seed";

export const runtime = "nodejs";

// Refills every shelf and rebuilds the entire Pinecone index from the
// `snacks` table alone: names, descriptions and categories, embedded on the
// way in. No prepared file, so this works on a deployment.
//
// Streams one NDJSON line per page embedded and upserted, then a final
// `{ snackCount }` line, or `{ error }` if the rebuild failed. The status is
// always 200 because it is sent before the rebuild starts.
export async function POST() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (message: object) => controller.enqueue(encoder.encode(JSON.stringify(message) + "\n"));
      try {
        const result = await restockShelves((indexed, total) => send({ indexed, total }));
        send(result);
      } catch (e) {
        send({ error: (e as Error).message });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
}
