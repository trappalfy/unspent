import type { SseEvent } from "../sse";
import type { ErrorStatus } from "./errors";
import {
  cacheCreationTokens,
  deepMerge,
  deltaUsage,
  messageUsage,
  type ResolvedUsage,
  resolveUsage,
  startUsage,
  type UsageOptions,
} from "./usage";

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal"
  | "model_context_window_exceeded";

export interface Timing {
  /** Delay before the status line and headers (time to first byte). Default 0. */
  headersDelayMs?: number;
  /** Delay between consecutive SSE events; each event is a separate write. Default 0 (slow: 1000). */
  chunkDelayMs?: number;
}

interface Base extends Timing {
  /** Extra response headers. */
  headers?: Record<string, string>;
  /** Fixed `input_tokens` for /v1/messages/count_tokens instead of the length estimate. */
  countTokens?: number;
}

interface Generated extends Base {
  usage?: UsageOptions;
  /** Model reported back; defaults to the request's `model`. */
  model?: string;
}

export interface TextScenario extends Generated {
  type: "text";
  /** text_delta pieces. */
  chunks?: string[];
  stopReason?: StopReason;
}

export interface ThinkingScenario extends Generated {
  type: "thinking";
  /** thinking_delta pieces. */
  thinking?: string[];
  signature?: string;
  /** "omitted": one empty thinking_delta, then the signature (the default display on current models). */
  display?: "summarized" | "omitted";
  /** text_delta pieces of the answer block. */
  chunks?: string[];
}

export interface ToolUseScenario extends Generated {
  type: "tool_use";
  /** text_delta pieces of the preamble block. */
  chunks?: string[];
  tools?: { name: string; input: Record<string, unknown> }[];
  /** Size of the input_json_delta pieces. Default 7. */
  jsonChunkSize?: number;
}

export interface WebSearchScenario extends Generated {
  type: "web_search";
  /** Number of server_tool_use + web_search_tool_result pairs = usage.server_tool_use.web_search_requests. */
  searches?: number;
  query?: string;
  /** text_delta pieces of the cited answer block. */
  chunks?: string[];
}

/** A text answer with long delays: chunkDelayMs defaults to 1000 and a stall precedes the first delta. */
export interface SlowScenario extends Omit<TextScenario, "type"> {
  type: "slow";
  /** Pause before the first content_block_delta. Default 10000. */
  stallMs?: number;
  /** Emit a ping every N ms during the stall (pings are not progress). Off by default. */
  pingIntervalMs?: number;
}

/** A text answer whose final usage carries a field the gateway does not know. */
export interface UnknownUsageFieldScenario extends Omit<TextScenario, "type"> {
  type: "unknown_usage_field";
  /** Deep-merged into message_delta usage (and non-stream usage). Default server_tool_use.code_execution_requests: 2. */
  extraUsage?: Record<string, unknown>;
}

/** HTTP error with the API's JSON error body. Also applies to count_tokens. */
export interface ErrorBeforeFirstTokenScenario extends Base {
  type: "error_before_first_token";
  status: ErrorStatus;
  errorType?: string;
  message?: string;
  retryAfter?: number | null;
  shouldRetry?: boolean;
}

/** A normal stream cut after `afterEvents` events, followed by an `event: error` and a clean end. */
export interface ErrorMidStreamScenario extends Base {
  type: "error_mid_stream";
  /** Stream to cut. Default { type: "text" }. */
  base?: SuccessScenario;
  /** Events of `base` sent before the cut. Default: up to and including the second content_block_delta. */
  afterEvents?: number;
  errorType?: string;
  message?: string;
}

/** A normal stream cut after `afterEvents` events by destroying the socket (no message_delta/message_stop). */
export interface DropMidStreamScenario extends Base {
  type: "drop_mid_stream";
  base?: SuccessScenario;
  afterEvents?: number;
}

export type SuccessScenario =
  | TextScenario
  | ThinkingScenario
  | ToolUseScenario
  | WebSearchScenario
  | SlowScenario
  | UnknownUsageFieldScenario;

export type Scenario =
  | SuccessScenario
  | ErrorBeforeFirstTokenScenario
  | ErrorMidStreamScenario
  | DropMidStreamScenario;

/** `n` is the mock's request counter; ids derive from it. */
export interface BuildContext {
  n: number;
  model: string;
}

export const ids = {
  request: (n: number) => `req_mock_${n}`,
  message: (n: number) => `msg_mock_${n}`,
  toolUse: (n: number, i: number) => `toolu_mock_${n}_${i}`,
  serverToolUse: (n: number, i: number) => `srvtoolu_mock_${n}_${i}`,
};

