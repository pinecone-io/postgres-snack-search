// CLI entry point for building the catalog — see src/db/seed.ts for what
// this actually does. Reads the prepared JSONL every time, so re-running it
// after editing snacks.jsonl actually reloads the shop.
//
// The app's Restock button does NOT call this: it calls restockShelves,
// which refills the same catalog from Postgres without the file.
import { buildCatalog } from "../src/db/seed";

buildCatalog()
  .then(({ snackCount }) => {
    console.log(`Built the catalog: ${snackCount} snacks, index synced.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
