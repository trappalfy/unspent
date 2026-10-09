"use client";

import { shortAddress, useWallet } from "./WalletProvider";

export function AccountBar() {
  const { sessionAddress, signOut } = useWallet();
  if (!sessionAddress) return null;
  return (
    <div className="flex items-center gap-3 text-sm">
      <span title={sessionAddress}>{shortAddress(sessionAddress)}</span>
      <button type="button" className="btn min-h-8 px-3 text-xs" onClick={() => signOut()}>
        Disconnect
      </button>
    </div>
  );
}
