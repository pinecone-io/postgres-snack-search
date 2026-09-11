// Two ways a shopper decides what to search for. "templated" reuses a
// fixed phrase per persona — free, instant, no key required. "llm" asks
// Gemini to write the query in that persona's voice, one short completion
// per tick, showing off what hybrid search does with a real natural-
// language sentence instead of a canned one. Same model and thinking-
// suppression settings as scripts/generateSnacks.ts, since a single-sentence
// query needs the same cost controls a full description does.
import { env } from "@/lib/env";

// The roster itself lives in @/lib/shoppers, which the browser can import —
// this module can't be, since `env` above validates server-only secrets.
export { SHOPPERS, type Shopper } from "@/lib/shoppers";
import type { Shopper } from "@/lib/shoppers";

export type ShopperBrain = "templated" | "llm";

const MODEL = "gemini-3.8-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export interface LlmCallLog {
  agentId: string;
  prompt: string;
  rawResponse: string;
  latencyMs: number;
}

async function generateLlmQuery(shopper: Shopper): Promise<{ query: string; call: LlmCallLog }> {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set — add it to .env to use LLM-driven shoppers.");
  }
  const prompt = `You're a shopper at a snack store. Your situation: ${shopper.persona}. Write one short, natural search query (5-12 words) for what you'd type into the store's search bar right now. Just the query text, no quotes.`;
  const started = Date.now();
  const res = await fetch(`${ENDPOINT}?key=${env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        thinkingConfig: { thinkingLevel: "low" },
        responseMimeType: "application/json",
        responseSchema: { type: "OBJECT", properties: { query: { type: "STRING" } }, required: ["query"] },
        maxOutputTokens: 60,
      },
    }),
  });
  const latencyMs = Date.now() - started;
  if (!res.ok) throw new Error(`Gemini request failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no query text");
  const { query } = JSON.parse(text) as { query: string };
  return { query: query.trim(), call: { agentId: shopper.id, prompt, rawResponse: text, latencyMs } };
}

export interface ShopperQueryResult {
  query: string;
  brainUsed: ShopperBrain;
  fallbackReason?: string;
  llmCall?: LlmCallLog;
}

/** Falls back to the templated query if the LLM call fails, so a flaky
 * request or a missing key never stalls a shopper's turn — but says so,
 * rather than silently pretending the LLM ran. */
export async function getShopperQuery(shopper: Shopper, brain: ShopperBrain): Promise<ShopperQueryResult> {
  if (brain === "templated") return { query: shopper.templatedQuery, brainUsed: "templated" };
  try {
    const { query, call } = await generateLlmQuery(shopper);
    return { query, brainUsed: "llm", llmCall: call };
  } catch (e) {
    return { query: shopper.templatedQuery, brainUsed: "templated", fallbackReason: (e as Error).message };
  }
}
