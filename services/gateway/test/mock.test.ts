import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildStreamPlan,
  DEFAULT_THINKING,
  DEFAULT_TOOLS,
  ERROR_DEFAULTS,
  type ErrorStatus,
  estimateInputTokens,
  expectedUsage,
  MOCK_MODELS,
  type MockAnthropic,
  parseSse,
  type Scenario,
  startMockAnthropic,
} from "./mock/mockAnthropic";

let mock: MockAnthropic;
beforeAll(async () => {
  mock = await startMockAnthropic();
});
afterAll(() => mock.close());
beforeEach(() => {
  mock.requests.length = 0;
  mock.setScenario({ type: "text" });
});

const BODY = { model: "claude-opus-5-5", max_tokens: 1024, messages: [{ role: "user", content: "Hello" }] };
const CHUNKS = ["Hi", " there", ",", " friend", "."];

function post(body: unknown, path = "/v1/messages", target: MockAnthropic = mock): Promise<Response> {
  return fetch(target.url + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2023-06-01",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
const json = (res: Response): Promise<any> => res.json();

// biome-ignore lint/suspicious/noExplicitAny: SSE payloads are checked field by field
type TimedEvent = { event: string; data: any; at: number };

/** Reads the whole body chunk by chunk, timestamping each event when its bytes arrive. Never throws. */
async function readSse(res: Response, onEvent?: (e: TimedEvent) => void) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: TimedEvent[] = [];
  let text = "";
  let reads = 0;
  let error: unknown;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      reads++;
      text += decoder.decode(value, { stream: true });
      const at = performance.now();
      for (const e of parseSse(text).slice(events.length)) {
        events.push({ ...e, at });
        onEvent?.({ ...e, at });
      }
    }
  } catch (e) {
    error = e;
  }
  return { text, events, reads, error };
}

const names = (events: { event: string }[]) => events.map((e) => e.event);
const deltaTypes = (events: TimedEvent[]) =>
  events.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.type);
const textOf = (events: TimedEvent[]) =>
  events
    .filter((e) => e.data.delta?.type === "text_delta")
    .map((e) => e.data.delta.text)
    .join("");

const DEFAULT_START_USAGE = {
  input_tokens: 120,
  cache_creation_input_tokens: 768,
  cache_read_input_tokens: 2048,
  cache_creation: { ephemeral_5m_input_tokens: 512, ephemeral_1h_input_tokens: 256 },
  output_tokens: 1,
  service_tier: "standard",
  inference_geo: "global",
};

