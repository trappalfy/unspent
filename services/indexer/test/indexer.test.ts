// Indexer against an in-memory RPC and PGlite: paging, ordering, failed transactions, idempotency, resume,
// null getTransaction, concurrent polls, the logs subscription, and the read queries.

import { type Address, address } from "@solana/kit";
import { asc, chainEvents, type Db, eq, indexerCursor, openPglite } from "@unspent/db";
import {
  ConfigField,
  getCreditsBoughtEventEncoder,
  getDepositedEventEncoder,
  getExpiredEventEncoder,
  getLimitChangedEventEncoder,
  getRedeemedEventEncoder,
  getReservedEventEncoder,
  getSettledEventEncoder,
  getWithdrawnEventEncoder,
} from "@unspent/program";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Indexer, type IndexerOptions, type IndexerSubscriptions } from "../src/indexer";
import { createLogger } from "../src/log";
import { eventTotals, recentSettlements, settlementsSince, walletHistory } from "../src/queries";
import { FakeRpc } from "./fakeRpc";
import { ALICE, BOB, data, hexOf, invocation, JUPITER, ours, requestId } from "./logs";

const alice = address(ALICE);
const bob = address(BOB);
const deposited = (amount: bigint, owner: Address = alice) =>
  getDepositedEventEncoder().encode({ owner, amount });

let db: Db;
let close: () => Promise<void>;
let logs: string[];

beforeEach(async () => {
  ({ db, close } = await openPglite());
  logs = [];
});
afterEach(async () => {
  await close();
});

const indexer = (rpc: FakeRpc, o: Partial<IndexerOptions> = {}) =>
  new Indexer({
    db,
    rpc: rpc.asRpc(),
    network: "localnet",
    log: createLogger((l) => logs.push(l)),
    pageSize: 10,
    txRetryMs: 1,
    ...o,
  });

const rows = () => db.select().from(chainEvents).orderBy(asc(chainEvents.id));
const cursor = async () => (await db.select().from(indexerCursor))[0];

