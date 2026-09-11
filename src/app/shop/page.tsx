import { ShopSimulation } from "@/components/ShopSimulation";
import { getSnackCount } from "@/db/queries";

export const dynamic = "force-dynamic";

export default async function ShopPage() {
  const totalSnacks = await getSnackCount();
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-10">
      <div>
        <p className="font-mono text-xs font-bold tracking-wide text-muted-foreground uppercase">the shop</p>
        <h1 className="text-2xl font-bold text-foreground">Recommending snacks to shoppers, and keeping the store in sync</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Postgres tracks what&apos;s really on the shelf. Pinecone powers what shoppers can search. Every purchase
          checks Postgres directly, so nothing sold out is ever sold twice.
        </p>
      </div>
      <ShopSimulation totalSnacks={totalSnacks} />
    </div>
  );
}