describe("text", () => {
  it("streams the documented event sequence with exact wire format and headers", async () => {
    mock.setScenario({ type: "text", chunks: CHUNKS });
    const res = await post({ ...BODY, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("request-id")).toMatch(/^req_mock_\d+$/);
    expect(res.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed");

    const { text, events, error } = await readSse(res);
    expect(error).toBeUndefined();
    expect(names(events)).toEqual([
      "message_start",
      "content_block_start",
      "ping",
      ...CHUNKS.map(() => "content_block_delta"),
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // Every event is exactly `event: <type>\ndata: <one-line json>\n\n`, and data.type matches the event name.
    expect(text).toMatch(/^(event: [a-z_]+\ndata: \{[^\n]*\}\n\n)+$/);
    expect(text.split("\n\n").length - 1).toBe(events.length);
    for (const e of events) expect(e.data.type).toBe(e.event);
    expect(text).toContain('event: ping\ndata: {"type": "ping"}\n\n');

    const start = events[0]!.data.message;
    expect(start).toEqual({
      id: expect.stringMatching(/^msg_mock_\d+$/),
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: DEFAULT_START_USAGE,
    });
    expect(events[1]!.data).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    expect(events[3]!.data).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hi" },
    });
    expect(textOf(events)).toBe(CHUNKS.join(""));
    expect(events.at(-2)!.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: {
        input_tokens: 120,
        cache_creation_input_tokens: 768,
        cache_read_input_tokens: 2048,
        output_tokens: 48,
      },
    });
    expect(events.at(-1)!.data).toEqual({ type: "message_stop" });
    expect(expectedUsage({ type: "text" })).toEqual({
      input_tokens: 120,
      output_tokens: 48,
      cache_read_input_tokens: 2048,
      cache_creation_input_tokens: 768,
      ephemeral_5m_input_tokens: 512,
      ephemeral_1h_input_tokens: 256,
      web_search_requests: 0,
      thinking_tokens: undefined,
    });
  });

  it("reports configured usage numbers", async () => {
    const scenario: Scenario = {
      type: "text",
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 9,
        initial_output_tokens: 2,
      },
    };
    mock.setScenario(scenario);
    const { events } = await readSse(await post({ ...BODY, stream: true }));
    expect(events[0]!.data.message.usage).toMatchObject({
      input_tokens: 7,
      cache_creation_input_tokens: 9,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 9 },
      output_tokens: 2,
    });
    expect(events.at(-2)!.data.usage).toEqual({
      input_tokens: 7,
      cache_creation_input_tokens: 9,
      cache_read_input_tokens: 0,
      output_tokens: 3,
    });
    expect(expectedUsage(scenario)).toMatchObject({
      input_tokens: 7,
      output_tokens: 3,
      cache_creation_input_tokens: 9,
    });
  });

  it("returns a full Message as JSON when stream is falsy", async () => {
    mock.setScenario({ type: "text", chunks: CHUNKS, model: "claude-sonnet-5-5" });
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed");
    expect(await json(res)).toEqual({
      id: expect.stringMatching(/^msg_mock_\d+$/),
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text: "Hi there, friend." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: null,
      usage: { ...DEFAULT_START_USAGE, output_tokens: 48 },
    });
  });

  it("writes each event separately with chunkDelayMs between them", async () => {
    mock.setScenario({ type: "text", chunks: CHUNKS, chunkDelayMs: 30 });
    const { events, reads } = await readSse(await post({ ...BODY, stream: true }));
    expect(events).toHaveLength(11);
    expect(reads).toBeGreaterThanOrEqual(events.length);
    expect(events.at(-1)!.at - events[0]!.at).toBeGreaterThanOrEqual(10 * 30 - 20);
  });

  it("delays the headers by headersDelayMs", async () => {
    mock.setScenario({ type: "text", headersDelayMs: 150 });
    const t0 = performance.now();
    const res = await post({ ...BODY, stream: true });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(140);
    await readSse(res);
  });
});

