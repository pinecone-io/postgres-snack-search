import { z } from "zod";

/**
 * Parses `process.env` against a zod schema, failing fast with a message
 * naming exactly which variable is missing or invalid.
 */
function parseEnv<T extends z.ZodTypeAny>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}\n\nSee .env.example.`);
  }
  return result.data;
}

const envSchema = z.object({
  PINECONE_API_KEY: z.string().min(1, "required — get one at app.pinecone.io"),
  DATABASE_URL: z.string().min(1, "required — a Postgres connection string (Supabase, Neon, or local all work)"),
  GEMINI_API_KEY: z.string().min(1).optional(),
});

export const env = parseEnv(envSchema, process.env);
