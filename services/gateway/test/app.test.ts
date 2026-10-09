import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { modelsResponse } from "../src/models";

const app = createApp(loadConfig({ PROVIDER_MODE: "mock" }));

describe("gateway skeleton", () => {
  it("health and Claude Code warm-up", async () => {
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/api/hello", { method: "HEAD" })).status).toBe(200);
  });

  it("/v1/models lists enabled Claude models with Unspent prices", async () => {
    const res = await app.request("/v1/models?limit=1000");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof modelsResponse>;
    expect(body.data.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(body.first_id).toBe("claude-opus-5-5");
    expect(body.last_id).toBe("claude-haiku-5-5");
    expect(body.data[0]!.pricing.tiers[0]).toEqual({
      max_prompt_tokens: null,
      input: "4.60",
      output: "23.00",
      cache_write_5m: "5.75",
      cache_write_1h: "9.20",
      cache_read: "0.23",
    });
    expect(body.data[2]!.pricing.tiers.map((t) => t.max_prompt_tokens)).toEqual([100_000, null]);
  });

  it("matches /v1/messages with ?beta=true and 404s batches and files", async () => {
    expect((await app.request("/v1/messages?beta=true", { method: "POST" })).status).toBe(501);
    expect((await app.request("/v1/messages/batches", { method: "POST" })).status).toBe(404);
    expect((await app.request("/v1/files")).status).toBe(404);
  });
});
