// Postgres schema (brief 9.2). Amounts: μcr in bigint, pUSD in numeric(39,0).
// No request or response bodies are ever stored here (brief rule 0.9, 8.11).

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (v) => Buffer.from(v),
  fromDriver: (v) => new Uint8Array(v),
});

const ucr = (name: string) => bigint(name, { mode: "bigint" });
const pusd = (name: string) => numeric(name, { precision: 39, scale: 0 });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const network = pgEnum("network", ["localnet", "devnet", "mainnet"]);

export const wallets = pgTable("wallets", {
  address: text("address").primaryKey(),
  blocked: boolean("blocked").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at"),
});

export const apiKeyStatus = pgEnum("api_key_status", ["active", "revoked"]);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Snapshot of the wallet the key was issued to; reservations only ever come from this wallet (brief 8.3).
    wallet: text("wallet")
      .notNull()
      .references(() => wallets.address),
    network: network("network").notNull(),
    name: text("name").notNull(),
    keyHash: bytea("key_hash").notNull(),
    last4: text("last4").notNull(),
    dailyLimitUcr: ucr("daily_limit_ucr"),
    allowedModels: text("allowed_models").array(),
    status: apiKeyStatus("status").notNull().default("active"),
    createdAt: ts("created_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
    lastUsedAt: ts("last_used_at"),
  },
  (t) => [uniqueIndex("api_keys_hash_uq").on(t.keyHash), index("api_keys_wallet_idx").on(t.wallet)],
);

export const requestStatus = pgEnum("request_status", [
  "reserving",
  "reserved",
  "dispatched",
  "completed",
  "settled",
  "reserve_timeout",
  "released",
  "expired",
  "unknown",
]);

export const requests = pgTable(
  "requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 32 random bytes, the onchain Reservation seed; never reused (brief 6.5).
    requestId: bytea("request_id").notNull(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id),
    wallet: text("wallet").notNull(),
    network: network("network").notNull(),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    endpoint: text("endpoint").notNull(),
    status: requestStatus("status").notNull(),
    reservedUcr: ucr("reserved_ucr").notNull(),
    // Prices fixed at reservation time, pUSD per token, as decimal strings.
    prices: jsonb("prices").$type<Record<string, string>>().notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWrite5mTokens: integer("cache_write_5m_tokens"),
    cacheWrite1hTokens: integer("cache_write_1h_tokens"),
    webSearchRequests: integer("web_search_requests"),
    costPusd: pusd("cost_pusd"),
    costUcr: ucr("cost_ucr"),
    chargedUcr: ucr("charged_ucr"),
    estimated: boolean("estimated").notNull().default(false),
    reserveSig: text("reserve_sig"),
    reserveLastValidBlockHeight: bigint("reserve_last_valid_block_height", { mode: "bigint" }),
    settleSig: text("settle_sig"),
    providerRequestId: text("provider_request_id"),
    ccSessionId: text("cc_session_id"),
    ccAgentId: text("cc_agent_id"),
    httpStatus: integer("http_status"),
    errorCode: text("error_code"),
    createdAt: ts("created_at").notNull().defaultNow(),
    dispatchedAt: ts("dispatched_at"),
    lastProgressAt: ts("last_progress_at"),
    completedAt: ts("completed_at"),
    settledAt: ts("settled_at"),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    uniqueIndex("requests_request_id_uq").on(t.requestId),
    index("requests_wallet_created_idx").on(t.wallet, t.createdAt),
    index("requests_key_created_idx").on(t.apiKeyId, t.createdAt),
    index("requests_open_idx")
      .on(t.status)
      .where(sql`status in ('reserving','reserved','dispatched','completed','reserve_timeout')`),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    wallet: text("wallet").notNull(),
    keyHash: bytea("key_hash").notNull(),
    bodyHash: bytea("body_hash").notNull(),
    requestUuid: uuid("request_uuid").references(() => requests.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.keyHash] }), index("idempotency_expires_idx").on(t.expiresAt)],
);

export const settleStatus = pgEnum("settle_status", ["pending", "sent", "confirmed", "skipped_expired"]);

export const settleQueue = pgTable(
  "settle_queue",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    requestUuid: uuid("request_uuid")
      .notNull()
      .references(() => requests.id),
    requestId: bytea("request_id").notNull(),
    owner: text("owner").notNull(),
    actualUcr: ucr("actual_ucr").notNull(),
    status: settleStatus("status").notNull().default("pending"),
    txSig: text("tx_sig"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("settle_queue_request_uq").on(t.requestUuid),
    index("settle_queue_pending_idx").on(t.status, t.id),
  ],
);

export const chainEvents = pgTable(
  "chain_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    network: network("network").notNull(),
    signature: text("signature").notNull(),
    slot: bigint("slot", { mode: "bigint" }).notNull(),
    blockTime: ts("block_time"),
    eventIndex: integer("event_index").notNull(),
    name: text("name").notNull(),
    owner: text("owner"),
    data: jsonb("data").notNull(),
  },
  (t) => [
    uniqueIndex("chain_events_sig_idx_uq").on(t.network, t.signature, t.eventIndex),
    index("chain_events_owner_idx").on(t.owner, t.slot),
    index("chain_events_name_idx").on(t.name, t.slot),
  ],
);

export const indexerCursor = pgTable("indexer_cursor", {
  network: network("network").primaryKey(),
  lastSignature: text("last_signature"),
  lastSlot: bigint("last_slot", { mode: "bigint" }),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const reconciliation = pgTable(
  "reconciliation",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    day: date("day").notNull(),
    provider: text("provider").notNull(),
    dbCostPusd: pusd("db_cost_pusd").notNull(),
    providerCostPusd: pusd("provider_cost_pusd"),
    diffBps: integer("diff_bps"),
    details: jsonb("details"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("reconciliation_day_provider_uq").on(t.day, t.provider)],
);