describe("thinking", () => {
  it("streams thinking_delta then signature_delta, then the text block", async () => {
    mock.setScenario({ type: "thinking" });
    const { events } = await readSse(await post({ ...BODY, stream: true }));
    expect(names(events)).toEqual([
      "message_start",
      "content_block_start",
      "ping",
      ...DEFAULT_THINKING.map(() => "content_block_delta"),
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[1]!.data.content_block).toEqual({ type: "thinking", thinking: "", signature: "" });
    expect(deltaTypes(events)).toEqual([
      ...DEFAULT_THINKING.map(() => "thinking_delta"),
      "signature_delta",
      "text_delta",
      "text_delta",
    ]);
    const signatureAt = events.findIndex((e) => e.data.delta?.type === "signature_delta");
    expect(events[signatureAt + 1]!.data).toEqual({ type: "content_block_stop", index: 0 });
    expect(events[signatureAt + 2]!.data.index).toBe(1);
    expect(events.at(-2)!.data.usage).toEqual({
      input_tokens: 120,
      cache_creation_input_tokens: 768,
      cache_read_input_tokens: 2048,
      output_tokens: 180,
      output_tokens_details: { thinking_tokens: 120 },
    });
  });

  it("omitted display streams one empty thinking_delta before the signature", async () => {
    mock.setScenario({ type: "thinking", display: "omitted" });
    const { events } = await readSse(await post({ ...BODY, stream: true }));
    const thinking = events.filter((e) => e.data.index === 0 && e.event === "content_block_delta");
    expect(thinking.map((e) => e.data.delta)).toEqual([
      { type: "thinking_delta", thinking: "" },
      { type: "signature_delta", signature: expect.any(String) },
    ]);
  });

  it("non-stream Message has a thinking block with signature followed by text", async () => {
    mock.setScenario({ type: "thinking", thinking: ["a", "b"], signature: "sig", chunks: ["ok"] });
    const msg = await json(await post(BODY));
    expect(msg.content).toEqual([
      { type: "thinking", thinking: "ab", signature: "sig" },
      { type: "text", text: "ok" },
    ]);
    expect(msg.usage.output_tokens_details).toEqual({ thinking_tokens: 120 });
  });
});

describe("tool_use", () => {
  it("streams text then a tool_use block whose partial JSON reassembles to the input", async () => {
    mock.setScenario({ type: "tool_use" });
    const { events } = await readSse(await post({ ...BODY, stream: true }));
    const start = events.find((e) => e.event === "content_block_start" && e.data.index === 1)!;
    expect(start.data.content_block).toEqual({
      type: "tool_use",
      id: expect.stringMatching(/^toolu_[a-zA-Z0-9_-]+$/),
      name: "get_weather",
      input: {},
    });
    const partials = events
      .filter((e) => e.data.delta?.type === "input_json_delta")
      .map((e) => e.data.delta.partial_json as string);
    expect(partials[0]).toBe("");
    expect(partials.length).toBeGreaterThan(3);
    expect(JSON.parse(partials.join(""))).toEqual(DEFAULT_TOOLS[0]!.input);
    expect(events.at(-2)!.data.delta.stop_reason).toBe("tool_use");
    expect(events.at(-2)!.data.usage.output_tokens).toBe(89);
  });

  it("non-stream Message carries the parsed input", async () => {
    mock.setScenario({ type: "tool_use", tools: [{ name: "add", input: { a: 1, b: [2, 3] } }] });
    const msg = await json(await post(BODY));
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content[1]).toEqual({
      type: "tool_use",
      id: expect.stringMatching(/^toolu_/),
      name: "add",
      input: { a: 1, b: [2, 3] },
    });
  });
});

describe("web_search", () => {
  it("streams server_tool_use + web_search_tool_result pairs and counts them in usage", async () => {
    mock.setScenario({ type: "web_search", searches: 2 });
    const { events } = await readSse(await post({ ...BODY, stream: true }));
    const blocks = events.filter((e) => e.event === "content_block_start").map((e) => e.data.content_block);
    expect(blocks.map((b) => b.type)).toEqual([
      "text",
      "server_tool_use",
      "web_search_tool_result",
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ]);
    expect(blocks[1].id).toMatch(/^srvtoolu_[a-zA-Z0-9_]+$/);
    expect(blocks[2].tool_use_id).toBe(blocks[1].id);
    expect(blocks[2].content[0]).toMatchObject({ type: "web_search_result", url: expect.any(String) });
    expect(deltaTypes(events)).toContain("citations_delta");
    expect(events.at(-2)!.data.usage).toEqual({
      input_tokens: 10682,
      cache_creation_input_tokens: 768,
      cache_read_input_tokens: 2048,
      output_tokens: 510,
      server_tool_use: { web_search_requests: 2 },
    });
    expect(expectedUsage({ type: "web_search", searches: 2 })!.web_search_requests).toBe(2);
  });

  it("non-stream Message includes the search blocks and server_tool_use usage", async () => {
    mock.setScenario({ type: "web_search", searches: 3 });
    const msg = await json(await post(BODY));
    expect(msg.content.filter((b: { type: string }) => b.type === "web_search_tool_result")).toHaveLength(3);
    expect(msg.content.at(-1).citations[0].type).toBe("web_search_result_location");
    expect(msg.usage.server_tool_use).toEqual({ web_search_requests: 3, web_fetch_requests: 0 });
  });
});

