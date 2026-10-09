// The single implementation of request cost and reservation math (brief 4.2, 5.2, 5.5).
// The gateway and the site compute only through these functions.

import {
  INPUT_BYTES_PER_TOKEN,
  MARKUP_BPS,
  MIN_CHARGE_UCR,
  OUTPUT_CHARS_PER_TOKEN_DEN,
  OUTPUT_CHARS_PER_TOKEN_NUM,
  RESERVE_TIER_HEADROOM_BPS,
  WEB_SEARCH_HOLD_USES,
  WEB_SEARCH_RESULT_TOKENS,
} from "./constants";
import type { ModelEntry, PriceTier, TokenPrices } from "./models";
import { BPS_DENOMINATOR, ceilDiv, decimalString, maxBig, minBig, PUSD_PER_UCR } from "./units";

export type PricingOptions = {
  markupBps?: number;
  minChargeUcr?: bigint;
};

/** Metered usage of one request, normalized from the provider's usage object. */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  /** Total cache write tokens. */
  cacheCreationInputTokens: number;
  /** Breakdown of cacheCreationInputTokens by TTL; any remainder not covered is priced as 5m writes. */
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
  webSearchRequests?: number;
};

function big(n: number, what: string): bigint {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(`${what} must be a non-negative integer, got ${n}`);
  return BigInt(n);
}

/** Prompt length for tier selection: input + cache read + cache write (brief 5.2, Haiku 5.5 rule). */
export function promptTokens(u: Usage): number {
  return u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
}

export function tierFor(model: ModelEntry, prompt: number): PriceTier {
  const tier = model.tiers.find((t) => t.maxPromptTokens === null || prompt <= t.maxPromptTokens);
  if (!tier) throw new Error(`Model ${model.id} has no tier for ${prompt} prompt tokens`);
  return tier;
}

/** Provider cost before markup, pUSD. */
export function costPusd(model: ModelEntry, u: Usage): bigint {
  const p = tierFor(model, promptTokens(u)).prices;
  const w5m = big(u.cacheCreation5mInputTokens ?? 0, "cacheCreation5mInputTokens");
  const w1h = big(u.cacheCreation1hInputTokens ?? 0, "cacheCreation1hInputTokens");
  const wTotal = big(u.cacheCreationInputTokens, "cacheCreationInputTokens");
  if (w5m + w1h > wTotal) throw new RangeError("cache write breakdown exceeds cacheCreationInputTokens");
  const searches = big(u.webSearchRequests ?? 0, "webSearchRequests");
  if (searches > 0n && model.webSearchPusd === undefined)
    throw new Error(`Model ${model.id} has no web search price`);
  return (
    big(u.inputTokens, "inputTokens") * p.input +
    big(u.outputTokens, "outputTokens") * p.output +
    big(u.cacheReadInputTokens, "cacheReadInputTokens") * p.cacheRead +
    (wTotal - w1h) * p.cacheWrite5m +
    w1h * p.cacheWrite1h +
    searches * (model.webSearchPusd ?? 0n)
  );
}

/** cost_μcr = ceil(cost_pUSD × (10 000 + MARKUP_BPS) / (10 000 × 10^6)). */
export function applyMarkup(pusd: bigint, markupBps: number = MARKUP_BPS): bigint {
  return ceilDiv(pusd * (BPS_DENOMINATOR + BigInt(markupBps)), BPS_DENOMINATOR * PUSD_PER_UCR);
}

/** What the user owes for metered usage: marked-up cost, at least MIN_CHARGE. Not yet capped by the reservation. */
export function chargeUcr(model: ModelEntry, u: Usage, opts: PricingOptions = {}): bigint {
  return maxBig(applyMarkup(costPusd(model, u), opts.markupBps), opts.minChargeUcr ?? MIN_CHARGE_UCR);
}

