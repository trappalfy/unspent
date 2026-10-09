// Anchor events from transaction logs (`emit!` → "Program data: <base64>", 8-byte discriminator + borsh).
// Only data logged while this program is the innermost running invocation counts: other programs in the same
// transaction (a swap, a wrapper calling us by CPI) can log `Program data:` lines of their own.

import { type Address, type Decoder, getBase16Decoder, getBase64Encoder } from "@solana/kit";
import {
  BACKUP_GATEWAY_ACTIVATED_EVENT_DISCRIMINATOR,
  CHANGE_APPLIED_EVENT_DISCRIMINATOR,
  CHANGE_CANCELLED_EVENT_DISCRIMINATOR,
  CHANGE_PROPOSED_EVENT_DISCRIMINATOR,
  CREDITS_BOUGHT_EVENT_DISCRIMINATOR,
  DEPOSITED_EVENT_DISCRIMINATOR,
  EXPIRED_EVENT_DISCRIMINATOR,
  GATEWAY_REVOKED_EVENT_DISCRIMINATOR,
  getBackupGatewayActivatedEventDecoder,
  getChangeAppliedEventDecoder,
  getChangeCancelledEventDecoder,
  getChangeProposedEventDecoder,
  getCreditsBoughtEventDecoder,
  getDepositedEventDecoder,
  getExpiredEventDecoder,
  getGatewayRevokedEventDecoder,
  getLimitChangedEventDecoder,
  getPauseSetEventDecoder,
  getRedeemedEventDecoder,
  getReserveCapSetEventDecoder,
  getReservedEventDecoder,
  getSettledEventDecoder,
  getShutDownEventDecoder,
  getSurplusSweptEventDecoder,
  getWithdrawnEventDecoder,
  LIMIT_CHANGED_EVENT_DISCRIMINATOR,
  PAUSE_SET_EVENT_DISCRIMINATOR,
  REDEEMED_EVENT_DISCRIMINATOR,
  RESERVE_CAP_SET_EVENT_DISCRIMINATOR,
  RESERVED_EVENT_DISCRIMINATOR,
  SETTLED_EVENT_DISCRIMINATOR,
  SHUT_DOWN_EVENT_DISCRIMINATOR,
  SURPLUS_SWEPT_EVENT_DISCRIMINATOR,
  UNSPENT_PROGRAM_ADDRESS,
  WITHDRAWN_EVENT_DISCRIMINATOR,
} from "./generated";
import { ConfigField, PauseTarget } from "./generated/types";

const hex = getBase16Decoder();
const base64 = getBase64Encoder();

// [name as in Rust, discriminator, decoder of the full payload (the decoders consume the discriminator)]
const TABLE = [
  ["CreditsBought", CREDITS_BOUGHT_EVENT_DISCRIMINATOR, getCreditsBoughtEventDecoder()],
  ["Deposited", DEPOSITED_EVENT_DISCRIMINATOR, getDepositedEventDecoder()],
  ["Withdrawn", WITHDRAWN_EVENT_DISCRIMINATOR, getWithdrawnEventDecoder()],
  ["ReserveCapSet", RESERVE_CAP_SET_EVENT_DISCRIMINATOR, getReserveCapSetEventDecoder()],
  ["Reserved", RESERVED_EVENT_DISCRIMINATOR, getReservedEventDecoder()],
  ["Settled", SETTLED_EVENT_DISCRIMINATOR, getSettledEventDecoder()],
  ["Expired", EXPIRED_EVENT_DISCRIMINATOR, getExpiredEventDecoder()],
  ["Redeemed", REDEEMED_EVENT_DISCRIMINATOR, getRedeemedEventDecoder()],
  ["ShutDown", SHUT_DOWN_EVENT_DISCRIMINATOR, getShutDownEventDecoder()],
  ["SurplusSwept", SURPLUS_SWEPT_EVENT_DISCRIMINATOR, getSurplusSweptEventDecoder()],
  ["LimitChanged", LIMIT_CHANGED_EVENT_DISCRIMINATOR, getLimitChangedEventDecoder()],
  ["PauseSet", PAUSE_SET_EVENT_DISCRIMINATOR, getPauseSetEventDecoder()],
  ["ChangeProposed", CHANGE_PROPOSED_EVENT_DISCRIMINATOR, getChangeProposedEventDecoder()],
  ["ChangeApplied", CHANGE_APPLIED_EVENT_DISCRIMINATOR, getChangeAppliedEventDecoder()],
  ["ChangeCancelled", CHANGE_CANCELLED_EVENT_DISCRIMINATOR, getChangeCancelledEventDecoder()],
  ["GatewayRevoked", GATEWAY_REVOKED_EVENT_DISCRIMINATOR, getGatewayRevokedEventDecoder()],
  [
    "BackupGatewayActivated",
    BACKUP_GATEWAY_ACTIVATED_EVENT_DISCRIMINATOR,
    getBackupGatewayActivatedEventDecoder(),
  ],
] as const;

