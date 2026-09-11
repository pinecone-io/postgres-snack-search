import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background px-6">
      <main className="flex w-full max-w-2xl flex-col gap-8 border border-border bg-card p-10">
        <p className="font-mono text-xs font-bold tracking-wide text-muted-foreground uppercase">
          Recsys with Pinecone/Postgres
        </p>

        <h1 className="text-4xl leading-tight font-bold text-balance text-foreground">
          Serving up snacks while keeping the: <span className="text-primary">stockroom and storefront</span> in sync
        </h1>

        <p className="max-w-lg text-base leading-relaxed text-muted-foreground">
          In this demo, learn how Pinecone and Postgres work together to manage inventory and serve recommendations
          for a small snack shop. Postgres holds state, money, and inventory. Pinecone holds descriptions, which helps shoppers find what they want to eat.
          Click the Search tab to learn how Pinecone powers semantic, keyword and hybrid search using our Documents API.
          Click on the Shop tab to simulate the snack shop&apos;s daily rhythm, complete with shoppers and syncs.
        </p>

        <div className="flex flex-col items-start gap-3 border-t border-border pt-6 sm:flex-row sm:items-center">
          <Button render={<Link href="/shop" />}>Open the shop</Button>
          <Button variant="outline" render={<Link href="/snacks" />}>
            Search the catalog
          </Button>
        </div>
      </main>
    </div>
  );
}
