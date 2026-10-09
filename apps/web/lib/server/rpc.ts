import "server-only";
import { createSolanaRpc } from "@solana/kit";
import type { AppRpc } from "../chain/read";

// Server-side RPC: the private endpoint (Helius/Triton key) never reaches the browser; the browser uses /api/rpc.
const g = globalThis as unknown as { __unspentRpc?: AppRpc };

export function rpcUrl(): string {
  const url = process.env.RPC_URL;
  if (!url) throw new Error("RPC_URL is not set");
  return url;
}

export function serverRpc(): AppRpc {
  g.__unspentRpc ??= createSolanaRpc(rpcUrl());
  return g.__unspentRpc;
}
