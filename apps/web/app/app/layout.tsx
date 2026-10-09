import type { ReactNode } from "react";
import { AppNav } from "@/components/app/AppNav";
import { Notice } from "@/components/app/ui";
import { AccountBar } from "@/components/wallet/AccountBar";
import { SignIn } from "@/components/wallet/SignIn";
import { WalletProvider } from "@/components/wallet/WalletProvider";
import { publicEnv } from "@/lib/env";
import { getProgram } from "@/lib/server/program";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const LINKS: [string, string][] = [
  ["/app", "Overview"],
  ["/app/buy", "Buy"],
  ["/app/balance", "Balance"],
  ["/app/keys", "Keys"],
  ["/app/usage", "Usage"],
  ["/app/sell", "Sell"],
];

export default async function AppLayout({ children }: { children: ReactNode }) {
  if (publicEnv.prelaunch) {
    return (
      <section className="mx-auto max-w-[1280px] px-4 py-24 md:px-8">
        <h1 className="text-xl">Launching soon</h1>
        {publicEnv.xUrl && (
          <a className="btn mt-6" href={publicEnv.xUrl}>
            Follow on X
          </a>
        )}
      </section>
    );
  }
  const [session, program] = await Promise.all([getSession(), getProgram()]);
  const links = program?.shutDown ? [...LINKS, ["/app/redeem", "Redeem"] as [string, string]] : LINKS;
  return (
    <WalletProvider initialAddress={session?.address ?? null}>
      <div className="mx-auto max-w-[1280px] px-4 md:px-8">
        {!program ? (
          <section className="py-16">
            <h1 className="text-xl">Not live yet</h1>
            <p className="mt-4 text-sm text-mute">Unspent isn&apos;t running on this network yet.</p>
          </section>
        ) : session ? (
          <>
            <div className="flex flex-col gap-3 border-b border-line py-3 md:flex-row md:items-center md:justify-between">
              <AppNav links={links} />
              <AccountBar />
            </div>
            {program.shutDown && (
              <div className="mt-4 border border-fg p-3">
                <Notice>Unspent is shut down. Withdraw your balance and redeem credits for USDC.</Notice>
              </div>
            )}
            <div className="pb-8">{children}</div>
          </>
        ) : (
          <SignIn />
        )}
      </div>
    </WalletProvider>
  );
}
