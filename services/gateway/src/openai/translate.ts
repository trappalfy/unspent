// OpenAI Chat Completions <-> Anthropic Messages translation for Claude models (brief 8.8, 8.10).
// Owner decision D1 (docs/STAGE1_RECON.md, C): `temperature` and `top_p` are ignored, never forwarded,
// because Claude 5.x rejects temperature != 1 and top_p < 0.99.
// Everything here is pure: no I/O, and the clock is read only through the injectable `now`.

// ---------------------------------------------------------------------------------------------------------
// Shared shapes

export interface OpenAIError {
  error: { message: string; type: string; code: string };
}

/** Price info added to every response and to the final stream chunk (brief 8.8). */
export interface UnspentInfo {
  request_id: string;
  credits_charged: string;
  available: string;
}

/** Anthropic usage as it arrives in a response or in the gateway's accumulated stream usage. */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

// Anthropic request shapes (only what the translation produces).

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
}

export type AnthropicContentBlockParam =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: AnthropicContentBlockParam[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
  | { type: "none" };

export interface AnthropicMessagesBody {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessageParam[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stop_sequences?: string[];
  stream?: boolean;
}

// Anthropic response shapes (only what the translation reads; unknown block types are skipped).

export interface AnthropicResponseBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  [key: string]: unknown;
}

export interface AnthropicMessage {
  id: string;
  type?: string;
  role?: string;
  model: string;
  content: AnthropicResponseBlock[];
  stop_reason: string | null;
  stop_sequence?: string | null;
  usage: AnthropicUsage;
}

// OpenAI response shapes.

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
}

export interface ChatCompletionMessage {
  role: "assistant";
  content: string | null;
  refusal: null;
  tool_calls?: ChatToolCall[];
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [{ index: 0; message: ChatCompletionMessage; logprobs: null; finish_reason: FinishReason }];
  usage: ChatUsage;
  unspent: UnspentInfo;
}

// ---------------------------------------------------------------------------------------------------------
// Errors

/** OpenAI-style `type` for an HTTP status. The machine-readable part is `code` (brief 8.10). */
export function openaiErrorType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 402) return "insufficient_quota";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}

export function openaiError(status: number, code: string, message: string): OpenAIError {
  return { error: { message, type: openaiErrorType(status), code } };
}

const CODE_BY_ANTHROPIC_TYPE = new Map<string, string>([
  ["invalid_request_error", "invalid_request_error"],
  ["authentication_error", "invalid_api_key"],
  ["permission_error", "permission_denied"],
  ["not_found_error", "not_found"],
  ["request_too_large", "request_too_large"],
  ["rate_limit_error", "rate_limit_exceeded"],
  ["billing_error", "insufficient_credits"],
  ["api_error", "server_error"],
  ["overloaded_error", "server_error"],
  ["timeout_error", "timeout"],
]);

const STATUS_BY_ANTHROPIC_TYPE = new Map<string, number>([
  ["invalid_request_error", 400],
  ["authentication_error", 401],
  ["billing_error", 402],
  ["permission_error", 403],
  ["not_found_error", 404],
  ["request_too_large", 413],
  ["rate_limit_error", 429],
  ["api_error", 500],
  ["timeout_error", 504],
  ["overloaded_error", 529],
]);

/** HTTP status Anthropic uses for an error type; for `error` events that arrive mid-stream. */
export function anthropicErrorStatus(type: unknown): number {
  return (typeof type === "string" && STATUS_BY_ANTHROPIC_TYPE.get(type)) || 500;
}

/** Maps an Anthropic error body (`{ type: "error", error: { type, message } }`) to the OpenAI format. */
export function anthropicErrorToOpenAI(status: number, anthropicBody: unknown): OpenAIError {
  const err = isObject(anthropicBody) && isObject(anthropicBody.error) ? anthropicBody.error : undefined;
  const type = typeof err?.type === "string" && err.type !== "" ? err.type : undefined;
  const message =
    typeof err?.message === "string" && err.message !== ""
      ? err.message
      : `Model provider returned an error (HTTP ${status}).`;
  const code =
    (type !== undefined ? (CODE_BY_ANTHROPIC_TYPE.get(type) ?? type) : undefined) ??
    (status >= 500 ? "server_error" : "provider_error");
  return openaiError(status, code, message);
}

