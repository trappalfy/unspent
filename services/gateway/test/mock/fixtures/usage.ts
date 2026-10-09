/** Usage numbers a scenario reports. Names follow the Messages API `usage` object. */
export interface UsageOptions {
  input_tokens?: number;
  /** Final cumulative output tokens (last message_delta, non-stream Message). */
  output_tokens?: number;
  cache_read_input_tokens?: number;
  /** `usage.cache_creation.ephemeral_5m_input_tokens`; `cache_creation_input_tokens` is 5m + 1h. */
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
  /** `output_tokens` in message_start; the real API sends a small number there. */
  initial_output_tokens?: number;
  /** `usage.output_tokens_details.thinking_tokens`; the field is omitted while undefined. */
  thinking_tokens?: number;
  service_tier?: string;
  inference_geo?: string;
}

export interface ResolvedUsage extends Required<Omit<UsageOptions, "thinking_tokens">> {
  thinking_tokens: number | undefined;
}

export const DEFAULT_USAGE: ResolvedUsage = {
  input_tokens: 120,
  output_tokens: 48,
  cache_read_input_tokens: 2048,
  ephemeral_5m_input_tokens: 512,
  ephemeral_1h_input_tokens: 256,
  initial_output_tokens: 1,
  thinking_tokens: undefined,
  service_tier: "standard",
  inference_geo: "global",
};

/** DEFAULT_USAGE overlaid with each layer's defined fields, left to right. */
export function resolveUsage(...layers: (UsageOptions | undefined)[]): ResolvedUsage {
  const usage = { ...DEFAULT_USAGE };
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      if (value !== undefined) Object.assign(usage, { [key]: value });
    }
  }
  return usage;
}

export const cacheCreationTokens = (u: ResolvedUsage): number =>
  u.ephemeral_5m_input_tokens + u.ephemeral_1h_input_tokens;

/** `message.usage` of message_start. */
export function startUsage(u: ResolvedUsage): Record<string, unknown> {
  return {
    input_tokens: u.input_tokens,
    cache_creation_input_tokens: cacheCreationTokens(u),
    cache_read_input_tokens: u.cache_read_input_tokens,
    cache_creation: {
      ephemeral_5m_input_tokens: u.ephemeral_5m_input_tokens,
      ephemeral_1h_input_tokens: u.ephemeral_1h_input_tokens,
    },
    output_tokens: u.initial_output_tokens,
    service_tier: u.service_tier,
    inference_geo: u.inference_geo,
  };
}

const thinkingDetails = (u: ResolvedUsage) =>
  u.thinking_tokens === undefined ? {} : { output_tokens_details: { thinking_tokens: u.thinking_tokens } };

/**
 * `usage` of the final message_delta (MessageDeltaUsage): cumulative counts, input fields repeated,
 * no `cache_creation` breakdown and no `service_tier`.
 */
export function deltaUsage(u: ResolvedUsage, webSearchRequests = 0): Record<string, unknown> {
  return {
    input_tokens: u.input_tokens,
    cache_creation_input_tokens: cacheCreationTokens(u),
    cache_read_input_tokens: u.cache_read_input_tokens,
    output_tokens: u.output_tokens,
    ...(webSearchRequests > 0 ? { server_tool_use: { web_search_requests: webSearchRequests } } : {}),
    ...thinkingDetails(u),
  };
}

/** `usage` of a non-streaming Message. */
export function messageUsage(u: ResolvedUsage, webSearchRequests = 0): Record<string, unknown> {
  return {
    ...startUsage(u),
    output_tokens: u.output_tokens,
    ...thinkingDetails(u),
    ...(webSearchRequests > 0
      ? { server_tool_use: { web_search_requests: webSearchRequests, web_fetch_requests: 0 } }
      : {}),
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Recursively merges `extra` into a copy of `target`. */
export function deepMerge(
  target: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...target };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}
