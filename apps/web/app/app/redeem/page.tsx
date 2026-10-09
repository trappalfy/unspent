import type { Metadata } from "next";
import { RedeemForm } from "@/components/app/RedeemForm";
import { Empty, PageTitle } from "@/components/app/ui";
import { readReservations } from "@/lib/chain/read";
import { loadAccount } from "@/lib/server/account";
import { chainNow } from "@/lib/server/clock";
import { serverRpc } from "@/lib/server/rpc";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Redeem" };

export default async function RedeemPage() {
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
      <PageTitle sub="If Unspent shuts down, every credit can be redeemed for 1 USDC from the program's reserve.">
        Redeem
      </PageTitle>
      {account.program.shutDown ? (
        <RedeemForm
          owner={session.address}
          {...account}
          expired={reservations.filter((r) => r.expiresAt <= now)}
        />
      ) : (
        <Empty>
          Redeem opens only if Unspent shuts down. Until then, spend credits on inference or sell them on the
          market.
        </Empty>
      )}
    </>
  );
}