describe("Indexer.poll", () => {
  it("pages back through more than a page of signatures and indexes oldest first", async () => {
    const rpc = new FakeRpc();
    for (let i = 0; i < 25; i++) rpc.add([deposited(BigInt(i))], { sameSlot: i % 4 === 1 });
    expect(await indexer(rpc).poll()).toEqual({ transactions: 25, events: 25 });
    expect(rpc.calls.signatures).toBe(3);
    const r = await rows();
    expect(r.map((x) => (x.data as { amount: string }).amount)).toEqual(
      Array.from({ length: 25 }, (_, i) => `${i}`),
    );
    expect(r.map((x) => x.signature)).toEqual(rpc.txs.map((t) => t.signature));
    expect(r[0]).toMatchObject({
      network: "localnet",
      name: "Deposited",
      owner: ALICE,
      eventIndex: 0,
      slot: rpc.txs[0]!.slot,
    });
    expect(r[0]!.blockTime?.getTime()).toBe(Number(rpc.txs[0]!.blockTime) * 1000);
    expect(await cursor()).toMatchObject({
      lastSignature: rpc.txs[24]!.signature,
      lastSlot: rpc.txs[24]!.slot,
    });
  });

  it("walks past 1000 signatures with the default page size", async () => {
    const rpc = new FakeRpc();
    for (let i = 0; i < 1003; i++) rpc.add([], { err: { InstructionError: [0, { Custom: 1 }] } });
    rpc.add([deposited(7n)]);
    expect(await indexer(rpc, { pageSize: undefined }).poll()).toEqual({ transactions: 1004, events: 1 });
    expect(rpc.calls.signatures).toBe(2);
  }, 30_000);

  it("skips failed transactions but moves the cursor past them", async () => {
    const rpc = new FakeRpc();
    rpc.add([deposited(1n)]);
    const failed = rpc.add([deposited(2n)], { err: { InstructionError: [0, { Custom: 6001 }] } });
    expect(await indexer(rpc).poll()).toEqual({ transactions: 2, events: 1 });
    expect(rpc.calls.transaction).toBe(1);
    expect((await rows()).map((x) => (x.data as { amount: string }).amount)).toEqual(["1"]);
    expect((await cursor())?.lastSignature).toBe(failed);
  });

  it("stores several events of one transaction with their index and ignores other programs' data", async () => {
    const rid = requestId(1);
    const settled = getSettledEventEncoder().encode({
      owner: alice,
      requestId: rid,
      reserved: 5n,
      actual: 2n,
    });
    const rpc = new FakeRpc();
    rpc.add([], {
      logs: [
        ...invocation(JUPITER, 1, [data(settled)]),
        ...ours(getCreditsBoughtEventEncoder().encode({ buyer: alice, amount: 10n }), deposited(10n)),
        ...ours(settled),
      ],
    });
    await indexer(rpc).poll();
    expect((await rows()).map((r) => [r.eventIndex, r.name, r.owner])).toEqual([
      [0, "CreditsBought", ALICE],
      [1, "Deposited", ALICE],
      [2, "Settled", ALICE],
    ]);
  });

  it("is idempotent: a second poll and a re-index from scratch add nothing", async () => {
    const rpc = new FakeRpc();
    for (let i = 0; i < 12; i++) rpc.add([deposited(1n), deposited(2n)]);
    const ix = indexer(rpc);
    expect((await ix.poll()).events).toBe(24);
    expect(await ix.poll()).toEqual({ transactions: 0, events: 0 });
    await db.delete(indexerCursor);
    expect(await ix.poll()).toEqual({ transactions: 12, events: 0 });
    expect(await rows()).toHaveLength(24);
  });

  it("resumes from the cursor after a restart", async () => {
    const rpc = new FakeRpc();
    for (let i = 0; i < 5; i++) rpc.add([deposited(BigInt(i))]);
    await indexer(rpc).poll();
    for (let i = 5; i < 8; i++) rpc.add([deposited(BigInt(i))]);
    rpc.calls.transaction = 0;
    const spy = vi.spyOn(rpc, "getSignaturesForAddress");
    expect(await indexer(rpc).poll()).toEqual({ transactions: 3, events: 3 });
    expect(rpc.calls.transaction).toBe(3);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ until: rpc.txs[4]!.signature, commitment: "confirmed" });
    expect((await rows()).map((x) => (x.data as { amount: string }).amount)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
    ]);
  });

  it("retries a transaction the RPC doesn't return yet, and stops at it if it never comes", async () => {
    const rpc = new FakeRpc();
    const a = rpc.add([deposited(1n)]);
    const b = rpc.add([deposited(2n)]);
    rpc.add([deposited(3n)]);
    rpc.nulls.set(a, 2);
    rpc.nulls.set(b, 100);
    const ix = indexer(rpc, { txRetries: 3 });
    await expect(ix.poll()).rejects.toThrow(`transaction ${b} not available`);
    expect((await cursor())?.lastSignature).toBe(a);
    expect(await rows()).toHaveLength(1);
    rpc.nulls.clear();
    expect(await ix.poll()).toEqual({ transactions: 2, events: 2 });
    expect(await rows()).toHaveLength(3);
  });

  it("serves a poll requested mid-run with one extra pass", async () => {
    const rpc = new FakeRpc();
    for (let i = 0; i < 3; i++) rpc.add([deposited(1n)]);
    const ix = indexer(rpc);
    const first = ix.poll();
    const second = ix.poll();
    const third = ix.poll();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(await first).toEqual({ transactions: 3, events: 3 });
    expect(rpc.calls.signatures).toBe(2);
    expect(await rows()).toHaveLength(3);
  });
});

/** Logs subscription whose notifications and failures the test drives. */
class FakeSubscriptions {
  subscribed = 0;
  private next: (() => void) | null = null;
  private fail: ((e: Error) => void) | null = null;
  notify() {
    this.next?.();
  }
  drop() {
    this.fail?.(new Error("socket closed"));
  }
  logsNotifications() {
    return {
      subscribe: async ({ abortSignal }: { abortSignal: AbortSignal }) => {
        this.subscribed++;
        const self = this;
        return (async function* () {
          while (!abortSignal.aborted) {
            await new Promise<void>((resolve, reject) => {
              self.next = resolve;
              self.fail = reject;
              abortSignal.addEventListener("abort", () => resolve(), { once: true });
            });
            yield {};
          }
        })();
      },
    };
  }
}

describe("Indexer.start", () => {
  it("polls on start and on notifications, and resubscribes after a drop", async () => {
    const rpc = new FakeRpc();
    rpc.add([deposited(1n)]);
    const subs = new FakeSubscriptions();
    const ix = indexer(rpc, {
      rpcSubscriptions: subs as unknown as IndexerSubscriptions,
      backfillMs: 60_000,
      debounceMs: 5,
      reconnectMs: 10,
    });
    ix.start();
    await vi.waitFor(async () => expect(await rows()).toHaveLength(1));
    await vi.waitFor(() => expect(subs.subscribed).toBe(1));

    rpc.add([deposited(2n)]);
    subs.notify();
    await vi.waitFor(async () => expect(await rows()).toHaveLength(2));

    subs.drop();
    await vi.waitFor(() => expect(subs.subscribed).toBe(2));
    rpc.add([deposited(3n)]);
    subs.notify();
    await vi.waitFor(async () => expect(await rows()).toHaveLength(3));
    await ix.stop();
    expect(logs.some((l) => l.includes("logs subscription dropped"))).toBe(true);
  });

  it("falls back to interval polling without a subscription", async () => {
    const rpc = new FakeRpc();
    const ix = indexer(rpc, { backfillMs: 20 });
    ix.start();
    rpc.add([deposited(1n)]);
    await vi.waitFor(async () => expect(await rows()).toHaveLength(1));
    await ix.stop();
  });
});

