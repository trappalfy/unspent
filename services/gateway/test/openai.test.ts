import { describe, expect, it, vi } from "vitest";
import {
  type AnthropicMessage,
  type AnthropicStreamEvent,
  anthropicErrorStatus,
  anthropicErrorToOpenAI,
  createStreamTranslator,
  IGNORED_FIELDS,
  mapFinishReason,
  openaiError,
  type StreamTranslator,
  translateRequest,
  translateResponse,
  type UnspentInfo,
} from "../src/openai";

const MODEL = "claude-sonnet-5-5";
const UNSPENT: UnspentInfo = { request_id: "req_1", credits_charged: "0.0123", available: "9.98" };
const CREATED = 1_700_000_000;
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function ok(body: Record<string, unknown>) {
  const r = translateRequest({ model: MODEL, ...body });
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r;
}

function bad(body: unknown) {
  const r = translateRequest(body);
  if (r.ok) throw new Error("expected a 400");
  expect(r.status).toBe(400);
  expect(r.error.error.type).toBe("invalid_request_error");
  return r.error.error;
}

const user = (content: unknown) => ({ role: "user", content });
const text = (t: string) => ({ type: "text", text: t });

// ---------------------------------------------------------------------------------------------------------

describe("translateRequest: basics", () => {
  it("translates a plain text chat with defaults", () => {
    const r = ok({ messages: [user("Hi")] });
    expect(r).toEqual({
      ok: true,
      messages: { model: MODEL, max_tokens: 4096, messages: [{ role: "user", content: [text("Hi")] }] },
      stream: false,
      includeUsage: false,
      ignored: [],
    });
    expect(r.messages).not.toHaveProperty("system");
    expect(r.messages).not.toHaveProperty("stream");
  });

  it("passes the model through unchanged", () => {
    const r = translateRequest({ model: "claude-opus-5-5", messages: [user("x")] });
    expect(r.ok && r.messages.model).toBe("claude-opus-5-5");
  });

  it("joins system and developer messages from anywhere in the list with \\n", () => {
    const r = ok({
      messages: [
        { role: "system", content: "You are terse." },
        { role: "developer", content: [text("Rule one."), text("Rule two.")] },
        user("Hi"),
        { role: "assistant", content: "Hello." },
        { role: "system", content: "Late note." },
        { role: "system", content: "" },
        user("Bye"),
      ],
    });
    expect(r.messages.system).toBe("You are terse.\nRule one.\nRule two.\nLate note.");
    expect(r.messages.messages).toEqual([
      { role: "user", content: [text("Hi")] },
      { role: "assistant", content: [text("Hello.")] },
      { role: "user", content: [text("Bye")] },
    ]);
  });

  it("rejects non-text parts in system messages", () => {
    const e = bad({
      model: MODEL,
      messages: [{ role: "system", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }],
    });
    expect(e.message).toContain("messages[0].content[0]");
  });

  it("merges consecutive same-role messages and drops empty text parts", () => {
    const r = ok({
      messages: [
        user("one"),
        user([text("two"), text("")]),
        { role: "assistant", content: "a" },
        { role: "assistant", content: [text("b"), { type: "refusal", refusal: "no" }] },
        { role: "assistant", content: null },
        user("three"),
      ],
    });
    expect(r.messages.messages).toEqual([
      { role: "user", content: [text("one"), text("two")] },
      { role: "assistant", content: [text("a"), text("b"), text("no")] },
      { role: "user", content: [text("three")] },
    ]);
  });

  it("validates the request shape", () => {
    expect(bad(null).code).toBe("invalid_request");
    expect(bad([]).code).toBe("invalid_request");
    expect(bad({ messages: [user("x")] }).message).toContain("model");
    expect(bad({ model: MODEL }).message).toContain("messages");
    expect(bad({ model: MODEL, messages: [] }).message).toContain("messages");
    expect(bad({ model: MODEL, messages: ["hi"] }).message).toBe("messages[0] must be an object.");
    expect(bad({ model: MODEL, messages: [{ role: "robot", content: "x" }] }).message).toContain(
      "messages[0].role",
    );
    expect(bad({ model: MODEL, messages: [user("")] }).message).toBe(
      "messages[0].content must not be empty.",
    );
    expect(bad({ model: MODEL, messages: [user(null)] }).message).toBe("messages[0].content is required.");
    expect(bad({ model: MODEL, messages: [{ role: "system", content: "only system" }] }).message).toContain(
      "at least one",
    );
    expect(bad({ model: MODEL, messages: [user([{ type: "input_audio" }])] }).code).toBe(
      "unsupported_parameter",
    );
    expect(bad({ model: MODEL, messages: [user("x")], stream: "yes" }).message).toBe(
      "'stream' must be a boolean.",
    );
  });

  it("returns errors in the OpenAI format", () => {
    expect(translateRequest({ model: MODEL, messages: [user("x")], n: 3 })).toEqual({
      ok: false,
      status: 400,
      error: {
        error: {
          message: "Only n=1 is supported for Claude models.",
          type: "invalid_request_error",
          code: "unsupported_parameter",
        },
      },
    });
  });

  it("rejects legacy function calling", () => {
    expect(bad({ model: MODEL, messages: [user("x")], functions: [{ name: "f" }] }).code).toBe(
      "unsupported_parameter",
    );
    expect(bad({ model: MODEL, messages: [user("x")], function_call: "auto" }).code).toBe(
      "unsupported_parameter",
    );
    expect(bad({ model: MODEL, messages: [{ role: "function", name: "f", content: "x" }] }).code).toBe(
      "unsupported_parameter",
    );
    expect(
      bad({
        model: MODEL,
        messages: [
          user("x"),
          { role: "assistant", content: null, function_call: { name: "f", arguments: "{}" } },
        ],
      }).code,
    ).toBe("unsupported_parameter");
  });
});