export type ProgramEventName = (typeof TABLE)[number][0];
export const PROGRAM_EVENT_NAMES: readonly ProgramEventName[] = TABLE.map(([name]) => name);

/** JSON-safe event fields: u64/i64 as decimal strings, byte arrays as lowercase hex, enums by variant name. */
export type ProgramEvent = { name: ProgramEventName; data: Record<string, string | boolean> };

const BY_DISCRIMINATOR = new Map<string, { name: ProgramEventName; decoder: Decoder<object> }>(
  TABLE.map(([name, disc, decoder]) => [hex.decode(disc), { name, decoder: decoder as Decoder<object> }]),
);

// Numeric Codama enums → variant names (TS numeric enums carry the reverse mapping).
const ENUM_FIELDS: Record<string, Record<number, string>> = {
  field: ConfigField as unknown as Record<number, string>,
  target: PauseTarget as unknown as Record<number, string>,
};

function toJson(name: string, decoded: object): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [key, v] of Object.entries(decoded)) {
    if (typeof v === "bigint") out[key] = v.toString();
    else if (v instanceof Uint8Array) out[key] = hex.decode(v);
    else if (typeof v === "string" || typeof v === "boolean") out[key] = v;
    else if (typeof v === "number" && ENUM_FIELDS[key]?.[v] !== undefined) out[key] = ENUM_FIELDS[key][v];
    else throw new Error(`${name}.${key}: unexpected decoded value ${String(v)}`);
  }
  return out;
}

// Program ids are base58, so "Program log: failed ..." can't pass for an exit line.
const INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[\d+\]$/;
const EXIT = /^Program [1-9A-HJ-NP-Za-km-z]{32,44} (?:success$|failed)/;
const DATA = "Program data: ";

/** Decodes the program's events from a transaction's log messages, in emission order. */
export function parseProgramEvents(
  logs: readonly string[],
  programId: Address | string = UNSPENT_PROGRAM_ADDRESS,
): ProgramEvent[] {
  const stack: string[] = [];
  const events: ProgramEvent[] = [];
  for (const line of logs) {
    const invoke = INVOKE.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (EXIT.test(line)) {
      stack.pop();
      continue;
    }
    if (!line.startsWith(DATA) || stack.at(-1) !== programId) continue;
    // sol_log_data logs each slice as its own base64 word; Anchor's emit! passes exactly one.
    const bytes = base64.encode(line.slice(DATA.length).split(" ")[0]!);
    if (bytes.length < 8) continue;
    const entry = BY_DISCRIMINATOR.get(hex.decode(bytes.subarray(0, 8)));
    if (!entry) continue;
    events.push({ name: entry.name, data: toJson(entry.name, entry.decoder.decode(bytes)) });
  }
  return events;
}

/** The wallet an event belongs to: `owner`, or `buyer` for CreditsBought; null for protocol-wide events. */
export function eventOwner(name: string, data: Record<string, unknown>): string | null {
  const v = name === "CreditsBought" ? data.buyer : data.owner;
  return typeof v === "string" ? v : null;
}
