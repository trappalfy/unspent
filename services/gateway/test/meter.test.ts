// Usage metering edge cases (brief 8.6) and the RPC retry transport.

import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { retryingTransport } from "../src/chain";
import { UsageMeter } from "../src/sse";

describe("usage.iterations", () => {
  it("message-only iterations (compaction beta on, nothing compacted) are the top-level counts: no alert", () => {
    const m = new UsageMeter();
    m.observeMessage({
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        cache_read_input_tokens: 100,
        iterations: [{ type: "message", input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 100 }],
      },
    });
    expect(m.unknownFields.size).toBe(0);
    const { usage } = m.toUsage();
    expect([usage.inputTokens, usage.outputTokens, usage.cacheReadInputTokens]).toEqual([10, 3, 100]);
  });

  it("a compaction iteration is billed on top of the top-level counts and alerted", () => {
    const m = new UsageMeter();
    m.observeMessage({
      usage: {
        input_tokens: 23000,
        output_tokens: 1000,
        iterations: [
          { type: "compaction", input_tokens: 180000, output_tokens: 3500 },
          { type: "message", input_tokens: 23000, output_tokens: 1000 },
        ],
      },
    });
    expect([...m.unknownFields]).toEqual(["iterations.compaction"]);
    const { usage } = m.toUsage();
    expect([usage.inputTokens, usage.outputTokens]).toEqual([203000, 4500]);
  });

  it("the final message_delta replaces earlier iterations instead of adding to them", () => {
    const m = new UsageMeter();
    const it = [{ type: "compaction", input_tokens: 50, output_tokens: 5 }];
    m.observe({
      event: "message_start",
      data: JSON.stringify({
        type: "message_start",
        message: { usage: { input_tokens: 1, output_tokens: 1, iterations: it } },
      }),
    });
    m.observe({
      event: "message_delta",
      data: JSON.stringify({ type: "message_delta", usage: { output_tokens: 2, iterations: it } }),
    });
    m.observe({ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) });
    const { usage } = m.toUsage();
    expect([usage.inputTokens, usage.outputTokens]).toEqual([51, 7]);
  });
});

describe("retryingTransport", () => {
  const http = (statusCode: number) =>
    new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
      headers: new Headers(),
      message: "x",
      statusCode,
    });
  const config = { payload: {} } as Parameters<ReturnType<typeof retryingTransport>>[0];

  it("retries 429 and 5xx, then answers", async () => {
    const inner = vi
      .fn()
      .mockRejectedValueOnce(http(429))
      .mockRejectedValueOnce(http(503))
      .mockResolvedValueOnce({ result: 1 });
    await expect(retryingTransport(inner, [0, 0, 0])(config)).resolves.toEqual({ result: 1 });
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it("gives up after its delays, and never retries a client error", async () => {
    const limited = vi.fn().mockRejectedValue(http(429));
    await expect(retryingTransport(limited, [0, 0])(config)).rejects.toThrow();
    expect(limited).toHaveBeenCalledTimes(3);
    const bad = vi.fn().mockRejectedValue(http(400));
    await expect(retryingTransport(bad, [0, 0])(config)).rejects.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
  });
});
