import "server-only";
import { recentSettlements, type Settlement, settlementsSince } from "@unspent/indexer";
import { type ProgramState, readReserveBalances } from "../chain/read";
import { network } from "../env";
import { getDb } from "./db";
import { getProgram } from "./program";
import { serverRpc } from "./rpc";

export type LandingStats = {
  program: ProgramState;
  reserveUsdc: bigint;
  last: Settlement | null;
  /** null when the history DB is unavailable. */
  settled24h: number | null;
};

/** Live numbers for the landing reserve block; null when the program isn't live or the chain can't be read. */
export async function landingStats(): Promise<LandingStats | null> {
  try {
    const program = await getProgram();
    if (!program) return null;
    const db = Promise.resolve()
      .then(getDb)
      .catch(() => null);
    const [balances, last, settled24h] = await Promise.all([
      readReserveBalances(serverRpc(), program),
      db.then((d) => (d ? recentSettlements(d, network, 1) : [])).catch(() => []),
      db
        .then((d) => (d ? settlementsSince(d, network, new Date(Date.now() - 86_400_000)) : null))
        .catch(() => null),
    ]);
    return { program, reserveUsdc: balances.reserveUsdc, last: last[0] ?? null, settled24h };
  } catch {
    return null;
  }
}

/** reservation_ttl in words for "its hold can be released by anyone after …". */
export function ttlWords(seconds: bigint): string {
  const s = Number(seconds);
  if (s % 3600 === 0) return s === 3600 ? "an hour" : `${s / 3600} hours`;
  if (s % 60 === 0) return `${s / 60} minutes`;
  return `${s} seconds`;
}
