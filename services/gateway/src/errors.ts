// Gateway errors (brief 8.10), rendered in the Anthropic format on /v1/messages and the OpenAI format on
// /v1/chat/completions. Provider errors are not GatewayErrors: their bodies are forwarded unchanged.

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "billing_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

export type GatewayError = {
  status: number;
  type: AnthropicErrorType;
  /** OpenAI-format error code. */
  code: string;
  message: string;
  retryAfterSec?: number;
  extra?: Record<string, unknown>;
};

export const gwErr = (
  status: number,
  type: AnthropicErrorType,
  code: string,
  message: string,
  more: Partial<Pick<GatewayError, "retryAfterSec" | "extra">> = {},
): GatewayError => ({ status, type, code, message, ...more });

export function anthropicError(type: AnthropicErrorType, message: string) {
  return { type: "error", error: { type, message } } as const;
}

export function openaiError(code: string, message: string, type = "invalid_request_error") {
  return { error: { message, type, code } } as const;
}

function headers(e: GatewayError): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (e.retryAfterSec !== undefined) h["retry-after"] = String(Math.max(1, Math.ceil(e.retryAfterSec)));
  return h;
}

export function renderAnthropic(e: GatewayError): Response {
  return new Response(JSON.stringify({ ...anthropicError(e.type, e.message), ...e.extra }), {
    status: e.status,
    headers: headers(e),
  });
}

const OPENAI_TYPE: Partial<Record<AnthropicErrorType, string>> = {
  authentication_error: "invalid_request_error",
  billing_error: "insufficient_quota",
  rate_limit_error: "rate_limit_error",
  overloaded_error: "server_error",
  api_error: "server_error",
};

export function renderOpenAI(e: GatewayError): Response {
  return new Response(
    JSON.stringify({ ...openaiError(e.code, e.message, OPENAI_TYPE[e.type] ?? e.type), ...e.extra }),
    {
      status: e.status,
      headers: headers(e),
    },
  );
}
