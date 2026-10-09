export const MOCK_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000000";

export type UnifiedStatus = "allowed" | "allowed_warning" | "rejected";

/**
 * Example `anthropic-ratelimit-unified-*` headers (unified subscription-style limits as seen on Claude Code
 * traffic). They are not in the public API reference, so treat the exact set as illustrative.
 */
export function unifiedRateLimitHeaders(status: UnifiedStatus, nowMs = Date.now()): Record<string, string> {
  const now = Math.floor(nowMs / 1000);
  const fiveHourReset = String(now + 5 * 3600);
  return {
    "anthropic-ratelimit-unified-status": status,
    "anthropic-ratelimit-unified-reset": fiveHourReset,
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-fallback-percentage": "0.5",
    "anthropic-ratelimit-unified-5h-status": status,
    "anthropic-ratelimit-unified-5h-reset": fiveHourReset,
    "anthropic-ratelimit-unified-5h-utilization": status === "rejected" ? "1.0" : "0.12",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-7d-reset": String(now + 7 * 24 * 3600),
    "anthropic-ratelimit-unified-7d-utilization": "0.34",
  };
}

/** Documented per-minute rate limit headers of a 429 (docs: api/rate-limits#response-headers). */
export function rateLimitedHeaders(nowMs = Date.now()): Record<string, string> {
  const reset = new Date(nowMs + 30_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    "anthropic-ratelimit-requests-limit": "1000",
    "anthropic-ratelimit-requests-remaining": "0",
    "anthropic-ratelimit-requests-reset": reset,
    "anthropic-ratelimit-input-tokens-limit": "2000000",
    "anthropic-ratelimit-input-tokens-remaining": "0",
    "anthropic-ratelimit-input-tokens-reset": reset,
    ...unifiedRateLimitHeaders("rejected", nowMs),
  };
}

export function successHeaders(
  requestId: string,
  kind: "stream" | "json",
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-type": kind === "stream" ? "text/event-stream; charset=utf-8" : "application/json",
    ...(kind === "stream" ? { "cache-control": "no-cache" } : {}),
    "request-id": requestId,
    "anthropic-organization-id": MOCK_ORGANIZATION_ID,
    ...unifiedRateLimitHeaders("allowed"),
    ...extra,
  };
}
