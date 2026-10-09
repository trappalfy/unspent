// Background reconciliation every 2 minutes (brief 8.12). Decisions use the onchain reservation state and DB records.
// A request is never sent to the provider again from here.

import { and, eq, inArray, isNotNull, lt, or, requests, settleQueue, sql } from "@unspent/db";
import { maxRequestDurationSec } from "@unspent/shared";
import { type Chain, hex } from "./chain";
import type { Db } from "./db";
import type { Logger } from "./log";

export class Reconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private runs = 0;
  private mismatches = 0;

  constructor(
    private readonly db: Db,
    private readonly chain: Chain,
    private readonly log: Logger,
    private readonly opts: { intervalMs: number; staleAfterMs: number },
  ) {}

  start() {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async release(
    r: { id: string; requestId: Uint8Array; wallet: string },
    status: "unknown" | "completed",
  ) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(requests)
        .set({ status, chargedUcr: 0n, completedAt: new Date() })
        .where(eq(requests.id, r.id));
      await tx
        .insert(settleQueue)
        .values({ requestUuid: r.id, requestId: r.requestId, owner: r.wallet, actualUcr: 0n })
        .onConflictDoNothing();
    });
  }

  async runOnce(now = new Date()): Promise<void> {
    try {
      await this.reservations(now);
      await this.stale(now);
      if (this.runs++ % 5 === 0) await this.checkActiveReserved();
    } catch (e) {
      this.log.error("reconcile failed", { error: e instanceof Error ? e.message : "unknown" });
    }
  }

  /** Reservations whose confirmation never arrived in time (or a crash between signing and confirmation). */
  private async reservations(now: Date) {
    const staleBefore = new Date(now.getTime() - this.opts.staleAfterMs);
    const rows = await this.db
      .select()
      .from(requests)
      .where(
        or(
          eq(requests.status, "reserve_timeout"),
          and(eq(requests.status, "reserving"), lt(requests.createdAt, staleBefore)),
        ),
      );
    if (!rows.length) return;
    const height = await this.chain.blockHeight();
    for (const r of rows) {
      const id = new Uint8Array(r.requestId);
      if (!r.reserveSig) {
        await this.db.update(requests).set({ status: "released" }).where(eq(requests.id, r.id));
        continue;
      }
      const state = await this.chain.signatureState(r.reserveSig);
      if (state === "confirmed" || (await this.chain.reservationExists(id))) {
        // The transaction landed after we gave up: release the hold right away.
        this.log.warn("late reservation released", { request: hex(id) });
        await this.release({ id: r.id, requestId: id, wallet: r.wallet }, "completed");
      } else if (
        state === "failed" ||
        (r.reserveLastValidBlockHeight !== null && height > r.reserveLastValidBlockHeight)
      ) {
        await this.db.update(requests).set({ status: "released" }).where(eq(requests.id, r.id));
      }
    }
  }

  /** Dispatched requests with no progress for 2 minutes, or past the max duration: outcome unknown, Unspent pays. */
  private async stale(now: Date) {
    const program = await this.chain.program();
    const staleBefore = new Date(now.getTime() - this.opts.staleAfterMs);
    const tooOld = new Date(
      now.getTime() - (maxRequestDurationSec(Number(program.reservationTtl)) + 60) * 1000,
    );
    const rows = await this.db
      .select({ id: requests.id, requestId: requests.requestId, wallet: requests.wallet })
      .from(requests)
      .where(
        and(
          inArray(requests.status, ["reserved", "dispatched"]),
          or(
            lt(
              sql`coalesce(${requests.lastProgressAt}, ${requests.dispatchedAt}, ${requests.createdAt})`,
              staleBefore,
            ),
            and(isNotNull(requests.dispatchedAt), lt(requests.dispatchedAt, tooOld)),
          ),
        ),
      );
    for (const r of rows) {
      this.log.warn("stale request released, outcome unknown", { request: hex(new Uint8Array(r.requestId)) });
      await this.release({ id: r.id, requestId: new Uint8Array(r.requestId), wallet: r.wallet }, "unknown");
    }
  }

  /** Σ live holds by the DB vs the program's active_reserved; alert after two mismatches in a row (brief 9.2). */
  private async checkActiveReserved() {
    const program = await this.chain.program();
    const [open] = await this.db
      .select({ v: sql<string>`coalesce(sum(${requests.reservedUcr}), 0)` })
      .from(requests)
      .leftJoin(settleQueue, eq(settleQueue.requestUuid, requests.id))
      .where(
        or(
          inArray(requests.status, ["reserved", "dispatched", "unknown"]),
          and(eq(requests.status, "completed"), inArray(settleQueue.status, ["pending", "sent"])),
        ),
      );
    const dbHeld = BigInt(open?.v ?? 0);
    if (dbHeld !== program.activeReserved) {
      this.mismatches++;
      if (this.mismatches >= 2)
        this.log.alert("active_reserved_mismatch", { db: dbHeld, chain: program.activeReserved });
    } else {
      this.mismatches = 0;
    }
  }
}
