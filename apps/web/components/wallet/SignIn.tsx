"use client";

import { useWallet } from "./WalletProvider";

export function SignIn() {
  const { wallets, signIn, busy, error } = useWallet();
  return (
    <section className="mx-auto flex max-w-md flex-col gap-6 py-16">
      <h1 className="text-xl">Connect a wallet</h1>
      <p className="text-sm text-mute">
        Sign a message to prove you own the wallet. It doesn&apos;t send a transaction or cost any fees.
      </p>
      {wallets.length === 0 ? (
        <p className="text-sm">
          <span className="notice">[!]</span> No Solana wallet found. Install Phantom, Solflare or Backpack,
          then reload this page.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {wallets.map((w) => (
            <li key={w.name}>
              <button
                type="button"
                className="btn w-full justify-start"
                disabled={busy}
                onClick={() => signIn(w)}
              >
                {/* biome-ignore lint/performance/noImgElement: wallet icons are data URLs from the wallet itself */}
                <img src={w.icon} alt="" width={20} height={20} />
                {w.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {busy && <p className="text-sm text-mute">Waiting for the wallet…</p>}
      {error && (
        <p className="text-sm" role="alert">
          <span className="notice">[ERROR]</span> {error}
        </p>
      )}
    </section>
  );
}
