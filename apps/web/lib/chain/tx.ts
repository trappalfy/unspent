// Compile → simulate (exact compute units, readable errors before the wallet opens) → sign in the wallet → send with
// our own rebroadcast → confirmed. The UI walks "Signing → Confirming → Done" (brief 10.2).

import {
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  type Instruction,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Transaction,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { UNSPENT_PROGRAM_ADDRESS } from "@unspent/program";
import type { AppRpc } from "./read";

export const TX_SIZE_LIMIT = 1232;
const BASE_FEE_LAMPORTS = 5_000n;
const MAX_PRIORITY_MICROLAMPORTS = 1_000_000n;
const SIM_UNITS = 1_400_000;

export class TxError extends Error {
  constructor(
    message: string,
    readonly logs: string[] = [],
  ) {
    super(message);
  }
}
export class TxTooLargeError extends TxError {}

export type Prepared = {
  tx: Transaction;
  bytes: Uint8Array;
  units: number;
  microLamports: bigint;
  /** Base fee + priority fee in lamports (rent for new accounts is separate). */
  feeLamports: bigint;
  lastValidBlockHeight: bigint;
};

const PROGRAM_ERRORS: Record<number, string> = {
  6003: "Unspent is shut down. Withdraw your balance and redeem credits for USDC.",
  6004: "Redeem opens only after Unspent shuts down.",
  6005: "Buying is paused right now. Try again later.",
  6006: "Deposits are paused right now. Try again later.",
  6008: "Enter an amount above zero.",
  6009: "The minimum purchase is 1 credit.",
  6010: "That's above the per-purchase maximum. Split it into smaller purchases.",
  6011: "This purchase would exceed the credit supply cap.",
  6012: "Not enough available balance. Credits held for running requests can't be withdrawn yet.",
  6018: "That reservation hasn't expired yet.",
  6021: "That reservation belongs to another wallet.",
  6026: "Value is outside the allowed range.",
  6002: "The treasury must be a USDC account other than the reserve.",
  6028: "There's no pending change for this field.",
  6029: "This change isn't effective yet.",
  6030: "No backup gateway key is set.",
  6031: "The vault or reserve holds less than it owes. Nothing was moved.",
};

type TxErr = { InstructionError?: [number, { Custom?: number } | string] } | string | null | undefined;

/** Turns a simulation / status error into something a person can act on. */
export function explainError(err: unknown, programs: Address[], logs: string[] = []): string {
  if (typeof err === "string") {
    if (err === "InsufficientFundsForFee" || err === "AccountNotFound")
      return "Not enough SOL to pay network fees. Add a little SOL to this wallet.";
    if (err === "BlockhashNotFound") return "The network moved on before the transaction landed. Try again.";
    return `Transaction failed: ${err}.`;
  }
  const ie = (err as TxErr & object)?.InstructionError;
  if (!ie) return "Transaction failed.";
  const [index, detail] = ie;
  const program = programs[index];
  const code = typeof detail === "object" && detail ? detail.Custom : undefined;
  if (program === UNSPENT_PROGRAM_ADDRESS && code !== undefined && PROGRAM_ERRORS[code])
    return PROGRAM_ERRORS[code];
  if (program === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" && code === 1)
    return "Not enough tokens in your wallet for this.";
  if (program === "BPFLoaderUpgradeab1e11111111111111111111111")
    return "The program loader refused this. Check that the buffer is complete and its authority is this wallet.";
  if (program === "11111111111111111111111111111111" && code === 1)
    return "Not enough SOL for this transaction and the accounts it creates.";
  if (logs.some((l) => /slippage/i.test(l)))
    return "The price moved past your slippage limit. Get a new quote and try again.";
  if (detail === "ProgramFailedToComplete" || detail === "ComputationalBudgetExceeded")
    return "The transaction ran out of compute. Try again.";
  return code !== undefined
    ? `Transaction failed (program error ${code}).`
    : `Transaction failed: ${typeof detail === "string" ? detail : "unknown error"}.`;
}

/** p75 of recent priority fees on the accounts this transaction writes, capped. */
async function priorityFee(rpc: AppRpc, ixs: Instruction[]): Promise<bigint> {
  const writable = new Set<Address>();
  for (const ix of ixs) for (const a of ix.accounts ?? []) if (a.role & 1) writable.add(a.address);
  try {
    const fees = await rpc.getRecentPrioritizationFees([...writable].slice(0, 128)).send();
    const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const p75 = sorted.length ? (sorted[Math.floor(sorted.length * 0.75)] ?? 0n) : 0n;
    return p75 > MAX_PRIORITY_MICROLAMPORTS ? MAX_PRIORITY_MICROLAMPORTS : p75;
  } catch {
    return 0n;
  }
}

function compile(
  feePayer: Address,
  blockhash: { blockhash: Blockhash; lastValidBlockHeight: bigint },
  ixs: Instruction[],
  units: number,
  microLamports: bigint,
  alts: Record<Address, Address[]>,
): Transaction {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units }),
          getSetComputeUnitPriceInstruction({ microLamports }),
          ...ixs,
        ],
        m,
      ),
    (m) => (Object.keys(alts).length ? compressTransactionMessageUsingAddressLookupTables(m, alts) : m),
  );
  return compileTransaction(msg);
}

