#!/usr/bin/env -S npx tsx
/**
 * Generates additional savory/sweet snack description entries for
 * snacks.jsonl using the Gemini API.
 *
 * NOT part of the Pinecone/Postgres app pipeline described in SPEC.md —
 * snacks.jsonl is a separate, standalone dataset/content-generation
 * experiment, unrelated to the grocery catalog Milestone 1b is waiting on.
 *
 * Usage:
 *   npm run generate:snacks -- [--count 200] [--batch-size 30]
 *                              [--max-cost 1.00] [--concurrency 5]
 *
 * Safety:
 *   - Respects a sliding-window rate limit (default 20M tokens/min,
 *     20K requests/min — override via GEMINI_TPM_LIMIT/GEMINI_RPM_LIMIT env
 *     vars if your quota differs).
 *   - Hard-stops once actual spend (computed from each response's real
 *     usageMetadata, not estimates) would exceed --max-cost.
 *   - Appends to snacks.jsonl incrementally after every batch, so a
 *     Ctrl-C or a crash mid-run doesn't lose completed entries.
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---- config -----------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
// Repo root, not next to this script — HERE is scripts/.
const OUT_FILE = resolve(HERE, "..", "snacks.jsonl");

const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  throw new Error("GEMINI_API_KEY is required (see .env / .env.example).");
}
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Gemini 3.8 Flash introductory pricing, through 2026-12-31 (doubles to
// $1.50/$7.50 on 2027-01-01). https://ai.google.dev/gemini-api/docs/pricing
// Override via env if you point this at a different/cheaper model.
const PRICE_PER_M_INPUT = Number(process.env.GEMINI_PRICE_PER_M_INPUT ?? 0.75);
const PRICE_PER_M_OUTPUT = Number(process.env.GEMINI_PRICE_PER_M_OUTPUT ?? 3.75);

const TOKENS_PER_MINUTE_LIMIT = Number(process.env.GEMINI_TPM_LIMIT ?? 20_000_000);
const REQUESTS_PER_MINUTE_LIMIT = Number(process.env.GEMINI_RPM_LIMIT ?? 20_000);

const PROMPT_INSTRUCTIONS = `You are tasked with generating creative and enticing food descriptions for a recommendation system.
Users will request foods based on their preferences, and your goal is to provide descriptions that match either "savory" or "sweet" categories.

Guidelines:
- Each food description should be 1-2 sentences, vivid, and appealing.
- Clearly indicate whether the food is "savory" or "sweet".
- Ensure descriptions are original and fit naturally into either category.
- Do not repeat any food from the "already used" list below.`;

// ---- CLI args -----------------------------------------------------------------

interface Args {
  count: number;
  batchSize: number;
  maxCost: number;
  concurrency: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
  };
  return {
    count: Number(get("--count", "200")),
    batchSize: Number(get("--batch-size", "30")),
    maxCost: Number(get("--max-cost", "1.00")),
    concurrency: Number(get("--concurrency", "5")),
  };
}

// ---- rate limiter -------------------------------------------------------------

/** Sliding 60s window over both token count and request count. */
class RateLimiter {
  private events: { at: number; tokens: number }[] = [];

  private prune(now: number) {
    const cutoff = now - 60_000;
    while (this.events.length && this.events[0].at < cutoff) this.events.shift();
  }

  /** Blocks until issuing a call estimated at `estTokens` fits both limits. */
  async reserve(estTokens: number): Promise<(actualTokens: number) => void> {
    for (;;) {
      const now = Date.now();
      this.prune(now);
      const tokensInWindow = this.events.reduce((s, e) => s + e.tokens, 0);
      if (
        tokensInWindow + estTokens <= TOKENS_PER_MINUTE_LIMIT &&
        this.events.length + 1 <= REQUESTS_PER_MINUTE_LIMIT
      ) {
        const slot = { at: now, tokens: estTokens };
        this.events.push(slot);
        // Return a reconciler so the caller can correct the estimate once
        // the real token usage is known (from the API response).
        return (actualTokens: number) => {
          slot.tokens = actualTokens;
        };
      }
      const wait = Math.max(250, this.events[0].at + 60_000 - now);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// ---- Gemini call ----------------------------------------------------------

interface GeneratedEntry {
  name: string;
  text: string;
  category: "savory" | "sweet";
}

interface GenerateResult {
  entries: GeneratedEntry[];
  promptTokens: number;
  outputTokens: number;
}

async function generateBatch(n: number, avoidNames: string[]): Promise<GenerateResult> {
  const prompt = `${PROMPT_INSTRUCTIONS}

Already used (do not repeat these, or close variations of them):
${avoidNames.map((name) => `- ${name}`).join("\n")}

Generate exactly ${n} new snack description objects. Aim for a roughly even split between "savory" and "sweet".`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      // gemini-3.8-flash "thinks" by default (medium), and thinking tokens
      // bill at the OUTPUT rate but don't show up in candidatesTokenCount —
      // confirmed live: a trivial prompt used 81 thoughtsTokenCount vs. 2
      // candidatesTokenCount with no thinkingConfig set. This task (fixed-
      // format creative JSON) gains nothing from reasoning, and "low" is as
      // low as this model goes (it can't fully disable thinking).
      thinkingConfig: { thinkingLevel: "low" },
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING" },
            text: { type: "STRING" },
            category: { type: "STRING", enum: ["savory", "sweet"] },
          },
          required: ["name", "text", "category"],
        },
      },
    },
  };

  const res = await fetch(`${ENDPOINT}?key=${API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  const usage = json.usageMetadata ?? {};
  const promptTokens: number = usage.promptTokenCount ?? 0;
  // thoughtsTokenCount bills at the output rate but is a SEPARATE field from
  // candidatesTokenCount (see the thinkingConfig comment above) — must be
  // included here or spend tracking silently undercounts actual cost.
  const outputTokens: number = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);

  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`No content in Gemini response: ${JSON.stringify(json)}`);

  let entries: GeneratedEntry[];
  try {
    entries = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse Gemini JSON output: ${(e as Error).message}\n${text}`);
  }
  return { entries, promptTokens, outputTokens };
}

