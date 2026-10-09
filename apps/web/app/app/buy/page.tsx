import type { Metadata } from "next";
import { BuyForm } from "@/components/app/BuyForm";
import { PageTitle } from "@/components/app/ui";
import { loadAccount } from "@/lib/server/account";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Buy credits" };

export default async function BuyPage() {
  const session = await getSession();
  const account = session && (await loadAccount(session.address));
  if (!session || !account) return null;
  return (
    <>
      <PageTitle sub="Pay with USDC 1:1, or with any token in your wallet through a Jupiter swap. One signature either way.">
        Buy credits
      </PageTitle>
      <BuyForm owner={session.address} {...account} />
    </>
  );
}
