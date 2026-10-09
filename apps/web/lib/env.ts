import { ADDRESSES, parseNetwork } from "@unspent/shared";

// Public, build-time config (NEXT_PUBLIC_*). Handle, domain and API host come from config, never hardcoded (brief 2.1).
export const network = parseNetwork(process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet");
export const chain = ADDRESSES[network].chain;

export const publicEnv = {
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  apiHost: process.env.NEXT_PUBLIC_API_HOST ?? "localhost:8787",
  xUrl: process.env.NEXT_PUBLIC_X_URL ?? "",
  prelaunch: process.env.NEXT_PUBLIC_PRELAUNCH === "true",
  projectTokenCa: process.env.NEXT_PUBLIC_PROJECT_TOKEN_CA || null,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com",
};