export const DEFAULT_TEXT = ["Hello", "!", " I'm", " a", " mock", " of", " Claude", "."];
export const DEFAULT_THINKING = [
  "I need to find the GCD of 1071 and 462 using the Euclidean algorithm.\n\n1071 = 2 × 462 + 147",
  "\n462 = 3 × 147 + 21",
  "\n147 = 7 × 21 + 0",
  "\nThe remainder is 0, so GCD(1071, 462) = 21.",
];
export const DEFAULT_SIGNATURE = "EqQBCgIYAhIMmockSignatureForTestsOnlyZA2b3hGgxBdjrkzLoky3dl1pkiMOYds";
export const DEFAULT_THINKING_ANSWER = ["The greatest common divisor", " of 1071 and 462 is **21**."];
export const DEFAULT_TOOL_PREAMBLE = ["Okay", ", let's check", " the weather."];
export const DEFAULT_TOOLS = [
  { name: "get_weather", input: { location: "San Francisco, CA", unit: "celsius" } },
];
export const DEFAULT_WEB_QUERY = "weather NYC today";
export const DEFAULT_WEB_ANSWER = ["Here's the current weather", " in New York City: 18°C", " and clear."];

const USAGE_DEFAULTS: Partial<Record<SuccessScenario["type"], UsageOptions>> = {
  thinking: { output_tokens: 180, thinking_tokens: 120 },
  tool_use: { output_tokens: 89 },
  web_search: { input_tokens: 10682, output_tokens: 510 },
};

/** Fully resolved usage numbers of a success scenario. */
export function scenarioUsage(s: SuccessScenario): ResolvedUsage {
  return resolveUsage(USAGE_DEFAULTS[s.type], s.usage);
}

type Json = Record<string, unknown>;
type Block =
  | { type: "text"; chunks: string[]; citations?: Json[] }
  | { type: "thinking"; chunks: string[]; signature: string }
  | { type: "tool_use" | "server_tool_use"; id: string; name: string; input: Json; jsonChunkSize: number }
  | { type: "web_search_tool_result"; tool_use_id: string; content: Json[] };

const searchResults = (i: number): Json[] =>
  [1, 2].map((k) => ({
    type: "web_search_result",
    title: `Weather in New York City (result ${i + 1}.${k})`,
    url: `https://example.com/weather/nyc/${i + 1}/${k}`,
    encrypted_content: `Ev0DCioIAxgCIiQmockEncryptedContent${i}${k}`,
    page_age: null,
  }));

const CITATION: Json = {
  type: "web_search_result_location",
  cited_text: "New York City weather today: 18°C, clear skies.",
  url: "https://example.com/weather/nyc/1/1",
  title: "Weather in New York City (result 1.1)",
  encrypted_index: "Eo8BCioIAhgBIiQmockEncryptedIndex",
};

const webSearches = (s: SuccessScenario) => (s.type === "web_search" ? (s.searches ?? 1) : 0);

function blocksOf(s: SuccessScenario, n: number): Block[] {
  switch (s.type) {
    case "text":
    case "slow":
    case "unknown_usage_field":
      return [{ type: "text", chunks: s.chunks ?? DEFAULT_TEXT }];
    case "thinking":
      return [
        {
          type: "thinking",
          chunks: s.display === "omitted" ? [""] : (s.thinking ?? DEFAULT_THINKING),
          signature: s.signature ?? DEFAULT_SIGNATURE,
        },
        { type: "text", chunks: s.chunks ?? DEFAULT_THINKING_ANSWER },
      ];
    case "tool_use":
      return [
        { type: "text", chunks: s.chunks ?? DEFAULT_TOOL_PREAMBLE },
        ...(s.tools ?? DEFAULT_TOOLS).map(
          (t, i): Block => ({
            type: "tool_use",
            id: ids.toolUse(n, i),
            name: t.name,
            input: t.input,
            jsonChunkSize: s.jsonChunkSize ?? 7,
          }),
        ),
      ];
    case "web_search": {
      const blocks: Block[] = [{ type: "text", chunks: ["I'll check", " the current weather for you."] }];
      const count = webSearches(s);
      for (let i = 0; i < count; i++) {
        const id = ids.serverToolUse(n, i);
        const query = `${s.query ?? DEFAULT_WEB_QUERY}${count > 1 ? ` #${i + 1}` : ""}`;
        blocks.push({ type: "server_tool_use", id, name: "web_search", input: { query }, jsonChunkSize: 7 });
        blocks.push({ type: "web_search_tool_result", tool_use_id: id, content: searchResults(i) });
      }
      blocks.push({ type: "text", chunks: s.chunks ?? DEFAULT_WEB_ANSWER, citations: [CITATION] });
      return blocks;
    }
  }
}