// ---------------------------------------------------------------------------------------------------------
// Request

/** Top-level OpenAI fields that are accepted and dropped. Docs list them as ignored (brief 8.8, D1). */
export const IGNORED_FIELDS = [
  "temperature",
  "top_p",
  "response_format",
  "logprobs",
  "top_logprobs",
  "seed",
  "reasoning_effort",
  "frequency_penalty",
  "presence_penalty",
  "logit_bias",
  "user",
  "metadata",
  "store",
  "service_tier",
  "prediction",
  "modalities",
  "audio",
] as const;

const HANDLED_FIELDS = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stop",
  "max_completion_tokens",
  "max_tokens",
  "n",
  "stream",
  "stream_options",
]);

// Legacy function calling: silently dropping it would make the model never call the functions.
const REJECTED_FIELDS = ["functions", "function_call"] as const;

export const DEFAULT_MAX_TOKENS = 4096;

const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export type TranslateRequestResult =
  | { ok: true; messages: AnthropicMessagesBody; stream: boolean; includeUsage: boolean; ignored: string[] }
  | { ok: false; status: 400; error: OpenAIError };

class RequestError extends Error {
  constructor(
    readonly code: "invalid_request" | "unsupported_parameter",
    message: string,
  ) {
    super(message);
  }
}

function fail(message: string, code: RequestError["code"] = "invalid_request"): never {
  throw new RequestError(code, message);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null;
}

/**
 * Translates an OpenAI Chat Completions request body into an Anthropic Messages body.
 * Validation problems come back as a 400 with an OpenAI-format error, never as a throw.
 */
export function translateRequest(body: unknown): TranslateRequestResult {
  try {
    return translateRequestOrThrow(body);
  } catch (e) {
    if (e instanceof RequestError)
      return { ok: false, status: 400, error: openaiError(400, e.code, e.message) };
    throw e;
  }
}

function translateRequestOrThrow(body: unknown): TranslateRequestResult {
  if (!isObject(body)) fail("Request body must be a JSON object.");

  const model = body.model;
  if (typeof model !== "string" || model === "") fail("You must provide a 'model' parameter.");

  for (const key of REJECTED_FIELDS) {
    if (present(body[key]))
      fail(
        `'${key}' is deprecated and not supported. Use 'tools' and 'tool_choice'.`,
        "unsupported_parameter",
      );
  }

  if (present(body.n) && body.n !== 1)
    fail("Only n=1 is supported for Claude models.", "unsupported_parameter");

  const maxTokens = readMaxTokens(body);

  if (present(body.stream) && typeof body.stream !== "boolean") fail("'stream' must be a boolean.");
  const stream = body.stream === true;

  if (present(body.stream_options) && !isObject(body.stream_options))
    fail("'stream_options' must be an object.");
  const includeUsage = isObject(body.stream_options) && body.stream_options.include_usage === true;

  const { system, messages } = translateMessages(body.messages);
  const tools = translateTools(body.tools);
  const toolChoice = translateToolChoice(body.tool_choice, body.parallel_tool_calls, tools);
  const stopSequences = translateStop(body.stop);

  const out: AnthropicMessagesBody = { model, max_tokens: maxTokens, messages };
  if (system !== undefined) out.system = system;
  if (tools !== undefined) out.tools = tools;
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  if (stopSequences !== undefined) out.stop_sequences = stopSequences;
  if (stream) out.stream = true;

  return { ok: true, messages: out, stream, includeUsage, ignored: collectIgnored(body) };
}

function readMaxTokens(body: Record<string, unknown>): number {
  let result: number | undefined;
  for (const key of ["max_completion_tokens", "max_tokens"]) {
    const v = body[key];
    if (!present(v)) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) fail(`'${key}' must be a positive integer.`);
    result ??= v;
  }
  return result ?? DEFAULT_MAX_TOKENS;
}

