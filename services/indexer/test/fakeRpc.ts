// In-memory stand-in for the two RPC methods the indexer calls, with the real paging semantics
// (newest first, `before` / `until` exclusive, `limit`).

import type { ReadonlyUint8Array } from "@solana/kit";
import type { IndexerRpc } from "../src/indexer";
import { ours } from "./logs";

export type FakeTx = { signature: string; slot: bigint; blockTime: bigint; err: unknown; logs: string[] };

export class FakeRpc {
  /** Chronological. */
  readonly txs: FakeTx[] = [];
  readonly calls = { signatures: 0, transaction: 0 };
  /** getTransaction returns null this many more times per signature. */
  readonly nulls = new Map<string, number>();
  private slot = 100n;

  /** Appends a transaction of our program emitting `events`; returns its signature. */
  add(
    events: ReadonlyUint8Array[],
    opts: { err?: unknown; logs?: string[]; sameSlot?: boolean } = {},
  ): string {
    if (!opts.sameSlot) this.slot += 3n;
    const signature = `sig${String(this.txs.length).padStart(5, "0")}`;
    this.txs.push({
      signature,
      slot: this.slot,
      blockTime: 1_800_000_000n + this.slot,
      err: opts.err ?? null,
      logs: opts.logs ?? ours(...events),
    });
    return signature;
  }

  getSignaturesForAddress(_address: string, cfg: { limit?: number; before?: string; until?: string } = {}) {
    return {
      send: async () => {
        this.calls.signatures++;
        const newest = [...this.txs].reverse();
        let start = 0;
        if (cfg.before) start = newest.findIndex((t) => t.signature === cfg.before) + 1;
        const out = [];
        for (const t of newest.slice(start)) {
          if (t.signature === cfg.until || out.length >= (cfg.limit ?? 1000)) break;
          out.push({
            signature: t.signature,
            slot: t.slot,
            blockTime: t.blockTime,
            err: t.err,
            memo: null,
            confirmationStatus: "confirmed",
          });
        }
        return out;
      },
    };
  }

  getTransaction(signature: string) {
    return {
      send: async () => {
        this.calls.transaction++;
        const left = this.nulls.get(signature) ?? 0;
        if (left > 0) {
          this.nulls.set(signature, left - 1);
          return null;
        }
        const t = this.txs.find((x) => x.signature === signature);
        if (!t) return null;
        return { slot: t.slot, blockTime: t.blockTime, meta: { err: t.err, logMessages: t.logs } };
      },
    };
  }

  asRpc(): IndexerRpc {
    return this as unknown as IndexerRpc;
  }
}
