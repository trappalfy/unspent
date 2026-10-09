// Anthropic Messages SSE -> OpenAI `chat.completion.chunk` SSE (brief 8.8).
// Pure state machine: the gateway parses upstream events, pushes them in order and writes the returned
// strings to the client as they come. It keeps its own usage accounting and hands the totals to finish().

import {
  type AnthropicUsage,
  anthropicErrorStatus,
  anthropicErrorToOpenAI,
  type ChatUsage,
  type FinishReason,
  mapFinishReason,
  mapUsage,
  type OpenAIError,
  type UnspentInfo,
} from "./translate";

export interface AnthropicStreamEvent {
  /** SSE `event:` name (message_start, content_block_delta, ...). */
  event: string;
  /** Parsed JSON from the SSE `data:` line. */
  data: unknown;
}

export interface ChunkToolCall {
  index: number;
  id?: string;
  type?: "function";
  function: { name?: string; arguments: string };
}

export interface ChunkDelta {
  role?: "assistant";
  content?: string;
  tool_calls?: ChunkToolCall[];
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{ index: 0; delta: ChunkDelta; logprobs: null; finish_reason: FinishReason | null }>;
  usage?: ChatUsage | null;
  unspent?: UnspentInfo;
}

export interface StreamTranslatorOptions {
  /** Model id as the client sent it. */
  model: string;
  /** `stream_options.include_usage` from the request. */
  includeUsage: boolean;
  /** Unix seconds for every chunk's `created`; defaults to now. */
  created?: number;
}

export interface StreamTranslator {
  /** Consumes one upstream event; returns zero or more SSE strings for the client. */
  push(event: AnthropicStreamEvent): string[];
  /** Final chunk (`choices: []`, `unspent`, plus `usage` when requested) and `data: [DONE]`. */
  finish(unspent: UnspentInfo, usage: AnthropicUsage): string[];
  /** Ends the stream with an OpenAI-format error line and `data: [DONE]` (e.g. upstream dropped). */
  fail(error: OpenAIError): string[];
  /** True once [DONE] has been produced; later calls return nothing. */
  readonly done: boolean;
}

export const SSE_DONE = "data: [DONE]\n\n";

export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

type BlockState =
  | { kind: "text" }
  | { kind: "tool"; toolIndex: number; argsSent: boolean; startInput: unknown }
  | { kind: "other" };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function createStreamTranslator(opts: StreamTranslatorOptions): StreamTranslator {
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  // Replaced by the Anthropic message id on message_start, which always comes first.
  let id = `chatcmpl-${created}`;
  let started = false;
  let finishSent = false;
  let done = false;
  let toolCount = 0;
  const blocks = new Map<number, BlockState>();

  const chunk = (delta: ChunkDelta, finishReason: FinishReason | null = null): string => {
    const c: ChatCompletionChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model: opts.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    };
    // OpenAI: with include_usage every chunk but the last carries `usage: null`.
    if (opts.includeUsage) c.usage = null;
    return sseData(c);
  };

  const start = (out: string[]): void => {
    if (started) return;
    started = true;
    out.push(chunk({ role: "assistant", content: "" }));
  };

  const fail = (error: OpenAIError): string[] => {
    if (done) return [];
    done = true;
    return [sseData(error), SSE_DONE];
  };

  const push = (ev: AnthropicStreamEvent): string[] => {
    if (done) return [];
    const data = isObject(ev.data) ? ev.data : {};
    const type =
      ev.event && ev.event !== "message" ? ev.event : typeof data.type === "string" ? data.type : "";
    const out: string[] = [];

    switch (type) {
      case "message_start": {
        const msg = data.message;
        if (isObject(msg) && typeof msg.id === "string" && msg.id !== "") id = `chatcmpl-${msg.id}`;
        start(out);
        break;
      }

      case "content_block_start": {
        const index = Number(data.index);
        const block = isObject(data.content_block) ? data.content_block : {};
        if (block.type === "text") {
          blocks.set(index, { kind: "text" });
          if (typeof block.text === "string" && block.text !== "") {
            start(out);
            out.push(chunk({ content: block.text }));
          }
        } else if (block.type === "tool_use") {
          const toolIndex = toolCount++;
          blocks.set(index, { kind: "tool", toolIndex, argsSent: false, startInput: block.input });
          start(out);
          out.push(
            chunk({
              tool_calls: [
                {
                  index: toolIndex,
                  id: String(block.id),
                  type: "function",
                  function: { name: String(block.name), arguments: "" },
                },
              ],
            }),
          );
        } else {
          // thinking, redacted_thinking and anything else the OpenAI format has no place for.
          blocks.set(index, { kind: "other" });
        }
        break;
      }

      case "content_block_delta": {
        const state = blocks.get(Number(data.index));
        const delta = isObject(data.delta) ? data.delta : {};
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
          start(out);
          out.push(chunk({ content: delta.text }));
        } else if (
          delta.type === "input_json_delta" &&
          state?.kind === "tool" &&
          typeof delta.partial_json === "string" &&
          delta.partial_json !== ""
        ) {
          state.argsSent = true;
          out.push(
            chunk({ tool_calls: [{ index: state.toolIndex, function: { arguments: delta.partial_json } }] }),
          );
        }
        // thinking_delta, signature_delta, citations_delta: nothing.
        break;
      }

      case "content_block_stop": {
        const state = blocks.get(Number(data.index));
        // A call without arguments streams no JSON; clients still expect parseable `arguments`.
        if (state?.kind === "tool" && !state.argsSent) {
          state.argsSent = true;
          const args = isObject(state.startInput) ? JSON.stringify(state.startInput) : "{}";
          out.push(chunk({ tool_calls: [{ index: state.toolIndex, function: { arguments: args } }] }));
        }
        break;
      }

      case "message_delta": {
        const delta = isObject(data.delta) ? data.delta : {};
        if (typeof delta.stop_reason === "string" && !finishSent) {
          finishSent = true;
          start(out);
          out.push(chunk({}, mapFinishReason(delta.stop_reason)));
        }
        break;
      }

      case "error": {
        const err = isObject(data.error) ? data.error : {};
        return fail(anthropicErrorToOpenAI(anthropicErrorStatus(err.type), data));
      }

      default:
        // message_stop, ping and future event types.
        break;
    }
    return out;
  };

  const finish = (unspent: UnspentInfo, usage: AnthropicUsage): string[] => {
    if (done) return [];
    done = true;
    const last: ChatCompletionChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model: opts.model,
      choices: [],
    };
    if (opts.includeUsage) last.usage = mapUsage(usage);
    last.unspent = unspent;
    return [sseData(last), SSE_DONE];
  };

  return {
    push,
    finish,
    fail,
    get done() {
      return done;
    },
  };
}
