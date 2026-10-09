// Program history → chain_events (brief 9.1). Signatures for the program address are the source of truth:
// every poll walks them back to the cursor and indexes oldest first, one DB transaction per chain transaction
// (events + cursor), so a crash or a re-run never loses or duplicates an event. The logs subscription and the
// interval only decide when to poll. Balances are read from program accounts, not from here.

import type {
  Address,
  GetSignaturesForAddressApi,
  GetTransactionApi,
  LogsNotificationsApi,
  Rpc,
  RpcSubscriptions,
  Signature,
} from "@solana/kit";
import { chainEvents, type Db, eq, indexerCursor } from "@unspent/db";
import { eventOwner, parseProgramEvents, UNSPENT_PROGRAM_ADDRESS } from "@unspent/program";
import type { Network } from "@unspent/shared";
import { errorMessage, type Logger } from "./log";

export type IndexerRpc = Rpc<GetSignaturesForAddressApi & GetTransactionApi>;
export type IndexerSubscriptions = RpcSubscriptions<LogsNotificationsApi>;

export type IndexerOptions = {
  db: Db;
  rpc: IndexerRpc;
  /** Optional: without it start() only polls on the interval. */
  rpcSubscriptions?: IndexerSubscriptions;
  network: Network;
  programId?: Address;
  log: Logger;
  /** getSignaturesForAddress page size (RPC max 1000). */
  pageSize?: number;
  /** Safety-net poll period, catches anything the subscription missed. */
  backfillMs?: number;
  /** Notifications arriving within this window share one poll. */
  debounceMs?: number;
  /** getTransaction calls in flight; results are still committed in order. */
  fetchConcurrency?: number;
  /** getTransaction can return null briefly right after confirmation. */
  txRetries?: number;
  txRetryMs?: number;
  /** First reconnect delay of the logs subscription; doubles up to 30 s. */
  reconnectMs?: number;
};

export type PollResult = { transactions: number; events: number };

type SignatureInfo = { signature: Signature; slot: bigint; blockTime: bigint | null; err: unknown };
type Cursor = { lastSignature: string | null; lastSlot: bigint | null };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

export class Indexer {
  private readonly db: Db;
  private readonly rpc: IndexerRpc;
  private readonly subs: IndexerSubscriptions | undefined;
  private readonly network: Network;
  private readonly programId: Address;
  private readonly log: Logger;
  private readonly pageSize: number;
  private readonly backfillMs: number;
  private readonly debounceMs: number;
  private readonly concurrency: number;
  private readonly txRetries: number;
  private readonly txRetryMs: number;
  private readonly reconnectMs: number;

  private current: Promise<PollResult> | null = null;
  private rerun = false;
  private abort: AbortController | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(o: IndexerOptions) {
    this.db = o.db;
    this.rpc = o.rpc;
    this.subs = o.rpcSubscriptions;
    this.network = o.network;
    this.programId = o.programId ?? UNSPENT_PROGRAM_ADDRESS;
    this.log = o.log;
    this.pageSize = o.pageSize ?? 1000;
    this.backfillMs = o.backfillMs ?? 15_000;
    this.debounceMs = o.debounceMs ?? 300;
    this.concurrency = o.fetchConcurrency ?? 8;
    this.txRetries = o.txRetries ?? 5;
    this.txRetryMs = o.txRetryMs ?? 200;
    this.reconnectMs = o.reconnectMs ?? 1_000;
  }

  /** Indexes everything newer than the cursor. A call made while a poll runs is served by one extra pass. */
  poll(): Promise<PollResult> {
    if (this.current) {
      this.rerun = true;
      return this.current;
    }
    const run = async () => {
      const total: PollResult = { transactions: 0, events: 0 };
      try {
        do {
          this.rerun = false;
          const r = await this.pollOnce();
          total.transactions += r.transactions;
          total.events += r.events;
        } while (this.rerun);
      } finally {
        this.current = null;
      }
      return total;
    };
    this.current = run();
    return this.current;
  }

  start(): void {
    if (this.abort) return;
    const abort = new AbortController();
    this.abort = abort;
    this.kick();
    this.interval = setInterval(() => this.kick(), this.backfillMs);
    if (this.subs) void this.subscribeLoop(this.subs, abort.signal);
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    this.abort = null;
    if (this.interval) clearInterval(this.interval);
    if (this.debounce) clearTimeout(this.debounce);
    this.interval = this.debounce = null;
    this.rerun = false;
    await this.current?.catch(() => {});
  }

  private kick() {
    this.poll().then(
      (r) => {
        if (r.transactions > 0) this.log.info("indexed", { network: this.network, ...r });
      },
      (e) => this.log.error("poll failed", { network: this.network, error: errorMessage(e) }),
    );
  }