// ---- main -------------------------------------------------------------------

function loadExisting(): { maxId: number; names: Set<string> } {
  if (!existsSync(OUT_FILE)) return { maxId: 0, names: new Set() };
  const lines = readFileSync(OUT_FILE, "utf-8").split("\n").filter(Boolean);
  let maxId = 0;
  const names = new Set<string>();
  for (const line of lines) {
    const obj = JSON.parse(line);
    const num = Number(String(obj.id).replace(/\D/g, ""));
    if (Number.isFinite(num)) maxId = Math.max(maxId, num);
    names.add(obj.name.toLowerCase());
  }
  return { maxId, names };
}

function sampleNames(names: Set<string>, n: number): string[] {
  const all = Array.from(names);
  if (all.length <= n) return all;
  // Reservoir-ish: shuffle a copy and slice, so each batch sees a varied
  // sample rather than always the same first N (keeps dedup context bounded
  // regardless of how large the dataset grows).
  const shuffled = all.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

async function main() {
  const args = parseArgs();
  const { maxId, names } = loadExisting();
  let nextId = maxId + 1;
  let totalGenerated = 0;
  let totalSpend = 0;
  const limiter = new RateLimiter();
  const startedAt = Date.now();

  console.log(
    `Model: ${MODEL} | target: ${args.count} entries | batch size: ${args.batchSize} | ` +
      `max cost: $${args.maxCost.toFixed(2)} | concurrency: ${args.concurrency}`,
  );
  console.log(`Starting from doc_${String(nextId).padStart(3, "0")}, ${names.size} existing names loaded.\n`);

  function commitEntries(entries: GeneratedEntry[]) {
    // Synchronous section (no `await` between the id read and the write) —
    // safe even with concurrent batches in flight, since Node won't
    // interleave two synchronous stretches of JS.
    const lines: string[] = [];
    for (const e of entries) {
      if (!e?.name || !e?.text || (e.category !== "savory" && e.category !== "sweet")) continue;
      const key = e.name.toLowerCase();
      if (names.has(key)) continue; // skip dupes the model produced anyway
      names.add(key);
      const id = `doc_${String(nextId++).padStart(3, "0")}`;
      lines.push(JSON.stringify({ id, text: e.text, name: e.name, category: e.category }));
    }
    if (lines.length) appendFileSync(OUT_FILE, "\n" + lines.join("\n"));
    totalGenerated += lines.length;
    return lines.length;
  }

  async function runBatch(size: number) {
    // Cost is only known after the call, so reserve on a conservative
    // estimate (chars/4 heuristic on the prompt + expected output) and
    // reconcile with the real usageMetadata afterward.
    const estOutputTokens = size * 60; // slightly above the measured ~54/entry
    const estInputTokens = 300 + 100 * 6;
    const reconcile = await limiter.reserve(estInputTokens + estOutputTokens);

    const avoidNames = sampleNames(names, 100);
    const { entries, promptTokens, outputTokens } = await generateBatch(size, avoidNames);
    reconcile(promptTokens + outputTokens);

    const cost = (promptTokens * PRICE_PER_M_INPUT + outputTokens * PRICE_PER_M_OUTPUT) / 1_000_000;
    totalSpend += cost;
    const written = commitEntries(entries);

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `+${written} entries (${entries.length} returned) | total: ${totalGenerated}/${args.count} | ` +
        `spend: $${totalSpend.toFixed(4)} | elapsed: ${elapsed}s`,
    );
  }

  // Simple concurrency pool: keep up to `concurrency` batches in flight,
  // stopping early if the target count or the cost cap is reached.
  const inFlight = new Set<Promise<void>>();
  while (totalGenerated < args.count) {
    if (totalSpend >= args.maxCost) {
      console.log(`\nStopping: reached --max-cost ($${args.maxCost.toFixed(2)}).`);
      break;
    }
    while (inFlight.size < args.concurrency && totalGenerated < args.count && totalSpend < args.maxCost) {
      const remaining = args.count - totalGenerated;
      const size = Math.min(args.batchSize, remaining);
      const p = runBatch(size)
        .catch((e) => console.error("Batch failed:", (e as Error).message))
        .finally(() => inFlight.delete(p));
      inFlight.add(p);
      // Don't fire the whole pool in the same tick — gives the limiter's
      // window a chance to reflect in-flight reservations.
      await new Promise((r) => setTimeout(r, 50));
    }
    await Promise.race(inFlight);
  }
  await Promise.all(inFlight);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\nDone. Generated ${totalGenerated} new entries in ${elapsed}s for $${totalSpend.toFixed(4)}. ` +
      `${OUT_FILE}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
