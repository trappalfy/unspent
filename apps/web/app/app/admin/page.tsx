import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminPanel } from "@/components/app/AdminPanel";
import { PageTitle } from "@/components/app/ui";
import { countReservations, readHolders, readProgramCode, readReserveBalances } from "@/lib/chain/read";
import { chainNow } from "@/lib/server/clock";
import { getProgram } from "@/lib/server/program";
import { serverRpc } from "@/lib/server/rpc";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Admin", robots: { index: false } };

/** Exists only for the program's admin wallet; everyone else gets a 404. */
export default async function AdminPage() {
  const [session, program] = await Promise.all([getSession(), getProgram(0)]);
  if (!session || !program || program.admin !== session.address) notFound();
  const rpc = serverRpc();
  const [code, balances, holds, now, holders] = await Promise.all([
    readProgramCode(rpc),
    readReserveBalances(rpc, program),
    countReservations(rpc),
    chainNow(),
    // Only needed for closing, which comes after shutdown.
    program.shutDown ? readHolders(rpc, program) : Promise.resolve([]),
  ]);
  return (
    <>
      <PageTitle sub="Only the admin wallet sees this page. Every action is a transaction you sign in your wallet.">
        Admin
      </PageTitle>
      <AdminPanel
        admin={session.address}
        program={program}
        code={code}
        balances={{ ...balances, holds }}
        holders={holders}
        now={now}
      />
    </>
  );
}
