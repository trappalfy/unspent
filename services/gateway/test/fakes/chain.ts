// In-memory stand-in for the onchain program with the same checks as reserve / settle_many (programs/unspent).
// Checks and effects run without awaits in between, like an atomic instruction.

import type { Address } from "@solana/kit";
import type {
  Chain,
  ProgramState,
  ReserveResult,
  SettleEntry,
  SettleResult,
  SignatureState,
  UserState,
} from "../../src/chain";
import { hex } from "../../src/chain";

const C = 1_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ReserveMode = "ok" | "timeout" | "timeout_then_land" | "timeout_never_lands";

export class FakeChain implements Chain {
  state: ProgramState = {
    shutDown: false,
    gatewayPaused: false,
    maxReservation: 25n * C,
    maxReservedPerUser: 50n * C,
    reservationTtl: 3600n,
    activeReserved: 0n,
    treasury: "Treasury1111111111111111111111111111111111" as Address,
    creditMint: "CreditMint111111111111111111111111111111111" as Address,
  };
  users = new Map<string, UserState>();
  reservations = new Map<string, { owner: string; amount: bigint }>();
  signatures = new Map<string, SignatureState>();
  height = 1_000n;
  reserveDelayMs = 0;
  reserveMode: ReserveMode = "ok";
  settleFails = 0;
  burned = 0n;
  settleCalls: SettleEntry[][] = [];
  reserveCalls = 0;
  private sigN = 0;

  fund(owner: string, credits: bigint) {
    const u = this.users.get(owner) ?? { balance: 0n, reserved: 0n, reserveCap: 0n };
    this.users.set(owner, { ...u, balance: u.balance + credits * C });
  }

  async program(): Promise<ProgramState> {
    return { ...this.state };
  }

  async user(owner: string): Promise<UserState | null> {
    const u = this.users.get(owner);
    return u ? { ...u } : null;
  }

  /** The program's reserve checks and effects. Returns an error code or null. */
  applyReserve(id: string, owner: string, amount: bigint): number | null {
    const s = this.state;
    if (s.shutDown) return 0x1773;
    if (s.gatewayPaused) return 0x1777;
    const u = this.users.get(owner);
    if (!u) return 3012;
    if (amount > s.maxReservation) return 0x177d;
    if (amount > u.balance - u.reserved) return 0x177c;
    const limit =
      u.reserveCap > 0n && u.reserveCap < s.maxReservedPerUser ? u.reserveCap : s.maxReservedPerUser;
    if (u.reserved + amount > limit) return 0x177e;
    if (this.reservations.has(id)) return 0;
    u.reserved += amount;
    s.activeReserved += amount;
    this.reservations.set(id, { owner, amount });
    return null;
  }

  async reserve(
    requestId: Uint8Array,
    owner: string,
    amount: bigint,
    onSigned: (signature: string, lastValidBlockHeight: bigint) => Promise<void>,
    timeoutMs: number,
  ): Promise<ReserveResult> {
    this.reserveCalls++;
    const sig = `sig${++this.sigN}`;
    await onSigned(sig, this.height + 150n);
    const mode = this.reserveMode;
    if (mode !== "ok") {
      await sleep(Math.min(timeoutMs, 50));
      if (mode === "timeout_then_land") {
        const code = this.applyReserve(hex(requestId), owner, amount);
        this.signatures.set(sig, code === null ? "confirmed" : "failed");
      }
      return { kind: "timeout" };
    }
    if (this.reserveDelayMs) await sleep(this.reserveDelayMs);
    const code = this.applyReserve(hex(requestId), owner, amount);
    if (code !== null) {
      this.signatures.set(sig, "failed");
      return { kind: "rejected", code, message: `custom ${code}` };
    }
    this.signatures.set(sig, "confirmed");
    return { kind: "confirmed" };
  }

  async settleMany(entries: SettleEntry[]): Promise<SettleResult> {
    this.settleCalls.push(entries);
    if (this.settleFails > 0) {
      this.settleFails--;
      return { kind: "failed", code: null, message: "injected failure" };
    }
    for (const e of entries) {
      const r = this.reservations.get(hex(e.requestId));
      if (r && e.actual > r.amount) return { kind: "failed", code: 0x1780, message: "ActualExceedsReserved" };
    }
    const settled = new Set<string>();
    for (const e of entries) {
      const id = hex(e.requestId);
      const r = this.reservations.get(id);
      if (!r) continue;
      const u = this.users.get(r.owner)!;
      u.reserved -= r.amount;
      u.balance -= e.actual;
      this.state.activeReserved -= r.amount;
      this.burned += e.actual;
      this.reservations.delete(id);
      settled.add(id);
    }
    return { kind: "confirmed", signature: `settle${++this.sigN}`, settled };
  }

  /** Anyone's expire after the TTL. */
  expire(requestId: Uint8Array) {
    const id = hex(requestId);
    const r = this.reservations.get(id);
    if (!r) return;
    this.users.get(r.owner)!.reserved -= r.amount;
    this.state.activeReserved -= r.amount;
    this.reservations.delete(id);
  }

  async reservationExists(requestId: Uint8Array): Promise<boolean> {
    return this.reservations.has(hex(requestId));
  }

  async signatureState(signature: string): Promise<SignatureState> {
    return this.signatures.get(signature) ?? "not_found";
  }

  async blockHeight(): Promise<bigint> {
    return this.height;
  }
}
