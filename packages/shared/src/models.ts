// Model catalog (brief 5.2). Provider prices in pUSD per token: $X per 1M tokens = X × 10^6 pUSD/token.
// Claude prices: platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-09 (docs/STAGE1_RECON.md).

export type TokenPrices = {
  input: bigint;
  output: bigint;
  cacheWrite5m: bigint;
  cacheWrite1h: bigint;
  cacheRead: bigint;
};

/** A price tier applies while the request's prompt (input + cache read + cache write) is ≤ maxPromptTokens; null = no upper bound. */
export type PriceTier = {
  maxPromptTokens: number | null;
  prices: TokenPrices;
};

export type Endpoint = "/v1/messages" | "/v1/chat/completions";

export type ModelEntry = {
  id: string;
  provider: "anthropic" | "openrouter";
  displayName: string;
  description: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** Ordered by maxPromptTokens ascending; the last tier has maxPromptTokens = null. */
  tiers: PriceTier[];
  /** Provider price per web search, pUSD; undefined = web search not offered. */
  webSearchPusd?: bigint;
  endpoints: Endpoint[];
  priceSource: string;
  priceFetchedAt: string;
  enabled: boolean;
};

const M = 1_000_000n;
/** $ per 1M tokens → pUSD per token. Accepts up to 6 decimals given as a string to stay exact. */
export function perMillion(usd: string): bigint {
  const [w, f = ""] = usd.split(".");
  if (f.length > 6) throw new RangeError(`perMillion: too many decimals in ${usd}`);
  return BigInt(w!) * M + BigInt(f.padEnd(6, "0"));
}

function prices(input: string, output: string, w5m: string, w1h: string, read: string): TokenPrices {
  return {
    input: perMillion(input),
    output: perMillion(output),
    cacheWrite5m: perMillion(w5m),
    cacheWrite1h: perMillion(w1h),
    cacheRead: perMillion(read),
  };
}

/** $10 per 1 000 searches = $0.01 per search. */
const WEB_SEARCH_PUSD = 10_000_000_000n;

const ANTHROPIC_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
const ANTHROPIC_CHECKED = "2026-10-09";
const BOTH: Endpoint[] = ["/v1/messages", "/v1/chat/completions"];

export const CLAUDE_MODELS: ModelEntry[] = [
  {
    id: "claude-opus-5-5",
    provider: "anthropic",
    displayName: "Claude Opus 5.5",
    description: "Most capable Claude model for complex reasoning and agentic coding.",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    tiers: [{ maxPromptTokens: null, prices: prices("4", "20", "5", "8", "0.20") }],
    webSearchPusd: WEB_SEARCH_PUSD,
    endpoints: BOTH,
    priceSource: ANTHROPIC_SOURCE,
    priceFetchedAt: ANTHROPIC_CHECKED,
    enabled: true,
  },
  {
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    displayName: "Claude Sonnet 5.5",
    description: "Balanced Claude model for everyday coding and agents.",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    tiers: [{ maxPromptTokens: null, prices: prices("2", "10", "2.50", "4", "0.10") }],
    webSearchPusd: WEB_SEARCH_PUSD,
    endpoints: BOTH,
    priceSource: ANTHROPIC_SOURCE,
    priceFetchedAt: ANTHROPIC_CHECKED,
    enabled: true,
  },
  {
    id: "claude-haiku-5-5",
    provider: "anthropic",
    displayName: "Claude Haiku 5.5",
    description: "Fastest, lowest-cost Claude model.",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    tiers: [
      { maxPromptTokens: 100_000, prices: prices("0.10", "0.50", "0.125", "0.20", "0.01") },
      { maxPromptTokens: null, prices: prices("0.50", "2.50", "0.625", "1", "0.05") },
    ],
    webSearchPusd: WEB_SEARCH_PUSD,
    endpoints: BOTH,
    priceSource: ANTHROPIC_SOURCE,
    priceFetchedAt: ANTHROPIC_CHECKED,
    enabled: true,
  },
  {
    // Q3: optional at launch, off until the owner enables it.
    id: "claude-fable-5-1",
    provider: "anthropic",
    displayName: "Claude Fable 5.1",
    description: "Frontier Claude model for the hardest long-horizon tasks.",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    tiers: [{ maxPromptTokens: null, prices: prices("10", "50", "12.50", "20", "0.25") }],
    webSearchPusd: WEB_SEARCH_PUSD,
    endpoints: BOTH,
    priceSource: ANTHROPIC_SOURCE,
    priceFetchedAt: ANTHROPIC_CHECKED,
    enabled: false,
  },
];

export function findModel(id: string, catalog: ModelEntry[] = CLAUDE_MODELS): ModelEntry | undefined {
  return catalog.find((m) => m.id === id);
}
