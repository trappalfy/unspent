// The gateway's view of the onchain program: read config and user balances, send reserve and settle_many.

import { readFileSync } from "node:fs";
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  pipe,
  type Signature,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  fetchConfig,
  fetchMaybeUserAccount,
  findConfigPda,
  findReservationPda,
  findReservePda,
  findUserPda,
  findVaultPda,
  getReserveInstructionAsync,
  getSettleManyInstructionAsync,
  parseSettledEvent,
  SETTLED_EVENT_DISCRIMINATOR,
  UNSPENT_PROGRAM_ADDRESS,
} from "@unspent/program";

export type ProgramState = {
  shutDown: boolean;
  gatewayPaused: boolean;
  maxReservation: bigint;
  maxReservedPerUser: bigint;
  reservationTtl: bigint;
  activeReserved: bigint;
  treasury: Address;
  creditMint: Address;
};

export type UserState = { balance: bigint; reserved: bigint; reserveCap: bigint };

export type ReserveResult =
  | { kind: "confirmed" }
  | { kind: "rejected"; code: number | null; message: string }
  | { kind: "timeout" };

export type SettleEntry = { requestId: Uint8Array; owner: string; actual: bigint };

export type SettleResult =
  | { kind: "confirmed"; signature: string; settled: Set<string> }
  | { kind: "failed"; code: number | null; message: string };

export type SignatureState = "confirmed" | "failed" | "not_found";

export interface Chain {
  program(): Promise<ProgramState>;
  user(owner: string): Promise<UserState | null>;
  /** Signs, reports the signature and lastValidBlockHeight through onSigned BEFORE sending, then waits for confirmed. */
  reserve(
    requestId: Uint8Array,
    owner: string,
    amount: bigint,
    onSigned: (signature: string, lastValidBlockHeight: bigint) => Promise<void>,
    timeoutMs: number,
  ): Promise<ReserveResult>;
  settleMany(entries: SettleEntry[]): Promise<SettleResult>;
  reservationExists(requestId: Uint8Array): Promise<boolean>;
  signatureState(signature: string): Promise<SignatureState>;
  blockHeight(): Promise<bigint>;
}

export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type TxErr = { InstructionError?: [number, { Custom?: number } | string] } | string | null | undefined;

