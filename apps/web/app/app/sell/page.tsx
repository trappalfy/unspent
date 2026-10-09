import type { Metadata } from "next";
import { SellForm } from "@/components/app/SellForm";
import { PageTitle } from "@/components/app/ui";
import { readReservations } from "@/lib/chain/read";
import { loadAccount } from "@/lib/server/account";
import { chainNow } from "@/lib/server/clock";
import { serverRpc } from "@/lib/server/rpc";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Sell credits" };

export default async function SellPage() {
  const session = await getSession();
  if (!session) return null;
  const [account, reservations, now] = await Promise.all([
    loadAccount(session.address),
    readReservations(serverRpc(), session.address),
    chainNow(),
  ]);
  if (!account) return null;
  return (
    <>
      <PageTitle sub="Credits are a regular token. Sell unspent ones for USDC on the open market through Jupiter.">
        Sell credits
      </PageTitle>
      <SellForm
        owner={session.address}
        {...account}
        expired={reservations.filter((r) => r.expiresAt <= now)}
      />
    </>
  );
}