/** settle(min(cost, reserved)): the user is never charged more than the reservation (brief 5.5 step 7). */
export function settleAmount(chargedUcr: bigint, reservedUcr: bigint): bigint {
  return minBig(chargedUcr, reservedUcr);
}

/** Text input estimate: min(ceil(bytes / 3), context window). */
export function estimateInputTokens(textBytes: number, contextWindow: number): number {
  return Math.min(Math.ceil(textBytes / INPUT_BYTES_PER_TOKEN), contextWindow);
}

/** Output estimate for a stream cut by the provider: ceil(chars / 3.5). */
export function estimateOutputTokens(deltaChars: number): number {
  return Math.ceil((deltaChars * OUTPUT_CHARS_PER_TOKEN_DEN) / OUTPUT_CHARS_PER_TOKEN_NUM);
}

export type CacheWriteTtl = "none" | "5m" | "1h";

export type ReservationInput = {
  /** Text estimate, or the exact count_tokens result when the request has images or documents. */
  inputTokens: number;
  maxTokens: number;
  /** Most expensive cache_control in the request: "1h" if any ttl 1h, "5m" if any other cache_control. */
  cacheWrite: CacheWriteTtl;
  /** Present when tools include web_search; maxUses from the tool definition if set. */
  webSearch?: { maxUses?: number };
};

/** Tier used for the reservation: the next tier starts once the estimate exceeds 70% of a tier's limit. */
export function reserveTierFor(model: ModelEntry, inputTokens: number): PriceTier {
  const tier = model.tiers.find(
    (t) =>
      t.maxPromptTokens === null || inputTokens * 10_000 <= t.maxPromptTokens * RESERVE_TIER_HEADROOM_BPS,
  );
  if (!tier) throw new Error(`Model ${model.id} has no tier for ${inputTokens} tokens`);
  return tier;
}

function inputRate(p: TokenPrices, ttl: CacheWriteTtl): bigint {
  return ttl === "1h" ? p.cacheWrite1h : ttl === "5m" ? p.cacheWrite5m : p.input;
}

/** Worst-case cost of a request, pUSD before markup (brief 5.5 step 2). */
export function reservationPusd(model: ModelEntry, r: ReservationInput): bigint {
  const uses = r.webSearch ? (r.webSearch.maxUses ?? WEB_SEARCH_HOLD_USES) : 0;
  // Search results join the prompt, so they count toward the tier as well.
  const p = reserveTierFor(model, r.inputTokens + uses * WEB_SEARCH_RESULT_TOKENS).prices;
  let total =
    big(r.inputTokens, "inputTokens") * inputRate(p, r.cacheWrite) + big(r.maxTokens, "maxTokens") * p.output;
  if (r.webSearch) {
    if (model.webSearchPusd === undefined) throw new Error(`Model ${model.id} has no web search price`);
    const topInput = [p.input, p.cacheWrite5m, p.cacheWrite1h].reduce(maxBig);
    total += big(uses, "maxUses") * (model.webSearchPusd + BigInt(WEB_SEARCH_RESULT_TOKENS) * topInput);
  }
  return total;
}

/** Reservation amount, μcr: marked-up worst case, at least MIN_CHARGE. Compare against max_reservation before reserving. */
export function reservationUcr(model: ModelEntry, r: ReservationInput, opts: PricingOptions = {}): bigint {
  return maxBig(applyMarkup(reservationPusd(model, r), opts.markupBps), opts.minChargeUcr ?? MIN_CHARGE_UCR);
}

/** Unspent price in credits per 1M tokens, exact decimal string (site, Docs, /v1/models): 4 000 000 pUSD → "4.60". */
export function creditsPerMillion(pusdPerToken: bigint, markupBps: number = MARKUP_BPS): string {
  // pUSD/token × 10^6 tokens / 10^12 = $ per 1M; × (10 000 + bps) / 10 000.
  return decimalString(pusdPerToken * (BPS_DENOMINATOR + BigInt(markupBps)), 10);
}