/** Ignored known fields in IGNORED_FIELDS order, then unknown fields in body order. Nulls are not reported. */
function collectIgnored(body: Record<string, unknown>): string[] {
  const known: readonly string[] = IGNORED_FIELDS;
  const ignored = known.filter((k) => present(body[k]));
  for (const k of Object.keys(body)) {
    if (!HANDLED_FIELDS.has(k) && !known.includes(k) && present(body[k])) ignored.push(k);
  }
  return ignored;
}

// Messages ----------------------------------------------------------------------------------------------

type ContentOptions = { images: boolean; refusal: boolean };
const USER_CONTENT: ContentOptions = { images: true, refusal: false };
const ASSISTANT_CONTENT: ContentOptions = { images: false, refusal: true };

function translateMessages(raw: unknown): { system?: string; messages: AnthropicMessageParam[] } {
  if (!Array.isArray(raw) || raw.length === 0) fail("'messages' must be a non-empty array.");

  const systemParts: string[] = [];
  const messages: AnthropicMessageParam[] = [];

  raw.forEach((m: unknown, i) => {
    const path = `messages[${i}]`;
    if (!isObject(m)) fail(`${path} must be an object.`);
    if (m.role === "function")
      fail(`${path}: role 'function' is deprecated and not supported. Use 'tool'.`, "unsupported_parameter");
    switch (m.role) {
      case "system":
      case "developer": {
        const text = systemText(m.content, `${path}.content`);
        if (text !== "") systemParts.push(text);
        return;
      }
      case "user": {
        if (!present(m.content)) fail(`${path}.content is required.`);
        const blocks = contentBlocks(m.content, `${path}.content`, USER_CONTENT);
        if (blocks.length === 0) fail(`${path}.content must not be empty.`);
        appendMessage(messages, "user", blocks);
        return;
      }
      case "assistant": {
        if (present(m.function_call)) {
          fail(
            `${path}.function_call is deprecated and not supported. Use 'tool_calls'.`,
            "unsupported_parameter",
          );
        }
        const blocks: AnthropicContentBlockParam[] = present(m.content)
          ? contentBlocks(m.content, `${path}.content`, ASSISTANT_CONTENT)
          : [];
        if (present(m.tool_calls)) {
          if (!Array.isArray(m.tool_calls)) fail(`${path}.tool_calls must be an array.`);
          m.tool_calls.forEach((tc: unknown, j) => {
            blocks.push(toolUseBlock(tc, `${path}.tool_calls[${j}]`));
          });
        }
        // An assistant turn with neither text nor tool calls carries nothing for Claude.
        if (blocks.length > 0) appendMessage(messages, "assistant", blocks);
        return;
      }
      case "tool": {
        appendMessage(messages, "user", [toolResultBlock(m, path)]);
        return;
      }
      default:
        fail(`${path}.role must be one of 'system', 'developer', 'user', 'assistant', 'tool'.`);
    }
  });

  if (messages.length === 0) fail("'messages' must contain at least one user or assistant message.");

  // Anthropic wants tool_result blocks before any other block in a user turn.
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const results = msg.content.filter((b) => b.type === "tool_result");
    if (results.length > 0)
      msg.content = [...results, ...msg.content.filter((b) => b.type !== "tool_result")];
  }

  return { system: systemParts.length > 0 ? systemParts.join("\n") : undefined, messages };
}

/** Anthropic requires alternating roles, so consecutive same-role turns are merged. */
function appendMessage(
  messages: AnthropicMessageParam[],
  role: AnthropicMessageParam["role"],
  blocks: AnthropicContentBlockParam[],
): void {
  const last = messages.at(-1);
  if (last?.role === role) last.content.push(...blocks);
  else messages.push({ role, content: blocks });
}

function systemText(content: unknown, path: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) fail(`${path} must be a string or an array of text parts.`);
  return content
    .map((part: unknown, j) => {
      if (!isObject(part) || part.type !== "text" || typeof part.text !== "string") {
        fail(`${path}[${j}] must be a text part.`);
      }
      return part.text;
    })
    .filter((t) => t !== "")
    .join("\n");
}

