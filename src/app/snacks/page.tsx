import { PineconeSnackSearch } from "@/components/PineconeSnackSearch";
import { SnacksBrowser } from "@/components/SnacksBrowser";
import { getAllSnackEntries } from "@/db/queries";

// Read from Postgres per request, not from snacks.jsonl on disk. Two reasons:
// the catalog is what's actually seeded rather than whatever the file happens
// to hold, and a server component reading a repo file by `process.cwd()` is
// exactly the thing that breaks on a serverless deploy, where that file may
// not be traced into the bundle.
export const dynamic = "force-dynamic";

export default async function SnacksPage() {
  const entries = await getAllSnackEntries();
  const savory = entries.filter((e) => e.category === "savory").length;
  const sweet = entries.length - savory;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-10">
      <div>
        <p className="font-mono text-xs font-bold tracking-wide text-muted-foreground uppercase">
          the catalog
        </p>
        <h1 className="text-2xl font-bold text-foreground">Every snack in the stockroom</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {entries.length} entries · {savory} savory · {sweet} sweet — read live from Postgres, the same rows the
          shop sells from (see <a href="/shop" className="underline">/shop</a>). The descriptions were generated
          with <code className="font-mono text-xs text-foreground">npm run generate:snacks</code>.
        </p>
      </div>
      <PineconeSnackSearch />
      <SnacksBrowser entries={entries} />
    </div>
  );
}