export function customErrorCode(err: unknown): number | null {
  const ie = (err as TxErr & object)?.InstructionError;
  if (!ie) return null;
  const detail = ie[1];
  return typeof detail === "object" && detail && typeof detail.Custom === "number" ? detail.Custom : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SolanaChain implements Chain {
  private readonly rpc;
  private cached: { at: number; value: ProgramState } | null = null;
  private fee: { at: number; value: bigint } | null = null;

  private constructor(
    rpcUrl: string,
    private readonly signer: KeyPairSigner,
    private readonly maxPriorityFee: bigint,
  ) {
    this.rpc = createSolanaRpc(rpcUrl);
  }

  static async create(rpcUrl: string, keypairPath: string, maxPriorityFee: bigint): Promise<SolanaChain> {
    const bytes = Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8")));
    return new SolanaChain(rpcUrl, await createKeyPairSignerFromBytes(bytes), maxPriorityFee);
  }

  get gatewayAddress(): Address {
    return this.signer.address;
  }

  async program(): Promise<ProgramState> {
    if (this.cached && Date.now() - this.cached.at < 2_000) return this.cached.value;
    const [config] = await findConfigPda();
    const c = (await fetchConfig(this.rpc, config, { commitment: "confirmed" })).data;
    const value: ProgramState = {
      shutDown: c.shutDown,
      gatewayPaused: c.gatewayPaused,
      maxReservation: c.maxReservation,
      maxReservedPerUser: c.maxReservedPerUser,
      reservationTtl: c.reservationTtl,
      activeReserved: c.activeReserved,
      treasury: c.treasury,
      creditMint: c.creditMint,
    };
    this.cached = { at: Date.now(), value };
    return value;
  }

  async user(owner: string): Promise<UserState | null> {
    const [pda] = await findUserPda({ owner: address(owner) });
    const acc = await fetchMaybeUserAccount(this.rpc, pda, { commitment: "confirmed" });
    if (!acc.exists) return null;
    return { balance: acc.data.balance, reserved: acc.data.reserved, reserveCap: acc.data.reserveCap };
  }

  /** p75 of recent priority fees on the program, capped; zero on a local validator. */
  private async priorityFee(): Promise<bigint> {
    if (this.fee && Date.now() - this.fee.at < 10_000) return this.fee.value;
    let value = 0n;
    try {
      const fees = await this.rpc.getRecentPrioritizationFees([UNSPENT_PROGRAM_ADDRESS]).send();
      const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      value = sorted.length ? (sorted[Math.floor(sorted.length * 0.75)] ?? 0n) : 0n;
    } catch {}
    value = value > this.maxPriorityFee ? this.maxPriorityFee : value;
    this.fee = { at: Date.now(), value };
    return value;
  }

  private async sign(ixs: Instruction[], units: number) {
    const microLamports = await this.priorityFee();
    const { value: blockhash } = await this.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(this.signer, m),
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
    );
    const tx = await signTransactionMessageWithSigners(msg);
    return {
      tx,
      signature: getSignatureFromTransaction(tx),
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    };
  }

  /** Sends with our own rebroadcast (maxRetries 0 at the RPC) until confirmed, failed, expired or timed out. */
  private async sendAndWait(
    wire: ReturnType<typeof getBase64EncodedWireTransaction>,
    signature: Signature,
    lastValidBlockHeight: bigint,
    timeoutMs: number,
  ): Promise<{ kind: "confirmed" } | { kind: "failed"; err: unknown } | { kind: "timeout" }> {
    const started = Date.now();
    let lastSend = 0;
    while (Date.now() - started < timeoutMs) {
      if (Date.now() - lastSend >= 2_000) {
        lastSend = Date.now();
        await this.rpc
          .sendTransaction(wire, { encoding: "base64", skipPreflight: true, maxRetries: 0n })
          .send()
          .catch(() => {});
      }
      await sleep(250);
      const { value } = await this.rpc.getSignatureStatuses([signature]).send();
      const st = value[0];
      if (st?.err) return { kind: "failed", err: st.err };
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized"))
        return { kind: "confirmed" };
      if (!st && (await this.blockHeight()) > lastValidBlockHeight) return { kind: "timeout" };
    }
    return { kind: "timeout" };
  }

  async reserve(
    requestId: Uint8Array,
    owner: string,
    amount: bigint,
    onSigned: (signature: string, lastValidBlockHeight: bigint) => Promise<void>,
    timeoutMs: number,
  ): Promise<ReserveResult> {
    const ix = await getReserveInstructionAsync({
      gateway: this.signer,
      requestId,
      owner: address(owner),
      amount,
    });
    const { tx, signature, lastValidBlockHeight } = await this.sign([ix], 40_000);
    await onSigned(signature, lastValidBlockHeight);
    const r = await this.sendAndWait(
      getBase64EncodedWireTransaction(tx),
      signature,
      lastValidBlockHeight,
      timeoutMs,
    );
    if (r.kind === "failed")
      return { kind: "rejected", code: customErrorCode(r.err), message: JSON.stringify(r.err) };
    return r;
  }

  async settleMany(entries: SettleEntry[]): Promise<SettleResult> {
    const p = await this.program();
    const [vault] = await findVaultPda();
    const [reserve] = await findReservePda();
    const ix = await getSettleManyInstructionAsync({
      gateway: this.signer,
      rentPayer: this.signer.address,
      creditMint: p.creditMint,
      vault,
      reserve,
      treasury: p.treasury,
      actuals: entries.map((e) => e.actual),
    });
    const extra: { address: Address; role: AccountRole }[] = [];
    for (const e of entries) {
      const [res] = await findReservationPda({ requestId: e.requestId });
      const [user] = await findUserPda({ owner: address(e.owner) });
      extra.push({ address: res, role: AccountRole.WRITABLE }, { address: user, role: AccountRole.WRITABLE });
    }
    const full: Instruction = { ...ix, accounts: [...ix.accounts, ...extra] };
    const { tx, signature, lastValidBlockHeight } = await this.sign([full], 60_000 + 8_000 * entries.length);
    const r = await this.sendAndWait(
      getBase64EncodedWireTransaction(tx),
      signature,
      lastValidBlockHeight,
      30_000,
    );
    if (r.kind === "failed")
      return { kind: "failed", code: customErrorCode(r.err), message: JSON.stringify(r.err) };
    if (r.kind === "timeout")
      return { kind: "failed", code: null, message: "settle_many not confirmed in time" };
    return { kind: "confirmed", signature, settled: await this.settledIn(signature) };
  }

  /** Request ids (hex) settled by a transaction, from its Settled events. */
  private async settledIn(signature: Signature): Promise<Set<string>> {
    const out = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const tx = await this.rpc
        .getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
          encoding: "json",
        })
        .send();
      const logs = tx?.meta?.logMessages;
      if (logs) {
        for (const l of logs) {
          if (!l.startsWith("Program data: ")) continue;
          const bytes = new Uint8Array(Buffer.from(l.slice(14), "base64"));
          if (SETTLED_EVENT_DISCRIMINATOR.every((b, j) => bytes[j] === b))
            out.add(hex(new Uint8Array(parseSettledEvent(bytes).requestId)));
        }
        return out;
      }
      await sleep(250);
    }
    return out;
  }

  async reservationExists(requestId: Uint8Array): Promise<boolean> {
    const [pda] = await findReservationPda({ requestId });
    const acc = await this.rpc.getAccountInfo(pda, { commitment: "confirmed", encoding: "base64" }).send();
    return acc.value !== null && acc.value.lamports > 0n;
  }

  async signatureState(signature: string): Promise<SignatureState> {
    const { value } = await this.rpc
      .getSignatureStatuses([signature as Signature], { searchTransactionHistory: true })
      .send();
    const st = value[0];
    if (!st) return "not_found";
    if (st.err) return "failed";
    return st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized"
      ? "confirmed"
      : "not_found";
  }

  async blockHeight(): Promise<bigint> {
    return this.rpc.getBlockHeight({ commitment: "confirmed" }).send();
  }
}
