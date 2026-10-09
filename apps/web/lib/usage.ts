// Request history for /app and /app/usage (brief 10.1): one row per request from the gateway's `requests` table,
// scoped to the signed-in wallet. Only billing metadata exists there; request bodies are never stored.

import { and, apiKeys, type Db, desc, eq, gte, inArray, lt, or, requests, sql } from "@unspent/db";
import { type Network, ucrToCredits } from "@unspent/shared";

export type UsageFilter = { keyId?: string; model?: string; from?: Date; to?: Date };

export type UsageRow = {
  id: string;
  createdAt: Date;
  keyName: string;
  keyLast4: string;
  model: string;
  endpoint: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  webSearches: number | null;
  reservedUcr: bigint;
  chargedUcr: bigint | null;
  estimated: boolean;
  ccSessionId: string | null;
  reserveSig: string | null;
  settleSig: string | null;
};

/** What the user sees per status: their money only moves on `settled`. */
export const STATUS_LABEL: Record<string, string> = {
  reserving: "running",
  reserved: "running",
  dispatched: "running",
  completed: "settling",
  settled: "settled",
  released: "released",
  reserve_timeout: "not sent",
  expired: "free",
  unknown: "free",
};

export const PAGE_SIZE = 50;

function where(wallet: string, network: Network, f: UsageFilter) {
  return and(
    eq(requests.wallet, wallet),
    eq(requests.network, network),
    f.keyId ? eq(requests.apiKeyId, f.keyId) : undefined,
    f.model ? eq(requests.model, f.model) : undefined,
    f.from ? gte(requests.createdAt, f.from) : undefined,
    f.to ? lt(requests.createdAt, f.to) : undefined,
  );
}

export async function usageRows(
  db: Db,
  wallet: string,
  network: Network,
  f: UsageFilter,
  page: { limit?: number; before?: { createdAt: Date; id: string } } = {},
): Promise<UsageRow[]> {
  const b = page.before;
  const rows = await db
    .select({ r: requests, keyName: apiKeys.name, keyLast4: apiKeys.last4 })
    .from(requests)
    .innerJoin(apiKeys, eq(apiKeys.id, requests.apiKeyId))
    .where(
      and(
        where(wallet, network, f),
        b
          ? or(
              lt(requests.createdAt, b.createdAt),
              and(eq(requests.createdAt, b.createdAt), lt(requests.id, b.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(requests.createdAt), desc(requests.id))
    .limit(page.limit ?? PAGE_SIZE);
  return rows.map(({ r, keyName, keyLast4 }) => ({
    id: r.id,
    createdAt: r.createdAt,
    keyName,
    keyLast4,
    model: r.model,
    endpoint: r.endpoint,
    status: r.status,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens:
      r.cacheWrite5mTokens === null && r.cacheWrite1hTokens === null
        ? null
        : (r.cacheWrite5mTokens ?? 0) + (r.cacheWrite1hTokens ?? 0),
    webSearches: r.webSearchRequests,
    reservedUcr: r.reservedUcr,
    chargedUcr: r.chargedUcr,
    estimated: r.estimated,
    ccSessionId: r.ccSessionId,
    reserveSig: r.reserveSig,
    settleSig: r.settleSig,
  }));
}

const CHARGED = ["completed", "settled"] as const;

/** Spend per UTC day and model over the last `days` days (settled + settling). */
export async function spendByDay(
  db: Db,
  wallet: string,
  network: Network,
  days = 30,
  now = new Date(),
): Promise<{ day: string; model: string; ucr: bigint }[]> {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
  const day = sql<string>`to_char(${requests.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await db
    .select({ day, model: requests.model, ucr: sql<string>`coalesce(sum(${requests.chargedUcr}), 0)` })
    .from(requests)
    .where(
      and(
        eq(requests.wallet, wallet),
        eq(requests.network, network),
        gte(requests.createdAt, since),
        inArray(requests.status, [...CHARGED]),
      ),
    )
    .groupBy(day, requests.model)
    .orderBy(day);
  return rows.map((r) => ({ day: r.day, model: r.model, ucr: BigInt(r.ucr) }));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const CSV_HEADER = [
  "time_utc",
  "key",
  "model",
  "endpoint",
  "status",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "web_searches",
  "reserved_credits",
  "charged_credits",
  "estimated",
  "claude_code_session",
  "reserve_tx",
  "settle_tx",
];

export function toCsvLine(r: UsageRow): string {
  return [
    r.createdAt.toISOString(),
    `${r.keyName} …${r.keyLast4}`,
    r.model,
    r.endpoint,
    STATUS_LABEL[r.status] ?? r.status,
    r.inputTokens,
    r.outputTokens,
    r.cacheReadTokens,
    r.cacheWriteTokens,
    r.webSearches,
    ucrToCredits(r.reservedUcr),
    r.chargedUcr === null ? "" : ucrToCredits(r.chargedUcr),
    r.estimated,
    r.ccSessionId,
    r.reserveSig,
    r.settleSig,
  ]
    .map(csvCell)
    .join(",");
}