/** Partial JSON pieces as the API streams them: an empty piece first, then fixed-size slices. */
export function splitJson(json: string, size: number): string[] {
  const pieces = [""];
  for (let i = 0; i < json.length; i += size) pieces.push(json.slice(i, i + size));
  return pieces;
}

const ping = (): SseEvent => ({ event: "ping", data: { type: "ping" }, raw: '{"type": "ping"}' });

function blockEvents(b: Block, index: number): SseEvent[] {
  const ev = (type: string, fields: Json): SseEvent => ({ event: type, data: { type, index, ...fields } });
  const delta = (d: Json) => ev("content_block_delta", { delta: d });
  const events: SseEvent[] = [];
  switch (b.type) {
    case "text":
      events.push(
        ev("content_block_start", {
          content_block: b.citations ? { type: "text", text: "", citations: [] } : { type: "text", text: "" },
        }),
      );
      for (const citation of b.citations ?? []) events.push(delta({ type: "citations_delta", citation }));
      for (const text of b.chunks) events.push(delta({ type: "text_delta", text }));
      break;
    case "thinking":
      events.push(
        ev("content_block_start", { content_block: { type: "thinking", thinking: "", signature: "" } }),
      );
      for (const thinking of b.chunks) events.push(delta({ type: "thinking_delta", thinking }));
      events.push(delta({ type: "signature_delta", signature: b.signature }));
      break;
    case "tool_use":
    case "server_tool_use":
      events.push(
        ev("content_block_start", { content_block: { type: b.type, id: b.id, name: b.name, input: {} } }),
      );
      for (const partial_json of splitJson(JSON.stringify(b.input), b.jsonChunkSize)) {
        events.push(delta({ type: "input_json_delta", partial_json }));
      }
      break;
    case "web_search_tool_result":
      events.push(ev("content_block_start", { content_block: contentOf(b) }));
      break;
  }
  events.push(ev("content_block_stop", {}));
  return events;
}

function contentOf(b: Block): Json {
  switch (b.type) {
    case "text":
      return b.citations
        ? { type: "text", text: b.chunks.join(""), citations: b.citations }
        : { type: "text", text: b.chunks.join("") };
    case "thinking":
      return { type: "thinking", thinking: b.chunks.join(""), signature: b.signature };
    case "tool_use":
    case "server_tool_use":
      return { type: b.type, id: b.id, name: b.name, input: b.input };
    case "web_search_tool_result":
      return { type: b.type, tool_use_id: b.tool_use_id, content: b.content };
  }
}

function stopReasonOf(s: SuccessScenario): StopReason {
  if (s.type === "tool_use") return "tool_use";
  if (s.type === "text" || s.type === "slow" || s.type === "unknown_usage_field")
    return s.stopReason ?? "end_turn";
  return "end_turn";
}

const REFUSAL_DETAILS = { type: "refusal", category: null, explanation: null };
const DEFAULT_EXTRA_USAGE = { server_tool_use: { code_execution_requests: 2 } };

function finalUsage(s: SuccessScenario, usage: Json): Json {
  return s.type === "unknown_usage_field" ? deepMerge(usage, s.extraUsage ?? DEFAULT_EXTRA_USAGE) : usage;
}

export interface StreamPlan {
  events: SseEvent[];
  /** "end": close the response normally; "destroy": destroy the socket after the last event. */
  ending: "end" | "destroy";
}

const isMidStream = (s: Scenario): s is ErrorMidStreamScenario | DropMidStreamScenario =>
  s.type === "error_mid_stream" || s.type === "drop_mid_stream";

