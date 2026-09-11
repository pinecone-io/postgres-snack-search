import { defineConfig } from "drizzle-kit";

// Reads DATABASE_URL directly (not via src/lib/env.ts) since drizzle-kit
// runs as a standalone CLI, outside the Next.js process.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required — set it in .env before running drizzle-kit.");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
});