describe("error_before_first_token", () => {
  const statuses: ErrorStatus[] = [400, 401, 403, 413, 422, 429, 500, 529];
  it.each(statuses)("HTTP %i with the API error body and headers, even for stream: true", async (status) => {
    mock.setScenario({ type: "error_before_first_token", status });
    const res = await post({ ...BODY, stream: true });
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toBe("application/json");
    const requestId = res.headers.get("request-id");
    expect(requestId).toMatch(/^req_mock_\d+$/);
    expect(await json(res)).toEqual({
      type: "error",
      error: { type: ERROR_DEFAULTS[status].type, message: ERROR_DEFAULTS[status].message },
      request_id: requestId,
    });
    expect(res.headers.get("retry-after")).toBe(status === 429 ? "30" : status === 529 ? "5" : null);
    expect(res.headers.get("x-should-retry")).toBe(String(status >= 429));
    expect(res.headers.get("anthropic-ratelimit-unified-status")).toBe(status === 429 ? "rejected" : null);
    if (status === 429) {
      expect(res.headers.get("anthropic-ratelimit-unified-reset")).toMatch(/^\d+$/);
      expect(res.headers.get("anthropic-ratelimit-requests-remaining")).toBe("0");
    }
  });

  it("supports custom type, message, retry-after and also fails count_tokens", async () => {
    mock.setScenario({
      type: "error_before_first_token",
      status: 429,
      message: "monthly cap",
      retryAfter: null,
      shouldRetry: false,
    });
    const res = await post(BODY);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(res.headers.get("x-should-retry")).toBe("false");
    expect((await json(res)).error).toEqual({ type: "rate_limit_error", message: "monthly cap" });
    const counted = await post(BODY, "/v1/messages/count_tokens");
    expect(counted.status).toBe(429);
    await counted.body?.cancel();
  });
});

describe("error_mid_stream", () => {
  it("starts normally, then sends an error event and ends the stream cleanly", async () => {
    mock.setScenario({ type: "error_mid_stream" });
    const { text, events, error } = await readSse(await post({ ...BODY, stream: true }));
    expect(error).toBeUndefined();
    expect(names(events)).toEqual([
      "message_start",
      "content_block_start",
      "ping",
      "content_block_delta",
      "content_block_delta",
      "error",
    ]);
    expect(
      text.endsWith(
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      ),
    ).toBe(true);
    expect(expectedUsage({ type: "error_mid_stream" })!.output_tokens).toBe(1);
  });

  it("maps to the matching HTTP error for non-stream requests", async () => {
    mock.setScenario({ type: "error_mid_stream", errorType: "api_error", message: "boom" });
    const res = await post(BODY);
    expect(res.status).toBe(500);
    expect((await json(res)).error).toEqual({ type: "api_error", message: "boom" });
  });
});

describe("drop_mid_stream", () => {
  it("sends some deltas, then destroys the socket without message_delta/message_stop", async () => {
    mock.setScenario({ type: "drop_mid_stream", chunkDelayMs: 5 });
    const { events, error } = await readSse(await post({ ...BODY, stream: true }));
    expect(error).toBeDefined();
    expect(names(events)).toEqual([
      "message_start",
      "content_block_start",
      "ping",
      "content_block_delta",
      "content_block_delta",
    ]);
    expect(mock.requests[0]!.clientAborted).toBe(false);
    expect(mock.requests[0]!.finishedAt).toBeNull();
  });

  it("can cut a thinking stream mid-thinking", async () => {
    mock.setScenario({ type: "drop_mid_stream", base: { type: "thinking" }, afterEvents: 4 });
    const { events, error } = await readSse(await post({ ...BODY, stream: true }));
    expect(error).toBeDefined();
    expect(deltaTypes(events)).toEqual(["thinking_delta"]);
  });

  it("drops a non-stream request without any response", async () => {
    mock.setScenario({ type: "drop_mid_stream" });
    await expect(post(BODY)).rejects.toThrow();
  });
});

