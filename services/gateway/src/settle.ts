// Settlement queue (brief 8.12): settle_many in batches of SETTLE_BATCH or every settleFlushMs. Every entry is in the
// DB before it is sent. Entries the program skipped stay queued (burn window) or are closed out (already expired).

import { and, asc, eq, inArray, requests, settleQueue, sql } from "@unspent/db";
import { SETTLE_BATCH } from "@unspent/shared";
import { type Chain, hex } from "./chain";
import type { Db } from "./db";
import type { Logger } from "./log";

type Row = typeof settleQueue.$inferSelect;
const ALERT_AFTER_ATTEMPTS = 5;

export class SettleWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly chain: Chain,
    private readonly log: Logger,
    private readonly flushMs: number,
    private readonly batch = SETTLE_BATCH,
  ) {}

  start(tickMs = 250) {
    this.timer = setInterval(() => void this.tick(), tickMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(force = false): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.flush(force);
    } catch (e) {
      this.log.error("settle tick failed", { error: e instanceof Error ? e.message : "unknown" });
    } finally {
      this.running = false;
    }
  }

  /** Settles everything pending now; for tests and shutdown. */
  async drain(maxRounds = 20): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const [r] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(settleQueue)
        .where(eq(settleQueue.status, "pending"));
      if (!r?.n) return;
      await this.tick(true);
    }
  }

  private async flush(force: boolean) {
    const pending = await this.db
      .select()
      .from(settleQueue)
      .where(eq(settleQueue.status, "pending"))
      .orderBy(asc(settleQueue.id))
      .limit(this.batch);
    if (!pending.length) return;
    const oldest = pending[0]!.createdAt.getTime();
    if (!force && pending.length < this.batch && Date.now() - oldest < this.flushMs) return;
    await this.settle(pending);
  }

  private async settle(rows: Row[]) {
    const ids = rows.map((r) => r.id);
    await this.db
      .update(settleQueue)
      .set({ status: "sent", attempts: sql`${settleQueue.attempts} + 1`, updatedAt: new Date() })
      .where(inArray(settleQueue.id, ids));
    const result = await this.chain.settleMany(
      rows.map((r) => ({ requestId: new Uint8Array(r.requestId), owner: r.owner, actual: r.actualUcr })),
    );

    if (result.kind === "failed") {
      this.log.warn("settle_many failed", {
        entries: rows.length,
        code: result.code,
        message: result.message,
      });
      if (rows.length > 1) {
        // Isolate a bad entry: retry one by one.
        await this.db
          .update(settleQueue)
          .set({ status: "pending", updatedAt: new Date() })
          .where(inArray(settleQueue.id, ids));
        for (const r of rows) await this.settle([{ ...r, attempts: r.attempts + 1 }]);
        return;
      }
      const r = rows[0]!;
      if (!(await this.chain.reservationExists(new Uint8Array(r.requestId)))) {
        await this.closeOut(r, "expired");
        return;
      }
      await this.db
        .update(settleQueue)
        .set({ status: "pending", updatedAt: new Date() })
        .where(eq(settleQueue.id, r.id));
      if (r.attempts + 1 >= ALERT_AFTER_ATTEMPTS)
        this.log.alert("settle_stuck", {
          request: hex(new Uint8Array(r.requestId)),
          attempts: r.attempts + 1,
          code: result.code,
        });
      return;
    }

    for (const r of rows) {
      const id = new Uint8Array(r.requestId);
      if (result.settled.has(hex(id))) {
        await this.db.transaction(async (tx) => {
          await tx
            .update(settleQueue)
            .set({ status: "confirmed", txSig: result.signature, updatedAt: new Date() })
            .where(eq(settleQueue.id, r.id));
          await tx
            .update(requests)
            .set({
              status: r.actualUcr > 0n ? "settled" : "released",
              settleSig: result.signature,
              settledAt: new Date(),
            })
            .where(eq(requests.id, r.requestUuid));
        });
      } else if (await this.chain.reservationExists(id)) {
        // Skipped by the program (burn window or a reservation paid by another key): keep it queued.
        await this.db
          .update(settleQueue)
          .set({ status: "pending", updatedAt: new Date() })
          .where(eq(settleQueue.id, r.id));
        if (r.attempts + 1 >= ALERT_AFTER_ATTEMPTS)
          this.log.alert("settle_skipped_repeatedly", { request: hex(id), attempts: r.attempts + 1 });
      } else {
        await this.closeOut(r, "expired");
      }
    }
  }

  /** The reservation was already released onchain (expired): the user paid nothing, Unspent absorbs the cost. */
  private async closeOut(r: Row, status: "expired") {
    await this.db.transaction(async (tx) => {
      await tx
        .update(settleQueue)
        .set({ status: "skipped_expired", updatedAt: new Date() })
        .where(eq(settleQueue.id, r.id));
      await tx
        .update(requests)
        .set({ status, chargedUcr: 0n })
        .where(and(eq(requests.id, r.requestUuid)));
    });
    this.log.warn("reservation expired before settlement", {
      request: hex(new Uint8Array(r.requestId)),
      unpaid_ucr: r.actualUcr,
    });
  }
}