describe("queries", () => {
  it("serve history, settlements and totals", async () => {
    const rpc = new FakeRpc();
    const [r1, r2, r3] = [requestId(1), requestId(2), requestId(3)];
    rpc.add([getCreditsBoughtEventEncoder().encode({ buyer: alice, amount: 100n }), deposited(60n)]);
    rpc.add([getCreditsBoughtEventEncoder().encode({ buyer: bob, amount: 50n }), deposited(50n, bob)]);
    rpc.add([getReservedEventEncoder().encode({ owner: alice, requestId: r1, amount: 20n, expiresAt: 1n })]);
    rpc.add([getReservedEventEncoder().encode({ owner: bob, requestId: r2, amount: 10n, expiresAt: 1n })]);
    rpc.add([getReservedEventEncoder().encode({ owner: alice, requestId: r3, amount: 5n, expiresAt: 1n })]);
    rpc.add([
      getSettledEventEncoder().encode({ owner: alice, requestId: r1, reserved: 20n, actual: 7n }),
      getSettledEventEncoder().encode({ owner: bob, requestId: r2, reserved: 10n, actual: 10n }),
    ]);
    rpc.add([getExpiredEventEncoder().encode({ owner: alice, requestId: r3, amount: 5n })]);
    rpc.add([getLimitChangedEventEncoder().encode({ field: ConfigField.SupplyCap, value: 1n })]);
    rpc.add([getWithdrawnEventEncoder().encode({ owner: alice, amount: 53n })]);
    rpc.add([getRedeemedEventEncoder().encode({ owner: alice, amount: 40n })]);
    await indexer(rpc).poll();

    const hist = await walletHistory(db, "localnet", ALICE);
    expect(hist.map((h) => h.name)).toEqual([
      "Redeemed",
      "Withdrawn",
      "Expired",
      "Settled",
      "Reserved",
      "Reserved",
      "Deposited",
      "CreditsBought",
    ]);
    expect(hist[3]!.data).toEqual({ owner: ALICE, requestId: hexOf(r1), reserved: "20", actual: "7" });
    const page1 = await walletHistory(db, "localnet", ALICE, { limit: 3 });
    const page2 = await walletHistory(db, "localnet", ALICE, { limit: 3, before: page1.at(-1)!.id });
    const page3 = await walletHistory(db, "localnet", ALICE, { limit: 3, before: page2.at(-1)!.id });
    expect([...page1, ...page2, ...page3].map((h) => h.id)).toEqual(hist.map((h) => h.id));
    expect(await walletHistory(db, "devnet", ALICE)).toEqual([]);
    await expect(walletHistory(db, "localnet", ALICE, { before: "1; drop table x" })).rejects.toThrow(
      RangeError,
    );

    const settlements = await recentSettlements(db, "localnet", 10);
    expect(settlements).toEqual([
      expect.objectContaining({ owner: BOB, requestId: hexOf(r2), reserved: 10n, actual: 10n }),
      expect.objectContaining({ owner: ALICE, requestId: hexOf(r1), reserved: 20n, actual: 7n }),
    ]);
    expect(settlements[0]!.signature).toBe(rpc.txs[5]!.signature);
    expect(await recentSettlements(db, "localnet", 1)).toHaveLength(1);
    expect(await settlementsSince(db, "localnet", new Date(0))).toBe(2);
    expect(await settlementsSince(db, "localnet", new Date(Date.now() + 86_400_000 * 365 * 100))).toBe(0);

    expect(await eventTotals(db, "localnet")).toEqual({
      bought: 150n,
      deposited: 110n,
      withdrawn: 53n,
      reserved: 35n,
      settledReserved: 30n,
      settledActual: 17n,
      expired: 5n,
      redeemed: 40n,
      settlements: 2,
    });
    expect((await eventTotals(db, "mainnet")).bought).toBe(0n);
    const [limit] = await db.select().from(chainEvents).where(eq(chainEvents.name, "LimitChanged"));
    expect(limit).toMatchObject({ owner: null, data: { field: "SupplyCap", value: "1" } });
  });
});
