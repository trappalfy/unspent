import { MOCK_ORGANIZATION_ID, rateLimitedHeaders } from "./headers";

export type ErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 504 | 529;

/** Status → error type per docs api/errors (422 has no own type: "invalid_request_error ... other 4XX"). */
export const ERROR_DEFAULTS: Record<ErrorStatus, { type: string; message: string }> = {
  400: { type: "invalid_request_error", message: "prompt is too long: 1000001 tokens > 1000000 maximum" },
  401: { type: "authentication_error", message: "invalid x-api-key" },
  402: {
    type: "billing_error",
    message:
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  },
  403: {
    type: "permission_error",
    message: "Your API key does not have permission to use the specified resource.",
  },
  404: { type: "not_found_error", message: "The requested resource could not be found." },
  409: { type: "conflict_error", message: "The request conflicts with the current state of the resource." },
  413: { type: "request_too_large", message: "Request exceeds the maximum allowed number of bytes." },
  422: { type: "invalid_request_error", message: "messages.0.content: Input should be a valid list" },
  429: {
    type: "rate_limit_error",
    message:
      "This request would exceed the rate limit for your organization of 2,000,000 input tokens per minute. For details, refer to: https://docs.claude.com/en/api/rate-limits. You can see the response headers for current usage. Please reduce the prompt length or the maximum tokens requested, or try again later.",
  },
  500: { type: "api_error", message: "Internal server error" },
  504: { type: "timeout_error", message: "Request timed out" },
  529: { type: "overloaded_error", message: "Overloaded" },
};

const DEFAULT_RETRY_AFTER: Partial<Record<number, number>> = { 429: 30, 529: 5 };

export function errorBody(type: string, message: string, requestId: string) {
  return { type: "error", error: { type, message }, request_id: requestId };
}

/** HTTP status the API uses for an error type (e.g. overloaded_error → 529). */
export function statusForErrorType(type: string): ErrorStatus {
  const hit = Object.entries(ERROR_DEFAULTS).find(([, e]) => e.type === type);
  return hit ? (Number(hit[0]) as ErrorStatus) : 500;
}

export interface ErrorHeaderOptions {
  /** Seconds; default 30 for 429 and 5 for 529, none otherwise. `null` omits it (like the spend-cap 429). */
  retryAfter?: number | null;
  /** `x-should-retry`; default true for 408, 409, 429 and 5xx. */
  shouldRetry?: boolean;
}

export function errorHeaders(
  status: number,
  requestId: string,
  opts: ErrorHeaderOptions = {},
  nowMs = Date.now(),
): Record<string, string> {
  const retryAfter = opts.retryAfter === undefined ? (DEFAULT_RETRY_AFTER[status] ?? null) : opts.retryAfter;
  const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  return {
    "content-type": "application/json",
    "request-id": requestId,
    "anthropic-organization-id": MOCK_ORGANIZATION_ID,
    "x-should-retry": String(opts.shouldRetry ?? retryable),
    ...(retryAfter === null ? {} : { "retry-after": String(retryAfter) }),
    ...(status === 429 ? rateLimitedHeaders(nowMs) : {}),
  };
}