function contentBlocks(
  content: unknown,
  path: string,
  opts: ContentOptions,
): Array<AnthropicTextBlock | AnthropicImageBlock> {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  if (!Array.isArray(content)) fail(`${path} must be a string or an array of content parts.`);

  const blocks: Array<AnthropicTextBlock | AnthropicImageBlock> = [];
  content.forEach((part: unknown, j) => {
    const partPath = `${path}[${j}]`;
    if (!isObject(part)) fail(`${partPath} must be an object.`);
    if (part.type === "text") {
      if (typeof part.text !== "string") fail(`${partPath}.text must be a string.`);
      // Claude rejects empty text blocks.
      if (part.text !== "") blocks.push({ type: "text", text: part.text });
    } else if (part.type === "refusal" && opts.refusal) {
      if (typeof part.refusal !== "string") fail(`${partPath}.refusal must be a string.`);
      if (part.refusal !== "") blocks.push({ type: "text", text: part.refusal });
    } else if (part.type === "image_url" && opts.images) {
      blocks.push(imageBlock(part, partPath));
    } else {
      fail(`${partPath}.type '${String(part.type)}' is not supported here.`, "unsupported_parameter");
    }
  });
  return blocks;
}

function imageBlock(part: Record<string, unknown>, path: string): AnthropicImageBlock {
  const ref = part.image_url;
  const url = typeof ref === "string" ? ref : isObject(ref) ? ref.url : undefined;
  if (typeof url !== "string" || url === "") fail(`${path}.image_url.url is required.`);

  if (url.startsWith("data:")) {
    const match = /^data:([^;,]+)((?:;[^;,]*)*),(.*)$/s.exec(url);
    if (!match) fail(`${path}.image_url.url is not a valid data URL.`);
    const params = (match[2] ?? "").split(";");
    if (!params.includes("base64")) fail(`${path}.image_url.url must be a base64 data URL.`);
    let mediaType = (match[1] ?? "").toLowerCase();
    if (mediaType === "image/jpg") mediaType = "image/jpeg";
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
      fail(`${path}: image type '${mediaType}' is not supported. Use JPEG, PNG, GIF or WebP.`);
    }
    const data = match[3] ?? "";
    if (data === "") fail(`${path}.image_url.url has no image data.`);
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  }

  if (/^https:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
  return fail(`${path}.image_url.url must be an https URL or a base64 data URL.`);
}

function toolUseBlock(tc: unknown, path: string): AnthropicToolUseBlock {
  if (!isObject(tc)) fail(`${path} must be an object.`);
  if (tc.type !== "function") {
    fail(
      `${path}.type '${String(tc.type)}' is not supported. Only 'function' tool calls are.`,
      "unsupported_parameter",
    );
  }
  if (typeof tc.id !== "string" || tc.id === "") fail(`${path}.id is required.`);
  const fn = tc.function;
  if (!isObject(fn) || typeof fn.name !== "string" || fn.name === "")
    fail(`${path}.function.name is required.`);
  return {
    type: "tool_use",
    id: tc.id,
    name: fn.name,
    input: parseArguments(fn.arguments, `${path}.function.arguments`),
  };
}

function parseArguments(args: unknown, path: string): Record<string, unknown> {
  // Some clients send "" (or nothing) for a call without arguments.
  if (!present(args)) return {};
  if (isObject(args)) return args;
  if (typeof args !== "string") fail(`${path} must be a JSON string.`);
  if (args.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    fail(`${path} is not valid JSON.`);
  }
  if (!isObject(parsed)) fail(`${path} must encode a JSON object.`);
  return parsed;
}

function toolResultBlock(m: Record<string, unknown>, path: string): AnthropicToolResultBlock {
  const id = m.tool_call_id;
  if (typeof id !== "string" || id === "") fail(`${path}.tool_call_id is required.`);
  const block: AnthropicToolResultBlock = { type: "tool_result", tool_use_id: id };
  if (typeof m.content === "string") {
    if (m.content !== "") block.content = m.content;
  } else if (present(m.content)) {
    const blocks = contentBlocks(m.content, `${path}.content`, USER_CONTENT);
    if (blocks.length > 0) block.content = blocks;
  }
  return block;
}

// Tools ---------------------------------------------------------------------------------------------------

