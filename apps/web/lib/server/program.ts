import "server-only";
import { type ProgramState, readProgram } from "../chain/read";
import { serverRpc } from "./rpc";

let cache: { at: number; value: ProgramState | null } | null = null;

/** Program config + supply, cached for a few seconds across requests. */
export async function getProgram(maxAgeMs = 5_000): Promise<ProgramState | null> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.value;
  const value = await readProgram(serverRpc());
  cache = { at: Date.now(), value };
  return value;
}
