import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

// `prepare: false` is required for Supabase's pooled (Supavisor) connections
// and harmless everywhere else, so it's on unconditionally rather than
// branching on which provider's URL was given.
const queryClient = postgres(env.DATABASE_URL, { prepare: false });

export const db = drizzle(queryClient, { schema });