const encoder = getTransactionEncoder();

export async function prepare(
  rpc: AppRpc,
  feePayer: Address,
  ixs: Instruction[],
  alts: Record<Address, Address[]> = {},
): Promise<Prepared> {
  const programs = instructionPrograms(ixs);
  const [{ value: blockhash }, microLamports] = await Promise.all([
    rpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
    priorityFee(rpc, ixs),
  ]);
  const probe = compile(feePayer, blockhash, ixs, SIM_UNITS, microLamports, alts);
  const probeBytes = encoder.encode(probe);
  if (probeBytes.length > TX_SIZE_LIMIT) throw new TxTooLargeError("Transaction too large.");
  const sim = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(probe), {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    })
    .send();
  const logs = (sim.value.logs ?? []) as string[];
  if (sim.value.err) throw new TxError(explainError(sim.value.err, programs, logs), logs);
  const used = Number(sim.value.unitsConsumed ?? 200_000n);
  const units = Math.min(SIM_UNITS, Math.ceil(used * 1.15) + 2_000);
  const tx = compile(feePayer, blockhash, ixs, units, microLamports, alts);
  const bytes = new Uint8Array(encoder.encode(tx));
  const priority = (BigInt(units) * microLamports + 999_999n) / 1_000_000n;
  return {
    tx,
    bytes,
    units,
    microLamports,
    feeLamports: BASE_FEE_LAMPORTS + priority,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  };
}

export type SignResult = { signed: Uint8Array } | { signature: string };
export type Stage = "signing" | "confirming" | "done";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const decoder = getTransactionDecoder();

/** Signs in the wallet, sends (rebroadcasting every 2 s) and waits for `confirmed`. Returns the signature. */
export async function signAndConfirm(
  rpc: AppRpc,
  p: Prepared,
  sign: (bytes: Uint8Array) => Promise<SignResult>,
  onStage: (s: Stage, signature?: string) => void,
  programs: Address[] = [],
): Promise<string> {
  onStage("signing");
  const res = await sign(p.bytes);
  let signature: Signature;
  let wire: ReturnType<typeof getBase64EncodedWireTransaction> | null = null;
  if ("signed" in res) {
    const signed = decoder.decode(res.signed);
    signature = getSignatureFromTransaction(signed);
    wire = getBase64EncodedWireTransaction(signed);
  } else {
    signature = res.signature as Signature;
  }
  onStage("confirming", signature);
  let lastSend = 0;
  for (;;) {
    if (wire && Date.now() - lastSend >= 2_000) {
      lastSend = Date.now();
      await rpc
        .sendTransaction(wire, { encoding: "base64", skipPreflight: true, maxRetries: 0n })
        .send()
        .catch(() => {});
    }
    await sleep(500);
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const st = value[0];
    if (st?.err) throw new TxError(explainError(st.err, programs));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) break;
    if (!st) {
      const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
      if (height > p.lastValidBlockHeight)
        throw new TxError("The transaction expired before it landed. Nothing was charged. Try again.");
    }
  }
  onStage("done", signature);
  return signature;
}

/** Program per top-level instruction index, as compiled by prepare (two compute-budget instructions first). */
export function instructionPrograms(ixs: Instruction[]): Address[] {
  return [
    "ComputeBudget111111111111111111111111111111" as Address,
    "ComputeBudget111111111111111111111111111111" as Address,
    ...ixs.map((i) => i.programAddress),
  ];
}

/** Rent of a new token account and of the UserAccount PDA (65 bytes), in lamports. */
export const ATA_RENT = 2_039_280n;
export const USER_ACCOUNT_RENT = (128n + 65n) * 6_960n;