function translateTools(raw: unknown): AnthropicTool[] | undefined {
  if (!present(raw)) return undefined;
  if (!Array.isArray(raw)) fail("'tools' must be an array.");
  if (raw.length === 0) return undefined;
  return raw.map((t: unknown, i) => {
    const path = `tools[${i}]`;
    if (!isObject(t)) fail(`${path} must be an object.`);
    if (t.type !== "function") {
      fail(
        `${path}.type '${String(t.type)}' is not supported. Only 'function' tools are.`,
        "unsupported_parameter",
      );
    }
    const fn = t.function;
    if (!isObject(fn) || typeof fn.name !== "string" || fn.name === "")
      fail(`${path}.function.name is required.`);
    if (present(fn.parameters) && !isObject(fn.parameters)) {
      fail(`${path}.function.parameters must be a JSON Schema object.`);
    }
    const params = isObject(fn.parameters) ? fn.parameters : {};
    // Claude requires an object schema; OpenAI allows omitting `parameters` for a no-argument function.
    const tool: AnthropicTool = {
      name: fn.name,
      input_schema: "type" in params ? params : { type: "object", properties: {}, ...params },
    };
    if (typeof fn.description === "string") tool.description = fn.description;
    return tool;
  });
}

function translateToolChoice(
  raw: unknown,
  parallel: unknown,
  tools: AnthropicTool[] | undefined,
): AnthropicToolChoice | undefined {
  if (present(parallel) && typeof parallel !== "boolean") fail("'parallel_tool_calls' must be a boolean.");

  let choice: AnthropicToolChoice | undefined;
  if (!present(raw)) choice = undefined;
  else if (raw === "auto") choice = { type: "auto" };
  else if (raw === "none") choice = { type: "none" };
  else if (raw === "required") choice = { type: "any" };
  else if (isObject(raw)) {
    if (raw.type !== "function") {
      fail(`'tool_choice' type '${String(raw.type)}' is not supported.`, "unsupported_parameter");
    }
    const name = isObject(raw.function) ? raw.function.name : undefined;
    if (typeof name !== "string" || name === "") fail("'tool_choice.function.name' is required.");
    if (tools && !tools.some((t) => t.name === name)) fail(`'tool_choice' names unknown tool '${name}'.`);
    choice = { type: "tool", name };
  } else {
    fail("'tool_choice' must be 'auto', 'none', 'required' or { type: 'function', function: { name } }.");
  }

  // Claude rejects tool_choice without tools; many clients send "auto" or "none" regardless.
  if (!tools) return undefined;
  if (parallel === false) {
    choice ??= { type: "auto" };
    if (choice.type !== "none") choice = { ...choice, disable_parallel_tool_use: true };
  }
  return choice;
}

function translateStop(raw: unknown): string[] | undefined {
  if (!present(raw)) return undefined;
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list) || !list.every((s) => typeof s === "string")) {
    fail("'stop' must be a string or an array of strings.");
  }
  const sequences = list.filter((s: string) => s !== "");
  return sequences.length > 0 ? sequences : undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Response

export function mapFinishReason(stopReason: string | null | undefined): FinishReason {
  switch (stopReason) {
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      // end_turn, stop_sequence, pause_turn and anything new.
      return "stop";
  }
}

/** prompt_tokens counts everything Claude read: fresh input, cache reads and cache writes (brief 8.8). */
export function mapUsage(usage: AnthropicUsage): ChatUsage {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const prompt = usage.input_tokens + cacheRead + (usage.cache_creation_input_tokens ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.output_tokens,
    total_tokens: prompt + usage.output_tokens,
    prompt_tokens_details: { cached_tokens: cacheRead },
  };
}

export function translateResponse(
  msg: AnthropicMessage,
  unspent: UnspentInfo,
  now: () => number = Date.now,
): ChatCompletion {
  const texts: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  // Thinking, redacted thinking and any other block types are not part of the OpenAI message.
  for (const block of msg.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: String(block.id),
        type: "function",
        function: { name: String(block.name), arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }

  const message: ChatCompletionMessage = {
    role: "assistant",
    content: texts.length > 0 ? texts.join("") : null,
    refusal: null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${msg.id}`,
    object: "chat.completion",
    created: Math.floor(now() / 1000),
    model: msg.model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: mapFinishReason(msg.stop_reason) }],
    usage: mapUsage(msg.usage),
    unspent,
  };
}
