import "server-only";
import { serverRpc } from "./rpc";

/** The chain's clock (unix seconds); reservation expiry is decided by it, not by wall time. */
export async function chainNow(): Promise<number> {
  const rpc = serverRpc();
  try {
    const slot = await rpc.getSlot({ commitment: "confirmed" }).send();
    const t = await rpc.getBlockTime(slot).send();
    if (t !== null) return Number(t);
  } catch {}
  return Math.floor(Date.now() / 1000);
}