describe("translateRequest: images", () => {
  it("turns a base64 data URL into a base64 image block", () => {
    const r = ok({
      messages: [
        user([
          text("What is this?"),
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}`, detail: "high" } },
          { type: "image_url", image_url: { url: "data:image/jpg;base64,AAAA" } },
        ]),
      ],
    });
    expect(r.messages.messages[0]!.content).toEqual([
      text("What is this?"),
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
    ]);
    expect(r.ignored).toEqual([]);
  });

  it("turns an https URL into a url image block", () => {
    const r = ok({
      messages: [
        user([
          { type: "image_url", image_url: { url: "https://example.com/cat.webp" } },
          { type: "image_url", image_url: "https://example.com/dog.gif" },
        ]),
      ],
    });
    expect(r.messages.messages[0]!.content).toEqual([
      { type: "image", source: { type: "url", url: "https://example.com/cat.webp" } },
      { type: "image", source: { type: "url", url: "https://example.com/dog.gif" } },
    ]);
  });

  it("rejects other image URLs", () => {
    const img = (url: string) => ({
      model: MODEL,
      messages: [user([{ type: "image_url", image_url: { url } }])],
    });
    expect(bad(img("http://example.com/a.png")).message).toContain("https URL or a base64 data URL");
    expect(bad(img("ftp://example.com/a.png")).code).toBe("invalid_request");
    expect(bad(img("data:image/svg+xml;base64,AAAA")).message).toContain("image/svg+xml");
    expect(bad(img("data:image/png,rawbytes")).message).toContain("base64");
    expect(bad(img("data:image/png;base64,")).message).toContain("no image data");
    expect(bad(img("data:nonsense")).message).toContain("not a valid data URL");
    expect(bad({ model: MODEL, messages: [user([{ type: "image_url", image_url: {} }])] }).message).toContain(
      "image_url.url is required",
    );
  });

  it("does not accept images in assistant messages", () => {
    const e = bad({
      model: MODEL,
      messages: [
        user("x"),
        { role: "assistant", content: [{ type: "image_url", image_url: { url: "https://a/b" } }] },
      ],
    });
    expect(e.code).toBe("unsupported_parameter");
  });
});

describe("translateRequest: tools", () => {
  const weather = {
    type: "function",
    function: {
      name: "get_weather",
      description: "Weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      strict: true,
    },
  };
  const clock = { type: "function", function: { name: "get_time" } };
  const withTools = (extra: Record<string, unknown>) =>
    ok({ messages: [user("x")], tools: [weather, clock], ...extra });

  it("maps function tools to Anthropic tools", () => {
    expect(withTools({}).messages.tools).toEqual([
      {
        name: "get_weather",
        description: "Weather for a city",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
      { name: "get_time", input_schema: { type: "object", properties: {} } },
    ]);
    expect(withTools({}).messages).not.toHaveProperty("tool_choice");
    expect(ok({ messages: [user("x")], tools: [] }).messages).not.toHaveProperty("tools");
  });

  it.each([
    ["auto", { type: "auto" }],
    ["none", { type: "none" }],
    ["required", { type: "any" }],
    [
      { type: "function", function: { name: "get_weather" } },
      { type: "tool", name: "get_weather" },
    ],
  ])("maps tool_choice %j", (choice, expected) => {
    expect(withTools({ tool_choice: choice }).messages.tool_choice).toEqual(expected);
  });

  it.each([
    [undefined, { type: "auto", disable_parallel_tool_use: true }],
    ["auto", { type: "auto", disable_parallel_tool_use: true }],
    ["required", { type: "any", disable_parallel_tool_use: true }],
    [
      { type: "function", function: { name: "get_time" } },
      { type: "tool", name: "get_time", disable_parallel_tool_use: true },
    ],
    ["none", { type: "none" }],
  ])("parallel_tool_calls: false with tool_choice %j", (choice, expected) => {
    expect(withTools({ tool_choice: choice, parallel_tool_calls: false }).messages.tool_choice).toEqual(
      expected,
    );
  });

  it("parallel_tool_calls: true changes nothing", () => {
    expect(withTools({ parallel_tool_calls: true }).messages).not.toHaveProperty("tool_choice");
    expect(withTools({ tool_choice: "auto", parallel_tool_calls: true }).messages.tool_choice).toEqual({
      type: "auto",
    });
  });

  it("drops tool_choice and parallel_tool_calls when there are no tools", () => {
    const r = ok({ messages: [user("x")], tool_choice: "none", parallel_tool_calls: false });
    expect(r.messages).not.toHaveProperty("tool_choice");
    expect(r.ignored).toEqual([]);
  });

  it("validates tools and tool_choice", () => {
    const base = { model: MODEL, messages: [user("x")] };
    expect(bad({ ...base, tools: [{ type: "custom", custom: { name: "x" } }] }).code).toBe(
      "unsupported_parameter",
    );
    expect(bad({ ...base, tools: [{ type: "function", function: {} }] }).message).toBe(
      "tools[0].function.name is required.",
    );
    expect(bad({ ...base, tools: "nope" }).code).toBe("invalid_request");
    expect(bad({ ...base, tools: [weather], tool_choice: "sometimes" }).code).toBe("invalid_request");
    expect(
      bad({ ...base, tools: [weather], tool_choice: { type: "function", function: { name: "nope" } } })
        .message,
    ).toBe("'tool_choice' names unknown tool 'nope'.");
    expect(bad({ ...base, tools: [weather], tool_choice: { type: "allowed_tools" } }).code).toBe(
      "unsupported_parameter",
    );
    expect(bad({ ...base, tools: [weather], parallel_tool_calls: "no" }).code).toBe("invalid_request");
  });

  it("round-trips tool calls and tool results, merging roles", () => {
    const r = ok({
      tools: [weather, clock],
      messages: [
        { role: "system", content: "Be helpful." },
        user("Weather in Paris and the time?"),
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            {
              id: "toolu_A",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
            { id: "toolu_B", type: "function", function: { name: "get_time", arguments: "" } },
          ],
        },
        { role: "tool", tool_call_id: "toolu_A", content: "18C, sunny" },
        { role: "tool", tool_call_id: "toolu_B", content: [text("12:00")] },
        user("Thanks! Also Rome?"),
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "toolu_C",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Rome"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "toolu_C", content: "" },
      ],
    });
    expect(r.messages.system).toBe("Be helpful.");
    expect(r.messages.messages).toEqual([
      { role: "user", content: [text("Weather in Paris and the time?")] },
      {
        role: "assistant",
        content: [
          text("Let me check."),
          { type: "tool_use", id: "toolu_A", name: "get_weather", input: { city: "Paris" } },
          { type: "tool_use", id: "toolu_B", name: "get_time", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_A", content: "18C, sunny" },
          { type: "tool_result", tool_use_id: "toolu_B", content: [text("12:00")] },
          text("Thanks! Also Rome?"),
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_C", name: "get_weather", input: { city: "Rome" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_C" }] },
    ]);
  });

  it("puts tool_result blocks first in a merged user turn", () => {
    const r = ok({
      messages: [
        user("go"),
        {
          role: "assistant",
          tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        user("by the way"),
        { role: "tool", tool_call_id: "t1", content: "done" },
      ],
    });
    expect(r.messages.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }, text("by the way")],
    });
  });

  it("rejects bad tool call arguments and tool messages", () => {
    const call = (args: unknown, extra: Record<string, unknown> = {}) => ({
      model: MODEL,
      messages: [
        user("x"),
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: args }, ...extra }],
        },
      ],
    });
    expect(bad(call("{not json")).message).toBe(
      "messages[1].tool_calls[0].function.arguments is not valid JSON.",
    );
    expect(bad(call("{not json")).code).toBe("invalid_request");
    expect(bad(call("[1,2]")).message).toContain("must encode a JSON object");
    expect(bad(call("{}", { type: "custom" })).code).toBe("unsupported_parameter");
    expect(bad(call("{}", { id: "" })).message).toBe("messages[1].tool_calls[0].id is required.");
    expect(bad({ model: MODEL, messages: [user("x"), { role: "tool", content: "r" }] }).message).toBe(
      "messages[1].tool_call_id is required.",
    );
    // Arguments sent as an already-parsed object are accepted.
    const r = translateRequest(call({ a: 1 }));
    expect(r.ok && r.messages.messages[1]!.content[0]).toEqual({
      type: "tool_use",
      id: "t1",
      name: "f",
      input: { a: 1 },
    });
  });
});

describe("translateRequest: parameters", () => {
  it("maps stop to stop_sequences", () => {
    expect(ok({ messages: [user("x")], stop: "END" }).messages.stop_sequences).toEqual(["END"]);
    expect(ok({ messages: [user("x")], stop: ["a", "b", ""] }).messages.stop_sequences).toEqual(["a", "b"]);
    expect(ok({ messages: [user("x")], stop: null }).messages).not.toHaveProperty("stop_sequences");
    expect(ok({ messages: [user("x")], stop: [] }).messages).not.toHaveProperty("stop_sequences");
    expect(bad({ model: MODEL, messages: [user("x")], stop: [1] }).code).toBe("invalid_request");
  });

  it("allows only n = 1", () => {
    expect(ok({ messages: [user("x")], n: 1 }).ok).toBe(true);
    expect(ok({ messages: [user("x")], n: null }).ok).toBe(true);
    expect(bad({ model: MODEL, messages: [user("x")], n: 2 }).code).toBe("unsupported_parameter");
    expect(bad({ model: MODEL, messages: [user("x")], n: 0 }).code).toBe("unsupported_parameter");
  });

  it("picks max_completion_tokens, then max_tokens, then 4096", () => {
    expect(ok({ messages: [user("x")] }).messages.max_tokens).toBe(4096);
    expect(ok({ messages: [user("x")], max_tokens: 100 }).messages.max_tokens).toBe(100);
    expect(ok({ messages: [user("x")], max_completion_tokens: 200 }).messages.max_tokens).toBe(200);
    expect(
      ok({ messages: [user("x")], max_completion_tokens: 200, max_tokens: 100 }).messages.max_tokens,
    ).toBe(200);
    expect(
      ok({ messages: [user("x")], max_completion_tokens: null, max_tokens: 100 }).messages.max_tokens,
    ).toBe(100);
    for (const v of [0, -1, 1.5, "10"]) {
      expect(bad({ model: MODEL, messages: [user("x")], max_tokens: v }).message).toBe(
        "'max_tokens' must be a positive integer.",
      );
    }
    expect(bad({ model: MODEL, messages: [user("x")], max_completion_tokens: 0 }).message).toContain(
      "max_completion_tokens",
    );
  });

  it("reads stream and stream_options.include_usage", () => {
    const s = ok({ messages: [user("x")], stream: true, stream_options: { include_usage: true } });
    expect(s.stream).toBe(true);
    expect(s.includeUsage).toBe(true);
    expect(s.messages.stream).toBe(true);
    const noUsage = ok({ messages: [user("x")], stream: true });
    expect(noUsage.includeUsage).toBe(false);
    const off = ok({ messages: [user("x")], stream: false, stream_options: { include_usage: false } });
    expect(off.stream).toBe(false);
    expect(off.includeUsage).toBe(false);
    expect(off.messages).not.toHaveProperty("stream");
    expect(bad({ model: MODEL, messages: [user("x")], stream_options: true }).code).toBe("invalid_request");
  });

  it("drops and reports ignored fields, temperature and top_p included (D1)", () => {
    const values: Record<string, unknown> = {
      temperature: 0.7,
      top_p: 0.9,
      response_format: { type: "json_object" },
      logprobs: true,
      top_logprobs: 3,
      seed: 42,
      reasoning_effort: "high",
      frequency_penalty: 0.5,
      presence_penalty: 0.5,
      logit_bias: { "1": 2 },
      user: "u-1",
      metadata: { a: "b" },
      store: true,
      service_tier: "auto",
      prediction: { type: "content", content: "x" },
      modalities: ["text"],
      audio: { voice: "alloy" },
    };
    expect(Object.keys(values)).toEqual([...IGNORED_FIELDS]);
    const r = ok({ messages: [user("x")], ...values, verbosity: "low", web_search_options: {}, seed2: null });
    expect(r.ignored).toEqual([...IGNORED_FIELDS, "verbosity", "web_search_options"]);
    expect(r.ignored).toContain("temperature");
    expect(r.ignored).toContain("top_p");
    expect(Object.keys(r.messages).sort()).toEqual(["max_tokens", "messages", "model"]);
  });

  it("does not report ignored fields sent as null", () => {
    expect(ok({ messages: [user("x")], temperature: null, top_p: null, seed: undefined }).ignored).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------------------------------------

function anthropicMessage(over: Partial<AnthropicMessage> = {}): AnthropicMessage {
  return {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text: "Hello!" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...over,
  };
}

describe("translateResponse", () => {
  const now = () => CREATED * 1000 + 999;

  it("maps a text message, usage and the unspent field", () => {
    const res = translateResponse(
      anthropicMessage({
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig" },
          { type: "text", text: "Hello" },
          { type: "text", text: ", world" },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        },
      }),
      UNSPENT,
      now,
    );
    expect(res).toEqual({
      id: "chatcmpl-msg_01",
      object: "chat.completion",
      created: CREATED,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello, world", refusal: null },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 130,
        completion_tokens: 5,
        total_tokens: 135,
        prompt_tokens_details: { cached_tokens: 100 },
      },
      unspent: UNSPENT,
    });
    expect(res.choices[0].message).not.toHaveProperty("tool_calls");
  });

  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["pause_turn", "stop"],
    ["max_tokens", "length"],
    ["model_context_window_exceeded", "length"],
    ["tool_use", "tool_calls"],
    ["refusal", "content_filter"],
    [null, "stop"],
  ])("maps stop_reason %s to finish_reason %s", (stop, finish) => {
    expect(
      translateResponse(anthropicMessage({ stop_reason: stop }), UNSPENT, now).choices[0].finish_reason,
    ).toBe(finish);
    expect(mapFinishReason(stop)).toBe(finish);
  });

  it("maps tool_use blocks to tool_calls, content null without text", () => {
    const res = translateResponse(
      anthropicMessage({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "toolu_A", name: "get_weather", input: { city: "Paris" } },
          { type: "tool_use", id: "toolu_B", name: "get_time", input: {} },
        ],
      }),
      UNSPENT,
      now,
    );
    expect(res.choices[0]).toEqual({
      index: 0,
      message: {
        role: "assistant",
        content: null,
        refusal: null,
        tool_calls: [
          {
            id: "toolu_A",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
          { id: "toolu_B", type: "function", function: { name: "get_time", arguments: "{}" } },
        ],
      },
      logprobs: null,
      finish_reason: "tool_calls",
    });
  });

  it("keeps text next to tool calls and skips unknown blocks", () => {
    const res = translateResponse(
      anthropicMessage({
        stop_reason: "tool_use",
        content: [
          { type: "redacted_thinking", data: "xx" },
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_A", name: "f", input: { a: [1] } },
        ],
      }),
      UNSPENT,
      now,
    );
    expect(res.choices[0].message.content).toBe("Checking.");
    expect(res.choices[0].message.tool_calls).toEqual([
      { id: "toolu_A", type: "function", function: { name: "f", arguments: '{"a":[1]}' } },
    ]);
  });

  it("treats missing cache usage as zero", () => {
    const res = translateResponse(
      anthropicMessage({ usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: null } }),
      UNSPENT,
      now,
    );
    expect(res.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
      prompt_tokens_details: { cached_tokens: 0 },
    });
  });

  it("defaults created to the current time", () => {
    const spy = vi.spyOn(Date, "now").mockReturnValue(CREATED * 1000);
    try {
      expect(translateResponse(anthropicMessage(), UNSPENT).created).toBe(CREATED);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("errors", () => {
  it("openaiError derives the type from the status", () => {
    expect(openaiError(400, "invalid_request", "Bad.")).toEqual({
      error: { message: "Bad.", type: "invalid_request_error", code: "invalid_request" },
    });
    expect(openaiError(401, "invalid_api_key", "m").error.type).toBe("authentication_error");
    expect(openaiError(402, "insufficient_credits", "m").error.type).toBe("insufficient_quota");
    expect(openaiError(403, "x", "m").error.type).toBe("permission_error");
    expect(openaiError(404, "model_not_found", "m").error.type).toBe("invalid_request_error");
    expect(openaiError(409, "already_processed", "m").error.type).toBe("invalid_request_error");
    expect(openaiError(429, "rate_limit_exceeded", "m").error.type).toBe("rate_limit_error");
    expect(openaiError(503, "provider_unavailable", "m").error.type).toBe("server_error");
  });

  it.each([
    [400, "invalid_request_error", "invalid_request_error", "invalid_request_error"],
    [401, "authentication_error", "authentication_error", "invalid_api_key"],
    [402, "billing_error", "insufficient_quota", "insufficient_credits"],
    [403, "permission_error", "permission_error", "permission_denied"],
    [404, "not_found_error", "invalid_request_error", "not_found"],
    [413, "request_too_large", "invalid_request_error", "request_too_large"],
    [429, "rate_limit_error", "rate_limit_error", "rate_limit_exceeded"],
    [500, "api_error", "server_error", "server_error"],
    [529, "overloaded_error", "server_error", "server_error"],
    [418, "brand_new_error", "invalid_request_error", "brand_new_error"],
  ])("maps HTTP %i %s", (status, anthropicType, type, code) => {
    const body = {
      type: "error",
      error: { type: anthropicType, message: "Upstream says no." },
      request_id: "req_x",
    };
    expect(anthropicErrorToOpenAI(status, body)).toEqual({
      error: { message: "Upstream says no.", type, code },
    });
  });

  it("copes with bodies that are not Anthropic errors", () => {
    expect(anthropicErrorToOpenAI(502, "<html>Bad gateway</html>")).toEqual({
      error: {
        message: "Model provider returned an error (HTTP 502).",
        type: "server_error",
        code: "server_error",
      },
    });
    expect(anthropicErrorToOpenAI(400, { error: { type: "constructor" } }).error.code).toBe("constructor");
    expect(anthropicErrorToOpenAI(400, null).error.code).toBe("provider_error");
  });

  it("knows the HTTP status of each Anthropic error type", () => {
    expect(anthropicErrorStatus("overloaded_error")).toBe(529);
    expect(anthropicErrorStatus("rate_limit_error")).toBe(429);
    expect(anthropicErrorStatus("toString")).toBe(500);
    expect(anthropicErrorStatus(undefined)).toBe(500);
  });
});

// ---------------------------------------------------------------------------------------------------------

const sse = (json: string) => `data: ${json}\n\n`;
const DONE = "data: [DONE]\n\n";

function ev(data: { type: string } & Record<string, unknown>): AnthropicStreamEvent {
  return { event: data.type, data };
}

function run(t: StreamTranslator, events: AnthropicStreamEvent[]): string[] {
  return events.flatMap((e) => t.push(e));
}

const messageStart = (id: string, model = MODEL) =>
  ev({
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 1,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      },
    },
  });
const blockStart = (index: number, content_block: Record<string, unknown>) =>
  ev({ type: "content_block_start", index, content_block });
const textDelta = (index: number, t: string) =>
  ev({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } });
const jsonDelta = (index: number, partial_json: string) =>
  ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });
const blockStop = (index: number) => ev({ type: "content_block_stop", index });
const messageDelta = (stop_reason: string) =>
  ev({ type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } });
const messageStop = ev({ type: "message_stop" });
const ping = ev({ type: "ping" });
const USAGE = {
  input_tokens: 12,
  output_tokens: 5,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 20,
};

describe("stream translator", () => {
  it("streams a text answer with include_usage", () => {
    const t = createStreamTranslator({ model: MODEL, includeUsage: true, created: CREATED });
    const out = run(t, [
      messageStart("msg_01"),
      blockStart(0, { type: "text", text: "" }),
      ping,
      textDelta(0, "Hello"),
      textDelta(0, ", world"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop,
    ]);
    out.push(...t.finish(UNSPENT, USAGE));
    const head = `{"id":"chatcmpl-msg_01","object":"chat.completion.chunk","created":${CREATED},"model":"${MODEL}"`;
    expect(out).toEqual([
      sse(
        `${head},"choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}],"usage":null}`,
      ),
      sse(
        `${head},"choices":[{"index":0,"delta":{"content":"Hello"},"logprobs":null,"finish_reason":null}],"usage":null}`,
      ),
      sse(
        `${head},"choices":[{"index":0,"delta":{"content":", world"},"logprobs":null,"finish_reason":null}],"usage":null}`,
      ),
      sse(`${head},"choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}],"usage":null}`),
      sse(
        `${head},"choices":[],"usage":{"prompt_tokens":132,"completion_tokens":5,"total_tokens":137,"prompt_tokens_details":{"cached_tokens":100}},"unspent":{"request_id":"req_1","credits_charged":"0.0123","available":"9.98"}}`,
      ),
      DONE,
    ]);
    expect(t.done).toBe(true);
    expect(t.push(ping)).toEqual([]);
    expect(t.finish(UNSPENT, USAGE)).toEqual([]);
  });

  it("streams tool calls with their own indexes, without include_usage", () => {
    const t = createStreamTranslator({ model: "claude-opus-5-5", includeUsage: false, created: CREATED });
    const out = run(t, [
      messageStart("msg_02", "claude-opus-5-5"),
      blockStart(0, { type: "thinking", thinking: "", signature: "" }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan..." } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqQB" } }),
      blockStop(0),
      blockStart(1, { type: "text", text: "" }),
      textDelta(1, "Checking."),
      blockStop(1),
      blockStart(2, { type: "tool_use", id: "toolu_A", name: "get_weather", input: {} }),
      jsonDelta(2, ""),
      jsonDelta(2, '{"city":'),
      ping,
      jsonDelta(2, '"Paris"}'),
      blockStop(2),
      blockStart(3, { type: "tool_use", id: "toolu_B", name: "get_time", input: {} }),
      blockStop(3),
      messageDelta("tool_use"),
      messageStop,
    ]);
    out.push(...t.finish(UNSPENT, USAGE));
    const head = `{"id":"chatcmpl-msg_02","object":"chat.completion.chunk","created":${CREATED},"model":"claude-opus-5-5"`;
    const choice = (delta: string, finish = "null") =>
      sse(`${head},"choices":[{"index":0,"delta":${delta},"logprobs":null,"finish_reason":${finish}}]}`);
    expect(out).toEqual([
      choice(`{"role":"assistant","content":""}`),
      choice(`{"content":"Checking."}`),
      choice(
        `{"tool_calls":[{"index":0,"id":"toolu_A","type":"function","function":{"name":"get_weather","arguments":""}}]}`,
      ),
      choice(String.raw`{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]}`),
      choice(String.raw`{"tool_calls":[{"index":0,"function":{"arguments":"\"Paris\"}"}}]}`),
      choice(
        `{"tool_calls":[{"index":1,"id":"toolu_B","type":"function","function":{"name":"get_time","arguments":""}}]}`,
      ),
      choice(`{"tool_calls":[{"index":1,"function":{"arguments":"{}"}}]}`),
      choice("{}", `"tool_calls"`),
      sse(
        `${head},"choices":[],"unspent":{"request_id":"req_1","credits_charged":"0.0123","available":"9.98"}}`,
      ),
      DONE,
    ]);

    // A client accumulating deltas ends up with parseable arguments for every call.
    const args: string[] = [];
    for (const line of out.slice(0, -1)) {
      const chunk = JSON.parse(line.slice("data: ".length));
      for (const tc of chunk.choices[0]?.delta.tool_calls ?? [])
        args[tc.index] = (args[tc.index] ?? "") + tc.function.arguments;
    }
    expect(args.map((a) => JSON.parse(a))).toEqual([{ city: "Paris" }, {}]);
  });

  it.each([
    ["max_tokens", "length"],
    ["refusal", "content_filter"],
    ["stop_sequence", "stop"],
    ["pause_turn", "stop"],
  ])("maps a streamed %s to %s", (stop, finish) => {
    const t = createStreamTranslator({ model: MODEL, includeUsage: false, created: CREATED });
    const out = run(t, [messageStart("msg_03"), messageDelta(stop)]);
    expect(JSON.parse(out[1]!.slice(6)).choices[0]).toEqual({
      index: 0,
      delta: {},
      logprobs: null,
      finish_reason: finish,
    });
  });

  it("ends with an OpenAI error and [DONE] on an error event", () => {
    const t = createStreamTranslator({ model: MODEL, includeUsage: true, created: CREATED });
    const before = run(t, [
      messageStart("msg_04"),
      blockStart(0, { type: "text", text: "" }),
      textDelta(0, "Hel"),
    ]);
    expect(before).toHaveLength(2);
    const out = t.push({
      event: "error",
      data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    });
    expect(out).toEqual([
      sse(`{"error":{"message":"Overloaded","type":"server_error","code":"server_error"}}`),
      DONE,
    ]);
    expect(t.done).toBe(true);
    expect(t.push(textDelta(0, "lo"))).toEqual([]);
    expect(t.push(messageStop)).toEqual([]);
    expect(t.finish(UNSPENT, USAGE)).toEqual([]);
  });

  it("maps a rate limit error event", () => {
    const t = createStreamTranslator({ model: MODEL, includeUsage: false, created: CREATED });
    const out = t.push(ev({ type: "error", error: { type: "rate_limit_error", message: "Slow down." } }));
    expect(out).toEqual([
      sse(`{"error":{"message":"Slow down.","type":"rate_limit_error","code":"rate_limit_exceeded"}}`),
      DONE,
    ]);
  });

  it("lets the gateway end a stream with its own error", () => {
    const t = createStreamTranslator({ model: MODEL, includeUsage: false, created: CREATED });
    run(t, [messageStart("msg_05"), textDelta(0, "partial")]);
    const err = openaiError(503, "provider_unavailable", "Model provider is unavailable right now.");
    expect(t.fail(err)).toEqual([sse(JSON.stringify(err)), DONE]);
    expect(t.fail(err)).toEqual([]);
    expect(t.finish(UNSPENT, USAGE)).toEqual([]);
  });

  it("uses the event name or data.type, and ignores unknown events", () => {
    const t = createStreamTranslator({ model: MODEL, includeUsage: false, created: CREATED });
    expect(t.push({ event: "message", data: messageStart("msg_06").data })).toHaveLength(1);
    expect(t.push({ event: "future_event", data: { type: "future_event" } })).toEqual([]);
    expect(t.push({ event: "content_block_delta", data: "garbage" })).toEqual([]);
  });

  it("emits the role chunk once even if content arrives without message_start", () => {
    const t = createStreamTranslator({ model: MODEL, includeUsage: false, created: CREATED });
    const out = run(t, [textDelta(0, "a"), textDelta(0, "b")]);
    expect(out.map((l) => JSON.parse(l.slice(6)).choices[0].delta)).toEqual([
      { role: "assistant", content: "" },
      { content: "a" },
      { content: "b" },
    ]);
    expect(JSON.parse(out[0]!.slice(6)).id).toBe(`chatcmpl-${CREATED}`);
  });

  it("emits text carried on content_block_start and sends finish_reason once", () => {
    const t = createStreamTranslator({ model: MODEL, includeUsage: false, created: CREATED });
    const out = run(t, [
      messageStart("msg_07"),
      blockStart(0, { type: "text", text: "Hi" }),
      messageDelta("end_turn"),
      messageDelta("end_turn"),
    ]);
    expect(out.map((l) => JSON.parse(l.slice(6)).choices[0])).toEqual([
      { index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null },
      { index: 0, delta: { content: "Hi" }, logprobs: null, finish_reason: null },
      { index: 0, delta: {}, logprobs: null, finish_reason: "stop" },
    ]);
  });

  it("defaults created to the current time", () => {
    const spy = vi.spyOn(Date, "now").mockReturnValue(CREATED * 1000 + 500);
    try {
      const t = createStreamTranslator({ model: MODEL, includeUsage: false });
      expect(JSON.parse(t.push(messageStart("msg_08"))[0]!.slice(6)).created).toBe(CREATED);
    } finally {
      spy.mockRestore();
    }
  });
});
