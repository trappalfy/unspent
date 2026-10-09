// Indexer process: program logs → chain_events (brief 9.1). Env: DATABASE_URL, RPC_URL, RPC_WS_URL,
// NEXT_PUBLIC_SOLANA_NETWORK.

import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { openPostgres } from "@unspent/db";
import { parseNetwork } from "@unspent/shared";
import { Indexer } from "./indexer";
import { createLogger, errorMessage } from "./log";

const log = createLogger();
const env = process.env;
if (!env.DATABASE_URL) throw new Error("Missing env DATABASE_URL");
const network = parseNetwork(env.NEXT_PUBLIC_SOLANA_NETWORK ?? "mainnet");
const rpcUrl = env.RPC_URL ?? "http://127.0.0.1:8899";
const wsUrl = env.RPC_WS_URL ?? "ws://127.0.0.1:8900";

const { db, close } = await openPostgres(env.DATABASE_URL, { max: 4 });
const indexer = new Indexer({
  db,
  rpc: createSolanaRpc(rpcUrl),
  rpcSubscriptions: createSolanaRpcSubscriptions(wsUrl),
  network,
  log,
});
indexer.start();
log.info("indexer started", { network, rpc: new URL(rpcUrl).host });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("indexer stopping", { signal });
  try {
    await indexer.stop();
    await close();
  } catch (e) {
    log.error("shutdown failed", { error: errorMessage(e) });
    process.exit(1);
  }
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
