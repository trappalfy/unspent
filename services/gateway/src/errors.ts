// Error bodies in both wire formats (brief 8.10).

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "billing_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

export function anthropicError(type: AnthropicErrorType, message: string) {
  return { type: "error", error: { type, message } } as const;
}

export function openaiError(code: string, message: string, type = "invalid_request_error") {
  return { error: { message, type, code } } as const;
}