describe("slow", () => {
  it("stalls before the first delta, pinging during the stall", async () => {
    mock.setScenario({ type: "slow", chunkDelayMs: 5, stallMs: 300, pingIntervalMs: 100 });
    const { events } = await readSse(await post({ ...BODY, stream: true }));
    expect(names(events).slice(0, 7)).toEqual([
      "message_start",
      "content_block_start",
      "ping",
      "ping",
      "ping",
      "ping",
      "content_block_delta",
    ]);
    expect(events[6]!.at - events[2]!.at).toBeGreaterThanOrEqual(280);
    expect(events.at(-1)!.event).toBe("message_stop");
  });

  it("non-stream waits as long as the stream would", async () => {
    mock.setScenario({ type: "slow", chunkDelayMs: 10, stallMs: 200, chunks: ["a", "b"] });
    const t0 = performance.now();
    const msg = await json(await post(BODY));
    expect(performance.now() - t0).toBeGreaterThanOrEqual(200 + 6 * 10 - 20);
    expect(msg.content).toEqual([{ type: "text", text: "ab" }]);
  });
});

describe("unknown_usage_field", () => {
  it("adds an unexpected non-zero field to the final usage", async () => {
    mock.setScenario({ type: "unknown_usage_field" });
    const { events } = await readSse(await post({ ...BODY, stream: true }));
    expect(events.at(-2)!.data.usage).toEqual({
      input_tokens: 120,
      cache_creation_input_tokens: 768,
      cache_read_input_tokens: 2048,
      output_tokens: 48,
      server_tool_use: { code_execution_requests: 2 },
    });
    expect(events[0]!.data.message.usage).toEqual(DEFAULT_START_USAGE);
    const msg = await json(await post(BODY));
    expect(msg.usage.server_tool_use).toEqual({ code_execution_requests: 2 });
  });
});

