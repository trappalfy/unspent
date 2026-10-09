import "server-only";
import { address, getBase64Encoder } from "@solana/kit";
import { serverRpc } from "./rpc";

const CLOCK = address("SysvarC1ock11111111111111111111111111111111");

/**
 * The chain's clock (unix seconds) as the program sees it: the Clock sysvar's unix_timestamp. Reservation expiry and
 * admin_delay are decided by it, not by wall time or block times.
 */
export async function chainNow(): Promise<number> {
  try {
    const { value } = await serverRpc()
      .getAccountInfo(CLOCK, { encoding: "base64", commitment: "confirmed" })
      .send();
    if (value) {
      // slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64
      const data = getBase64Encoder().encode(value.data[0]);
      return Number(new DataView(data.buffer, data.byteOffset).getBigInt64(32, true));
    }
  } catch {}
  return Math.floor(Date.now() / 1000);
}