/** Every SSE event the mock writes for a scenario, in order. */
export function buildStreamPlan(s: Scenario, ctx: BuildContext): StreamPlan {
  if (s.type === "error_before_first_token") return { events: [], ending: "end" };
  if (isMidStream(s)) {
    const full = buildStreamPlan(s.base ?? { type: "text" }, ctx).events;
    const firstDelta = full.findIndex((e) => e.event === "content_block_delta");
    const head = full.slice(0, s.afterEvents ?? Math.min(firstDelta + 2, full.length - 2));
    if (s.type === "drop_mid_stream") return { events: head, ending: "destroy" };
    const error = { type: s.errorType ?? "overloaded_error", message: s.message ?? "Overloaded" };
    return { events: [...head, { event: "error", data: { type: "error", error } }], ending: "end" };
  }

  const usage = scenarioUsage(s);
  const events: SseEvent[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: ids.message(ctx.n),
          type: "message",
          role: "assistant",
          model: s.model ?? ctx.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: startUsage(usage),
        },
      },
    },
  ];
  blocksOf(s, ctx.n).forEach((block, i) => {
    const blockEvs = blockEvents(block, i);
    if (i === 0) blockEvs.splice(1, 0, ping());
    events.push(...blockEvs);
  });
  const stop = stopReasonOf(s);
  events.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: {
        stop_reason: stop,
        stop_sequence: null,
        ...(stop === "refusal" ? { stop_details: REFUSAL_DETAILS } : {}),
      },
      usage: finalUsage(s, deltaUsage(usage, webSearches(s))),
    },
  });
  events.push({ event: "message_stop", data: { type: "message_stop" } });

  if (s.type === "slow") {
    const stallMs = s.stallMs ?? 10_000;
    const interval = s.pingIntervalMs ?? 0;
    const pings = interval > 0 ? Math.floor(stallMs / interval) : 0;
    const first = events.findIndex((e) => e.event === "content_block_delta");
    events[first] = { ...events[first]!, delayMs: stallMs - pings * interval };
    events.splice(first, 0, ...Array.from({ length: pings }, () => ({ ...ping(), delayMs: interval })));
  }
  return { events, ending: "end" };
}

/** Non-streaming Message JSON for a success scenario. */
export function buildMessage(s: SuccessScenario, ctx: BuildContext): Json {
  const stop = stopReasonOf(s);
  return {
    id: ids.message(ctx.n),
    type: "message",
    role: "assistant",
    model: s.model ?? ctx.model,
    content: blocksOf(s, ctx.n).map(contentOf),
    stop_reason: stop,
    stop_sequence: null,
    stop_details: stop === "refusal" ? REFUSAL_DETAILS : null,
    usage: finalUsage(s, messageUsage(scenarioUsage(s), webSearches(s))),
  };
}

export function timingOf(s: Scenario): Required<Timing> {
  const inherited = isMidStream(s)
    ? timingOf(s.base ?? { type: "text" })
    : { headersDelayMs: 0, chunkDelayMs: s.type === "slow" ? 1000 : 0 };
  return {
    headersDelayMs: s.headersDelayMs ?? inherited.headersDelayMs,
    chunkDelayMs: s.chunkDelayMs ?? inherited.chunkDelayMs,
  };
}

/** Time the stream takes after the headers; a non-streaming response waits this long too. */
export function planDurationMs(plan: StreamPlan, chunkDelayMs: number): number {
  return plan.events.reduce((sum, e, i) => sum + (e.delayMs ?? (i === 0 ? 0 : chunkDelayMs)), 0);
}

export interface FinalUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  ephemeral_5m_input_tokens: number;
  ephemeral_1h_input_tokens: number;
  web_search_requests: number;
  thinking_tokens: number | undefined;
}

/**
 * The last usage the provider reports: the final message_delta for complete scenarios, message_start for
 * error_mid_stream / drop_mid_stream (output_tokens = initial_output_tokens), null for HTTP errors.
 */
export function expectedUsage(s: Scenario): FinalUsage | null {
  if (s.type === "error_before_first_token") return null;
  const base = isMidStream(s) ? (s.base ?? { type: "text" }) : s;
  const u = scenarioUsage(base);
  const complete = !isMidStream(s);
  return {
    input_tokens: u.input_tokens,
    output_tokens: complete ? u.output_tokens : u.initial_output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens,
    cache_creation_input_tokens: cacheCreationTokens(u),
    ephemeral_5m_input_tokens: u.ephemeral_5m_input_tokens,
    ephemeral_1h_input_tokens: u.ephemeral_1h_input_tokens,
    web_search_requests: complete ? webSearches(base) : 0,
    thinking_tokens: complete ? u.thinking_tokens : undefined,
  };
}

/** count_tokens estimate: ceil(len(JSON.stringify(messages) + system) / 4). */
export function estimateInputTokens(body: unknown): number {
  const { messages, system } = (body ?? {}) as { messages?: unknown; system?: unknown };
  const systemText = system === undefined ? "" : typeof system === "string" ? system : JSON.stringify(system);
  return Math.ceil(((messages === undefined ? "" : JSON.stringify(messages)) + systemText).length / 4);
}
