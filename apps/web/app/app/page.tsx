import type { Metadata } from "next";
import Link from "next/link";
import { SpendChart } from "@/components/app/SpendChart";
import { Credits, Empty, Panel, Stat } from "@/components/app/ui";
import { network } from "@/lib/env";
import { listKeys } from "@/lib/keys";
import { loadAccount } from "@/lib/server/account";
import { getDb } from "@/lib/server/db";
import { getSession } from "@/lib/session";
import { spendByDay } from "@/lib/usage";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage() {
  const session = await getSession();
  if (!session) return null;
  const db = await getDb();
  const [account, spend, keys] = await Promise.all([
    loadAccount(session.address),
    spendByDay(db, session.address, network, 30),
    listKeys(db, session.address, network),
  ]);
  if (!account) return null;
  const { user, wallet, program } = account;
  const spent30 = spend.reduce((s, d) => s + d.ucr, 0n);
  const activeKeys = keys.filter((k) => k.status === "active").length;

  const next =
    user.balance === 0n && wallet.credits === 0n
      ? { text: "No credits yet. Buy some to start.", href: "/app/buy", cta: "Buy credits" }
      : user.balance === 0n
        ? {
            text: "Your credits are in your wallet. Deposit them to the API balance to spend them.",
            href: "/app/balance#deposit",
            cta: "Deposit",
          }
        : activeKeys === 0
          ? {
              text: "No API keys yet. Create one to start spending credits.",
              href: "/app/keys",
              cta: "Create key",
            }
          : null;

  return (
    <div className="flex flex-col gap-6 pt-8">
      <h1 className="sr-only">Overview</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="In wallet" hint="credits">
          <Credits ucr={wallet.credits} />
        </Stat>
        <Stat label="Available" hint="API balance">
          <Credits ucr={user.available} />
        </Stat>
        <Stat label="Held" hint="running requests">
          <Credits ucr={user.reserved} />
        </Stat>
        <Stat label="Spent" hint="last 30 days">
          <Credits ucr={spent30} />
        </Stat>
      </div>
      {next && (
        <div className="flex flex-col gap-3 border border-fg p-4 md:flex-row md:items-center md:justify-between">
          <p className="text-sm">{next.text}</p>
          <Link href={next.href} className="btn btn-primary">
            {next.cta}
          </Link>
        </div>
      )}
      <nav className="flex flex-wrap gap-3" aria-label="Quick actions">
        {!program.shutDown && (
          <Link href="/app/buy" className="btn">
            Buy
          </Link>
        )}
        {!program.shutDown && (
          <Link href="/app/balance#deposit" className="btn">
            Deposit
          </Link>
        )}
        <Link href="/app/balance#withdraw" className="btn">
          Withdraw
        </Link>
        {program.shutDown ? (
          <Link href="/app/redeem" className="btn">
            Redeem
          </Link>
        ) : (
          <Link href="/app/sell" className="btn">
            Sell
          </Link>
        )}
      </nav>
      <Panel title="Spend, last 30 days">
        {spend.length ? (
          <SpendChart data={spend} />
        ) : (
          <Empty>No spend yet. Requests show up here by day and model once they settle.</Empty>
        )}
      </Panel>
    </div>
  );
}
