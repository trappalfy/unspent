import { createSolanaRpc } from "@solana/kit";
import type { AppRpc } from "./read";

// Browser RPC goes through our allowlisted relay (app/api/rpc) so the provider key stays on the server.
let rpc: AppRpc | null = null;

export function browserRpc(): AppRpc {
  rpc ??= createSolanaRpc(new URL("/api/rpc", window.location.origin).toString());
  return rpc;
}
