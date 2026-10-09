// Business constants. Values marked Qn are the owner-approved proposals from brief section 17
// (approved 2026-10-09); deploy-time parameters can be overridden by the services' config.

/** Q2: Unspent price = provider price × (1 + MARKUP_BPS / 10 000). */
export const MARKUP_BPS = 1500;

/** Q20: minimum charge per request, μcr (0.001 credit). Also charged for provider errors caused by the request. */
export const MIN_CHARGE_UCR = 1_000n;

/** Q19: web search hold when `max_uses` is not set, and result tokens held per search. */
export const WEB_SEARCH_HOLD_USES = 5;
export const WEB_SEARCH_RESULT_TOKENS = 20_000;

/** Reservation input estimate: bytes of text per token (brief 5.5 step 2). */
export const INPUT_BYTES_PER_TOKEN = 3;

/** A tiered model is reserved at the next tier once the estimate exceeds 70% of the tier limit (Haiku: 70 000 of 100 000). */
export const RESERVE_TIER_HEADROOM_BPS = 7_000;

/** Output estimate for streams cut by the provider: characters of all deltas / 3.5 (brief 5.5 step 8). */
export const OUTPUT_CHARS_PER_TOKEN_NUM = 7;
export const OUTPUT_CHARS_PER_TOKEN_DEN = 2;

/** Default output cap for /v1/chat/completions when the client sets none (brief 8.8). */
export const DEFAULT_MAX_TOKENS = 4096;

/** Settlement batch size for settle_many on v0 transactions (stage 1 recon: up to 12 fit; 10 keeps headroom). */
export const SETTLE_BATCH = 10;

/** Program limits at launch (Q7, Q16, Q17), μcr and seconds. The program's Config is the source of truth onchain. */
export const PROGRAM_DEFAULTS = {
  maxBuyPerIxUcr: 100_000n * 1_000_000n,
  supplyCapUcr: 250_000n * 1_000_000n,
  maxReservationUcr: 25n * 1_000_000n,
  maxReservedPerUserUcr: 50n * 1_000_000n,
  burnCapPerWindowUcr: 5_000n * 1_000_000n,
  reservationTtlSec: 3_600,
  adminDelaySec: 48 * 3_600,
} as const;

/** MAX_REQUEST_DURATION = reservation_ttl − 10 min (brief 5.5 step 4). */
export function maxRequestDurationSec(reservationTtlSec: number): number {
  return reservationTtlSec - 600;
}

/** Q15: default rate limits per key and per wallet (sum over its keys). */
export const RATE_LIMITS = {
  requestsPerMinute: 120,
  concurrent: 10,
  maxKeysPerWallet: 20,
} as const;
