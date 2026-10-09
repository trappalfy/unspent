import Link from "next/link";
import type { ReactNode } from "react";
import { AccountBar } from "@/components/wallet/AccountBar";
import { SignIn } from "@/components/wallet/SignIn";
import { WalletProvider } from "@/components/wallet/WalletProvider";
import { publicEnv } from "@/lib/env";
import { getSession } from "@/lib/session";

const LINKS = [
  ["/app", "Overview"],
  ["/app/buy", "Buy"],
  ["/app/balance", "Balance"],
  ["/app/keys", "Keys"],
  ["/app/usage", "Usage"],
  ["/app/sell", "Sell"],
] as const;

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
  const session = await getSession();
  return (
    <WalletProvider initialAddress={session?.address ?? null}>
      <div className="mx-auto max-w-[1280px] px-4 md:px-8">
        {session ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line py-3">
              <nav className="flex flex-wrap gap-4 text-sm">
                {LINKS.map(([href, label]) => (
                  <Link key={href} href={href}>
                    {label}
                  </Link>
                ))}
              </nav>
              <AccountBar />
            </div>
            {children}
          </>
        ) : (
          <SignIn />
        )}
      </div>
    </WalletProvider>
  );
}