describe("recording and other routes", () => {
  it("records method, path with query, headers and the raw body byte for byte", async () => {
    const raw =
      '{ "model":"claude-opus-5-5",\n  "max_tokens": 16, "messages":[{"role":"user","content":"héllo ✓ \\u00e9"}] }';
    const res = await post(raw, "/v1/messages?beta=true");
    expect(res.status).toBe(200);
    await res.text();
    const rec = mock.requests[0]!;
    expect(rec.method).toBe("POST");
    expect(rec.path).toBe("/v1/messages?beta=true");
    expect(rec.body).toBe(raw);
    expect(rec.json.messages[0].content).toBe("héllo ✓ é");
    expect(rec.headers["x-api-key"]).toBe("sk-ant-test");
    expect(rec.headers["anthropic-version"]).toBe("2023-06-01");
    expect(rec.receivedAt).toBeGreaterThan(Date.now() - 5000);
    await expect.poll(() => rec.finishedAt).not.toBeNull();
    expect(rec.clientAborted).toBe(false);
  });

  it("count_tokens estimates from messages + system unless the scenario overrides", async () => {
    const body = { ...BODY, system: "Be brief." };
    const res = await post(body, "/v1/messages/count_tokens");
    expect(res.headers.get("content-type")).toBe("application/json");
    const expected = Math.ceil((JSON.stringify(body.messages) + body.system).length / 4);
    expect(await json(res)).toEqual({ input_tokens: expected });
    expect(estimateInputTokens(body)).toBe(expected);

    mock.setScenario({ type: "text", countTokens: 4242 });
    expect(await json(await post(BODY, "/v1/messages/count_tokens"))).toEqual({ input_tokens: 4242 });
    expect(mock.requests.map((r) => r.path)).toEqual([
      "/v1/messages/count_tokens",
      "/v1/messages/count_tokens",
    ]);
  });

  it("lists models in the Anthropic list format with pagination", async () => {
    const res = await fetch(`${mock.url}/v1/models`);
    expect(res.headers.get("request-id")).toMatch(/^req_mock_\d+$/);
    const list = await json(res);
    expect(list.data.map((m: { id: string }) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
    ]);
    expect(list).toMatchObject({ has_more: false, first_id: "claude-opus-5-5", last_id: "claude-fable-5-1" });
    for (const m of list.data) {
      expect(m).toMatchObject({
        type: "model",
        id: expect.any(String),
        display_name: expect.stringMatching(/^Claude /),
        created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
      });
    }
    expect(await json(await fetch(`${mock.url}/v1/models?limit=2`))).toMatchObject({
      has_more: true,
      first_id: "claude-opus-5-5",
      last_id: "claude-sonnet-5-5",
    });
    const next = await json(await fetch(`${mock.url}/v1/models?limit=2&after_id=claude-sonnet-5-5`));
    expect(next).toMatchObject({
      has_more: false,
      first_id: "claude-haiku-5-5",
      last_id: "claude-fable-5-1",
    });
    expect(await json(await fetch(`${mock.url}/v1/models/claude-haiku-5-5`))).toEqual(MOCK_MODELS[2]);
    const missing = await fetch(`${mock.url}/v1/models/claude-nope`);
    expect(missing.status).toBe(404);
    expect((await json(missing)).error.type).toBe("not_found_error");
    expect(mock.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v1/models",
      "GET /v1/models?limit=2",
      "GET /v1/models?limit=2&after_id=claude-sonnet-5-5",
      "GET /v1/models/claude-haiku-5-5",
      "GET /v1/models/claude-nope",
    ]);
  });

  it("picks the scenario per request when given a function", async () => {
    mock.setScenario((req) =>
      req.json.model === "claude-haiku-5-5"
        ? { type: "error_before_first_token", status: 401 }
        : { type: "text" },
    );
    expect((await post({ ...BODY, model: "claude-haiku-5-5" })).status).toBe(401);
    const ok = await post(BODY);
    expect(ok.status).toBe(200);
    expect((await json(ok)).model).toBe("claude-opus-5-5");
  });

  it("numbers request and message ids from 1 on a fresh mock", async () => {
    const fresh = await startMockAnthropic();
    try {
      const res = await post(BODY, "/v1/messages", fresh);
      expect(res.headers.get("request-id")).toBe("req_mock_1");
      expect((await json(res)).id).toBe("msg_mock_1");
    } finally {
      await fresh.close();
    }
  });

  it("marks a request the client aborted mid-stream and stops writing", async () => {
    mock.setScenario({ type: "text", chunkDelayMs: 50 });
    const ac = new AbortController();
    const res = await fetch(`${mock.url}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ ...BODY, stream: true }),
      signal: ac.signal,
    });
    const { events } = await readSse(res, () => ac.abort());
    expect(events).toHaveLength(1);
    await expect.poll(() => mock.requests[0]!.clientAborted).toBe(true);
    expect(mock.requests[0]!.finishedAt).toBeNull();
  });

  it("close() ends in-flight streams", async () => {
    const fresh = await startMockAnthropic();
    fresh.setScenario({ type: "slow", chunkDelayMs: 10, stallMs: 60_000 });
    const res = await post({ ...BODY, stream: true }, "/v1/messages", fresh);
    let pinged!: () => void;
    const gotPing = new Promise<void>((resolve) => {
      pinged = resolve;
    });
    const reading = readSse(res, (e) => e.event === "ping" && pinged());
    await gotPing;
    const t0 = performance.now();
    await fresh.close();
    expect(performance.now() - t0).toBeLessThan(1000);
    const { events, error } = await reading;
    expect(error).toBeDefined();
    expect(names(events)).toEqual(["message_start", "content_block_start", "ping"]);
  });

  it("plan builders match what the server streams", async () => {
    const scenario: Scenario = { type: "tool_use", tools: [{ name: "x", input: { q: "y" } }] };
    mock.setScenario(scenario);
    const { events } = await readSse(await post({ ...BODY, stream: true }));
    const n = Number(events[0]!.data.message.id.split("_").at(-1));
    const plan = buildStreamPlan(scenario, { n, model: "claude-opus-5-5" });
    expect(events.map(({ event, data }) => ({ event, data }))).toEqual(
      plan.events.map(({ event, data }) => ({ event, data })),
    );
  });
});