  private schedule() {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.kick();
    }, this.debounceMs);
  }

  private async subscribeLoop(subs: IndexerSubscriptions, signal: AbortSignal) {
    let backoff = this.reconnectMs;
    while (!signal.aborted) {
      try {
        const notifications = await subs
          .logsNotifications({ mentions: [this.programId] }, { commitment: "confirmed" })
          .subscribe({ abortSignal: signal });
        this.log.info("logs subscription open", { network: this.network });
        backoff = this.reconnectMs;
        this.schedule(); // whatever landed while we were disconnected
        for await (const _ of notifications) this.schedule();
      } catch (e) {
        if (signal.aborted) break;
        this.log.warn("logs subscription dropped", { network: this.network, error: errorMessage(e) });
      }
      if (signal.aborted) break;
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  private async pollOnce(): Promise<PollResult> {
    const sigs = await this.newSignatures(await this.cursor());
    let events = 0;
    for (let i = 0; i < sigs.length; i += this.concurrency) {
      const chunk = sigs.slice(i, i + this.concurrency);
      const txs = chunk.map((s) => (s.err ? Promise.resolve(null) : this.transaction(s.signature)));
      for (const p of txs) p.catch(() => {}); // rethrown in order below, after earlier ones are committed
      for (const [j, s] of chunk.entries()) events += await this.commit(s, await txs[j]!);
    }
    return { transactions: sigs.length, events };
  }

  private async cursor(): Promise<Cursor> {
    const [row] = await this.db
      .select()
      .from(indexerCursor)
      .where(eq(indexerCursor.network, this.network))
      .limit(1);
    return { lastSignature: row?.lastSignature ?? null, lastSlot: row?.lastSlot ?? null };
  }

  /** Signatures after the cursor, oldest first. Newest-first pages are walked back with `before`. */
  private async newSignatures(cursor: Cursor): Promise<SignatureInfo[]> {
    const until = (cursor.lastSignature ?? undefined) as Signature | undefined;
    const seen = new Set<string>();
    const out: SignatureInfo[] = [];
    let before: Signature | undefined;
    for (;;) {
      const page = await this.rpc
        .getSignaturesForAddress(this.programId, {
          commitment: "confirmed",
          limit: this.pageSize,
          ...(until && { until }),
          ...(before && { before }),
        })
        .send();
      let fresh = 0;
      let reachedCursor = false;
      for (const s of page) {
        // `until` normally stops the walk; the slot check also covers a cursor signature the RPC no longer has.
        if (s.signature === until || (cursor.lastSlot !== null && s.slot < cursor.lastSlot)) {
          reachedCursor = true;
          break;
        }
        if (seen.has(s.signature)) continue; // some RPCs (Surfpool) repeat entries
        seen.add(s.signature);
        out.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime, err: s.err });
        fresh++;
      }
      if (reachedCursor || page.length < this.pageSize || fresh === 0) break;
      before = page.at(-1)!.signature;
    }
    return out.reverse();
  }

  private async transaction(signature: Signature) {
    for (let attempt = 0; ; attempt++) {
      const tx = await this.rpc
        .getTransaction(signature, {
          encoding: "json",
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        })
        .send();
      if (tx) return tx;
      if (attempt >= this.txRetries) throw new Error(`transaction ${signature} not available yet`);
      await sleep(this.txRetryMs * (attempt + 1));
    }
  }

  /** Events of one transaction and the cursor move, atomically. Failed transactions only move the cursor. */
  private async commit(
    s: SignatureInfo,
    tx: Awaited<ReturnType<Indexer["transaction"]>> | null,
  ): Promise<number> {
    let rows: (typeof chainEvents.$inferInsert)[] = [];
    if (tx && !tx.meta?.err) {
      const logs = tx.meta?.logMessages;
      if (!logs) throw new Error(`transaction ${s.signature} has no log messages`);
      if (logs.includes("Log truncated"))
        this.log.error("logs truncated, events may be missing", { signature: s.signature, slot: s.slot });
      const blockTime = tx.blockTime ?? s.blockTime;
      rows = parseProgramEvents(logs, this.programId).map((e, i) => ({
        network: this.network,
        signature: s.signature,
        slot: tx.slot,
        blockTime: blockTime === null ? null : new Date(Number(blockTime) * 1000),
        eventIndex: i,
        name: e.name,
        owner: eventOwner(e.name, e.data),
        data: e.data,
      }));
    }
    const cursor = { lastSignature: s.signature, lastSlot: s.slot, updatedAt: new Date() };
    return this.db.transaction(async (t) => {
      const inserted = rows.length
        ? await t.insert(chainEvents).values(rows).onConflictDoNothing().returning({ id: chainEvents.id })
        : [];
      await t
        .insert(indexerCursor)
        .values({ network: this.network, ...cursor })
        .onConflictDoUpdate({ target: indexerCursor.network, set: cursor });
      return inserted.length;
    });
  }
}
