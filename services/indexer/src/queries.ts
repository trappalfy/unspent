// Read side of chain_events for the app and the /reserve page. Rows come in chain order (slot, then insertion
// order, which the indexer keeps oldest first), so (slot, id) is a stable newest-first sort and pagination key.

import { and, chainEvents, type Db, desc, eq, gte, inArray, sql } from "@unspent/db";
import type { Network } from "@unspent/shared";

export type Settlement = {
  signature: string;
  slot: bigint;
  blockTime: Date | null;
  owner: string;
  /** 32-byte request id, lowercase hex. */
  requestId: string;
  reserved: bigint;
  actual: bigint;
};

export const HISTORY_EVENTS = [
  "CreditsBought",
  "Deposited",
  "Withdrawn",
  "Reserved",
  "Settled",
  "Expired",
  "Redeemed",
  "ReserveCapSet",
] as const;

export type HistoryEventName = (typeof HISTORY_EVENTS)[number];

export type HistoryEvent = {
  /** Pass the last row's id as `before` to get the next page. */
  id: string;
  signature: string;
  slot: bigint;
  blockTime: Date | null;
  eventIndex: number;
  name: HistoryEventName;
  /** Event fields as indexed: amounts as decimal strings, requestId as hex, addresses as base58. */
  data: Record<string, string | boolean>;
};

/** Totals over every indexed event of a network, for cross-checks against Config and the credit mint. */
export type EventTotals = {
  bought: bigint;
  deposited: bigint;
  withdrawn: bigint;
  reserved: bigint;
  settledReserved: bigint;
  settledActual: bigint;
  expired: bigint;
  redeemed: bigint;
  settlements: number;
};

type Data = Record<string, string | boolean>;
const str = (d: Data, k: string) => String(d[k] ?? "");

export async function recentSettlements(db: Db, network: Network, limit = 50): Promise<Settlement[]> {
  const rows = await db
    .select()
    .from(chainEvents)
    .where(and(eq(chainEvents.network, network), eq(chainEvents.name, "Settled")))
    .orderBy(desc(chainEvents.slot), desc(chainEvents.id))
    .limit(limit);
  return rows.map((r) => {
    const d = r.data as Data;
    return {
      signature: r.signature,
      slot: r.slot,
      blockTime: r.blockTime,
      owner: str(d, "owner"),
      requestId: str(d, "requestId"),
      reserved: BigInt(str(d, "reserved")),
      actual: BigInt(str(d, "actual")),
    };
  });
}

/** Requests settled (one Settled event each) since a time, for "requests settled in the last 24h". */
export async function settlementsSince(db: Db, network: Network, since: Date): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(chainEvents)
    .where(
      and(
        eq(chainEvents.network, network),
        eq(chainEvents.name, "Settled"),
        gte(chainEvents.blockTime, since),
      ),
    );
  return Number(r?.n ?? 0);
}

export async function walletHistory(
  db: Db,
  network: Network,
  owner: string,
  opts: { limit?: number; before?: string } = {},
): Promise<HistoryEvent[]> {
  const where = [
    eq(chainEvents.network, network),
    eq(chainEvents.owner, owner),
    inArray(chainEvents.name, [...HISTORY_EVENTS]),
  ];
  if (opts.before !== undefined) {
    if (!/^\d{1,19}$/.test(opts.before)) throw new RangeError("before must be an event id");
    where.push(
      sql`(${chainEvents.slot}, ${chainEvents.id}) < (select b.slot, b.id from chain_events b where b.id = ${BigInt(opts.before)})`,
    );
  }
  const rows = await db
    .select()
    .from(chainEvents)
    .where(and(...where))
    .orderBy(desc(chainEvents.slot), desc(chainEvents.id))
    .limit(opts.limit ?? 50);
  return rows.map((r) => ({
    id: r.id.toString(),
    signature: r.signature,
    slot: r.slot,
    blockTime: r.blockTime,
    eventIndex: r.eventIndex,
    name: r.name as HistoryEventName,
    data: r.data as Data,
  }));
}

// Field names and event names below are constants, never user input.
const sumOf = (name: string, field: string) =>
  sql<string>`${sql.raw(`coalesce(sum((data->>'${field}')::numeric) filter (where name = '${name}'), 0)::text`)}`;

export async function eventTotals(db: Db, network: Network): Promise<EventTotals> {
  const [r] = await db
    .select({
      bought: sumOf("CreditsBought", "amount"),
      deposited: sumOf("Deposited", "amount"),
      withdrawn: sumOf("Withdrawn", "amount"),
      reserved: sumOf("Reserved", "amount"),
      settledReserved: sumOf("Settled", "reserved"),
      settledActual: sumOf("Settled", "actual"),
      expired: sumOf("Expired", "amount"),
      redeemed: sumOf("Redeemed", "amount"),
      settlements: sql<number>`(count(*) filter (where ${chainEvents.name} = 'Settled'))::int`,
    })
    .from(chainEvents)
    .where(eq(chainEvents.network, network));
  if (!r) throw new Error("eventTotals: no row");
  return {
    bought: BigInt(r.bought),
    deposited: BigInt(r.deposited),
    withdrawn: BigInt(r.withdrawn),
    reserved: BigInt(r.reserved),
    settledReserved: BigInt(r.settledReserved),
    settledActual: BigInt(r.settledActual),
    expired: BigInt(r.expired),
    redeemed: BigInt(r.redeemed),
    settlements: Number(r.settlements),
  };
}
