// GET /v1/models — one response for both SDKs and Claude Code discovery (brief 8.9).

import { CLAUDE_MODELS, creditsPerMillion, type ModelEntry } from "@unspent/shared";

export function modelsResponse(markupBps: number, catalog: ModelEntry[] = CLAUDE_MODELS) {
  const data = catalog
    .filter((m) => m.enabled)
    .map((m) => ({
      id: m.id,
      object: "model",
      type: "model",
      display_name: m.displayName,
      created: 0,
      created_at: `${m.priceFetchedAt}T00:00:00Z`,
      owned_by: m.provider,
      description: m.description,
      context_window: m.contextWindow,
      max_tokens: m.maxOutputTokens,
      endpoints: m.endpoints,
      pricing: {
        unit: "credits_per_1m_tokens",
        source: m.priceSource,
        fetched_at: m.priceFetchedAt,
        tiers: m.tiers.map((t) => ({
          max_prompt_tokens: t.maxPromptTokens,
          input: creditsPerMillion(t.prices.input, markupBps),
          output: creditsPerMillion(t.prices.output, markupBps),
          cache_write_5m: creditsPerMillion(t.prices.cacheWrite5m, markupBps),
          cache_write_1h: creditsPerMillion(t.prices.cacheWrite1h, markupBps),
          cache_read: creditsPerMillion(t.prices.cacheRead, markupBps),
        })),
      },
    }));
  return {
    object: "list",
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  };
}
