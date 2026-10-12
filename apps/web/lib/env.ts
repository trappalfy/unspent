import { ADDRESSES, parseNetwork } from "@unspent/shared";

// Public, build-time config (NEXT_PUBLIC_*). Handle, domain and API host come from config, never hardcoded (brief 2.1).
export const network = parseNetwork(process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "mainnet");
export const chain = ADDRESSES[network].chain;

export const publicEnv = {
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  apiHost: process.env.NEXT_PUBLIC_API_HOST ?? "localhost:8787",
  xUrl: process.env.NEXT_PUBLIC_X_URL ?? "",
  prelaunch: process.env.NEXT_PUBLIC_PRELAUNCH === "true",
  // The project token (separate from credits, gives nothing in Unspent); the env var overrides it.
  projectTokenCa: process.env.NEXT_PUBLIC_PROJECT_TOKEN_CA || "3DruFt8Bm8KPZjHWiqKFT5eLwy2RsGVTHDigtjLnpump",
};

/** Base URL of the API for code samples: https unless it's a local host. */
export const apiBase = /^(localhost|127\.0\.0\.1)(:|$)/.test(publicEnv.apiHost)
  ? `http://${publicEnv.apiHost}`
  : `https://${publicEnv.apiHost}`;

const LOCAL_RPC = "http://127.0.0.1:8899";

function explorer(kind: "tx" | "account", id: string): string {
  if (network === "mainnet") return `https://solscan.io/${kind}/${id}`;
  if (network === "devnet") return `https://solscan.io/${kind}/${id}?cluster=devnet`;
  const path = kind === "tx" ? "tx" : "address";
  return `https://explorer.solana.com/${path}/${id}?cluster=custom&customUrl=${encodeURIComponent(LOCAL_RPC)}`;
}

export const explorerTx = (signature: string) => explorer("tx", signature);
export const explorerAddress = (address: string) => explorer("account", address);
