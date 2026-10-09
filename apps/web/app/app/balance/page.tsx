import { walletHistory } from "@unspent/indexer";
import type { Metadata } from "next";
import { Activity } from "@/components/app/Activity";
import { BalanceForms } from "@/components/app/BalanceForms";
import { Credits, PageTitle, Stat } from "@/components/app/ui";
import { readReservations } from "@/lib/chain/read";
import { network } from "@/lib/env";
import { loadAccount } from "@/lib/server/account";
import { chainNow } from "@/lib/server/clock";
import { getDb } from "@/lib/server/db";
import { serverRpc } from "@/lib/server/rpc";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Balance" };

export default async function BalancePage() {
  const session = await getSession();
  if (!session) return null;
  const [account, reservations, now, history] = await Promise.all([
    loadAccount(session.address),
    readReservations(serverRpc(), session.address),
    chainNow(),
    getDb()
      .then((db) => walletHistory(db, network, session.address, { limit: 60 }))
      .catch(() => null),
  ]);
  if (!account) return null;
  const { user, wallet } = account;
  return (
    <>
      <PageTitle sub="Your API balance lives in the program's vault, not with Unspent. Available = balance − held.">
        Balance
      </PageTitle>
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Available">
          <Credits ucr={user.available} />
        </Stat>
        <Stat label="Held">
          <Credits ucr={user.reserved} />
        </Stat>
        <Stat label="API balance">
          <Credits ucr={user.balance} />
        </Stat>
        <Stat label="In wallet">
          <Credits ucr={wallet.credits} />
        </Stat>
      </div>
      <BalanceForms owner={session.address} {...account} reservations={reservations} chainNow={now} />
      <div className="mt-6">
        <Activity events={history} />
      </div>
    </>
  );
}
