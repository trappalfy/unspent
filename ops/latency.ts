// Confirmation latency of a one-instruction transaction sent the way the gateway sends `reserve` (brief 4.1 item 8):
// priority fee at p75 of recent fees, our own rebroadcast every 2 s with maxRetries 0, status polled every 250 ms.
// Reports p50 / p95 / max to `confirmed`. Each transaction is a Memo, so nothing but the fee is spent.
//
// Env: NETWORK (localnet|mainnet), RPC_URL, PAYER_KEYPAIR, N (default 200), CONCURRENCY (default 4),
//      MAX_PRIORITY_FEE_MICROLAMPORTS (default 200000). Mainnet only with CONFIRM_MAINNET=yes.
// Cost on mainnet: N × (5000 lamports + priority fee × 40 000 CU / 10^6); N = 200 at 10 000 μlamports ≈ 0.0011 SOL.

import {
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { env, loadKeypair } from "./lib";

const MEMO = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const network = env("NETWORK", "localnet");
if (network === "mainnet" && process.env.CONFIRM_MAINNET !== "yes")
  throw new Error(
    "Refusing to send on mainnet without CONFIRM_MAINNET=yes (owner's explicit go, brief rule 0.3).",
  );

const rpc = createSolanaRpc(env("RPC_URL", "http://127.0.0.1:8899"));
const payer = await loadKeypair(env("PAYER_KEYPAIR", `keys/${network}-deployer-keypair.json`));
const N = Number(process.env.N ?? 200);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);
const MAX_FEE = BigInt(process.env.MAX_PRIORITY_FEE_MICROLAMPORTS ?? 200_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function priorityFee(): Promise<bigint> {
  const fees = await rpc.getRecentPrioritizationFees([payer.address]).send();
  const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const p75 = sorted[Math.floor(sorted.length * 0.75)] ?? 0n;
  return p75 > MAX_FEE ? MAX_FEE : p75;
}

async function once(i: number, microLamports: bigint): Promise<number | null> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: 40_000 }),
          getSetComputeUnitPriceInstruction({ microLamports }),
          { programAddress: MEMO, data: new TextEncoder().encode(`unspent latency ${Date.now()} ${i}`) },
        ],
        m,
      ),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  const sig = getSignatureFromTransaction(tx);
  const wire = getBase64EncodedWireTransaction(tx);
  const start = performance.now();
  let lastSend = 0;
  while (performance.now() - start < 60_000) {
    if (performance.now() - lastSend >= 2_000) {
      lastSend = performance.now();
      await rpc
        .sendTransaction(wire, { encoding: "base64", skipPreflight: true, maxRetries: 0n })
        .send()
        .catch(() => {});
    }
    await sleep(250);
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const st = value[0];
    if (st?.err) return null;
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized")
      return performance.now() - start;
  }
  return null;
}

const fee = await priorityFee();
console.log(`${network}: ${N} transactions, ${CONCURRENCY} at a time, priority fee ${fee} μlamports/CU`);
const times: number[] = [];
let failed = 0;
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < N) {
      const i = next++;
      const t = await once(i, fee);
      if (t === null) failed++;
      else times.push(t);
      if ((times.length + failed) % 20 === 0) console.log(`  ${times.length + failed}/${N}`);
    }
  }),
);
times.sort((a, b) => a - b);
const q = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))] ?? Number.NaN;
console.log(
  `confirmed ${times.length}/${N}, failed or expired ${failed}: p50 ${(q(0.5) / 1000).toFixed(2)} s, ` +
    `p95 ${(q(0.95) / 1000).toFixed(2)} s, max ${((times.at(-1) ?? Number.NaN) / 1000).toFixed(2)} s`,
);
