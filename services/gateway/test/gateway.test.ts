// Gateway against the mock provider, PGlite and the fake chain (brief 13, "Шлюз").

import { requests, settleQueue } from "@unspent/db";
import { chargeUcr, findModel, MIN_CHARGE_UCR, type Usage } from "@unspent/shared";
import { afterEach, describe, expect, it } from "vitest";
import { hex } from "../src/chain";
import { MemoryRateLimiter } from "../src/ratelimit";
import { C, type Harness, msgBody, sleep, startHarness, until } from "./harness";
import { expectedUsage, parseSse, type Scenario } from "./mock/mockAnthropic";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const sonnet = findModel("claude-sonnet-5-5")!;

function usageOf(s: Scenario): Usage {
  const u = expectedUsage(s)!;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadInputTokens: u.cache_read_input_tokens,
    cacheCreationInputTokens: u.cache_creation_input_tokens,
    cacheCreation5mInputTokens: u.ephemeral_5m_input_tokens,
    cacheCreation1hInputTokens: u.ephemeral_1h_input_tokens,
    webSearchRequests: u.web_search_requests,
  };
}

async function onlyRequest() {
  const rows = await h.db.select().from(requests);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function settled() {
  await until(async () => (await h.db.select().from(settleQueue)).length > 0);
  await h.settle.drain();
  return onlyRequest();
}

describe("streaming passthrough", () => {
  it("forwards the stream byte for byte, with pings and anthropic-* headers, and the body unchanged", async () => {
    h = await startHarness();
    const sent = `{"model":"claude-sonnet-5-5","max_tokens":512,"stream":true,
      "system":[{"type":"text","text":"b"},{"type":"text","text":"a","cache_control":{"type":"ephemeral"}}],
      "messages":[{"role":"user","content":"Привет ✓"}]}`;
    const res = await h.messages(sent, {
      "anthropic-beta": "some-beta-2026-01-01,another",
      "anthropic-custom": "x",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed");
    const text = await res.text();
    const events = parseSse(text);
    expect(events.map((e) => e.event)).toContain("ping");
    expect(events.at(-1)?.event).toBe("message_stop");
    const rec = h.mock.requests.find((r) => r.path.startsWith("/v1/messages"))!;
    expect(rec.body).toBe(sent);
    expect(rec.headers["anthropic-beta"]).toBe("some-beta-2026-01-01,another");
    expect(rec.headers["anthropic-custom"]).toBe("x");
    expect(rec.headers["x-api-key"]).toMatch(/^sk-ant-test-key-/);
  });

  it("matches /v1/messages?beta=true and forwards the query", async () => {
    h = await startHarness();
    const res = await fetch(`${h.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.apiKey}` },
      body: JSON.stringify(msgBody()),
    });
    expect(res.status).toBe(200);
    expect(h.mock.requests[0]!.path).toBe("/v1/messages?beta=true");
  });

  it("streams without buffering: the first event arrives before the stream ends", async () => {
    h = await startHarness();
    h.mock.setScenario({ type: "text", chunkDelayMs: 150, chunks: ["a", "b", "c", "d"] });
    const t0 = Date.now();
    const res = await h.messages(msgBody({ stream: true }));
    const reader = res.body!.getReader();
    await reader.read();
    const firstAt = Date.now() - t0;
    while (!(await reader.read()).done) {}
    const endAt = Date.now() - t0;
    expect(endAt - firstAt).toBeGreaterThan(600);
  });
});

describe("request lifecycle (brief 5.5)", () => {
  it("reserve → dispatch → stream → settle burns the metered cost", async () => {
    h = await startHarness();
    const s: Scenario = { type: "text" };
    h.mock.setScenario(s);
    const res = await h.messages(msgBody({ stream: true }));
    await res.text();
    const r = await settled();
    const expected = chargeUcr(sonnet, usageOf(s));
    expect(r.status).toBe("settled");
    expect(r.chargedUcr).toBe(expected);
    expect(r.estimated).toBe(false);
    expect(r.reserveSig).toBeTruthy();
    expect(r.dispatchedAt).toBeTruthy();
    expect(h.chain.burned).toBe(expected);
    const u = await h.chain.user(h.wallet);
    expect(u).toEqual({ balance: 40n * C - expected, reserved: 0n, reserveCap: 0n });
    expect(res.headers.get("x-unspent-request-id")).toBe(hex(new Uint8Array(r.requestId)));
  });

  it("non-stream JSON is metered from the message usage", async () => {
    h = await startHarness();
    const s: Scenario = { type: "tool_use" };
    h.mock.setScenario(s);
    const res = await h.messages(msgBody());
    expect(res.status).toBe(200);
    expect((await res.json()).stop_reason).toBe("tool_use");
    const r = await settled();
    expect(r.chargedUcr).toBe(chargeUcr(sonnet, usageOf(s)));
  });

  it("web search is billed per search", async () => {
    h = await startHarness();
    const s: Scenario = { type: "web_search", searches: 2 };
    h.mock.setScenario(s);
    const res = await h.messages(
      msgBody({ stream: true, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] }),
    );
    await res.text();
    const r = await settled();
    expect(r.webSearchRequests).toBe(2);
    expect(r.chargedUcr).toBe(chargeUcr(sonnet, usageOf(s)));
  });

  it("the provider HTTP client never retries: one upstream request even on 529", async () => {
    h = await startHarness();
    h.mock.setScenario({ type: "error_before_first_token", status: 529 });
    const res = await h.messages(msgBody());
    expect(res.status).toBe(529);
    expect(res.headers.get("retry-after")).toBe("5");
    expect((await res.json()).error.type).toBe("overloaded_error");
    expect(h.mock.requests.filter((r) => r.path.startsWith("/v1/messages"))).toHaveLength(1);
  });

  it("provider error before the first token by the request's fault costs MIN_CHARGE", async () => {
    h = await startHarness();
    h.mock.setScenario({ type: "error_before_first_token", status: 400, message: "messages: bad" });
    const res = await h.messages(msgBody());
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("messages: bad");
    const r = await settled();
    expect(r.chargedUcr).toBe(MIN_CHARGE_UCR);
    expect(h.chain.burned).toBe(MIN_CHARGE_UCR);
  });

  it.each([429, 500, 529])(
    "provider error %i before the first token releases the reservation",
    async (status) => {
      h = await startHarness();
      h.mock.setScenario({ type: "error_before_first_token", status: status as 429 });
      expect((await h.messages(msgBody())).status).toBe(status);
      const r = await settled();
      expect(r.status).toBe("released");
      expect(r.chargedUcr).toBe(0n);
      expect(h.chain.burned).toBe(0n);
      expect((await h.chain.user(h.wallet))!.reserved).toBe(0n);
    },
  );

  it("a disabled provider key → 503, nothing charged, key out of rotation, owner alerted", async () => {
    h = await startHarness();
    h.mock.setScenario({ type: "error_before_first_token", status: 401 });
    const res = await h.messages(msgBody());
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toBe(
      "Model provider is unavailable right now. You were not charged.",
    );
    const r = await settled();
    expect(r.chargedUcr).toBe(0n);
    expect(h.logs.some((l) => l.includes('"provider_key_disabled"'))).toBe(true);
    // second key also rejected → no keys left → 503 before any reservation
    await h.messages(msgBody());
    const reservesBefore = h.chain.reserveCalls;
    expect((await h.messages(msgBody())).status).toBe(503);
    expect(h.chain.reserveCalls).toBe(reservesBefore);
  });

  it("client disconnecting mid-thinking: the gateway reads to the end and bills the exact usage", async () => {
    h = await startHarness();
    const s: Scenario = { type: "thinking", chunkDelayMs: 40 };
    h.mock.setScenario(s);
    const ac = new AbortController();
    const res = await h.messages(msgBody({ stream: true }), {}, undefined);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    ac.abort();
    await until(async () => (await h.db.select().from(settleQueue)).length > 0, 10_000);
    await h.settle.drain();
    const r = await onlyRequest();
    expect(r.estimated).toBe(false);
    expect(r.chargedUcr).toBe(chargeUcr(sonnet, usageOf(s)));
    const rec = h.mock.requests.find((x) => x.path.startsWith("/v1/messages"))!;
    expect(rec.clientAborted).toBe(false);
  });

  it("a stream dropped by the provider is billed by estimate and marked estimated", async () => {
    h = await startHarness();
    h.mock.setScenario({
      type: "drop_mid_stream",
      base: { type: "text", chunks: ["x".repeat(700), "y".repeat(700)] },
      afterEvents: 5,
    });
    const res = await h.messages(msgBody({ stream: true }));
    await res.text().catch(() => "");
    const r = await settled();
    expect(r.estimated).toBe(true);
    expect(r.outputTokens).toBeGreaterThanOrEqual(Math.ceil(1400 / 3.5));
  });

  it("an error event mid-stream is forwarded and billed by estimate", async () => {
    h = await startHarness();
    h.mock.setScenario({ type: "error_mid_stream" });
    const text = await (await h.messages(msgBody({ stream: true }))).text();
    expect(parseSse(text).some((e) => e.event === "error")).toBe(true);
    const r = await settled();
    expect(r.estimated).toBe(true);
  });

  it("cost above the reservation is not charged to the user", async () => {
    h = await startHarness();
    // max_tokens 10 reserves little; the mock reports far more output
    h.mock.setScenario({ type: "text", usage: { output_tokens: 50_000 } });
    await (await h.messages(msgBody({ stream: true, max_tokens: 10 }))).text();
    const r = await settled();
    expect(r.chargedUcr).toBe(r.reservedUcr);
    expect(r.costUcr!).toBeGreaterThan(r.reservedUcr);
  });

  it("a request longer than MAX_REQUEST_DURATION is cut and settled by estimate", async () => {
    h = await startHarness();
    h.chain.state.reservationTtl = 601n; // max duration = 1 s
    h.mock.setScenario({
      type: "slow",
      stallMs: 0,
      chunkDelayMs: 300,
      chunks: ["a", "b", "c", "d", "e", "f", "g", "h"],
    });
    await (await h.messages(msgBody({ stream: true }))).text().catch(() => "");
    const r = await settled();
    expect(r.estimated).toBe(true);
    expect(r.durationMs!).toBeLessThan(2_000);
  });

  it("unknown non-zero usage fields alert the owner", async () => {
    h = await startHarness();
    h.mock.setScenario({ type: "unknown_usage_field" });
    await (await h.messages(msgBody({ stream: true }))).text();
    await settled();
    expect(
      h.logs.some((l) => l.includes('"unmetered_usage_field"') && l.includes("code_execution_requests")),
    ).toBe(true);
  });
});

describe("reservation failures", () => {
  it("not enough available → 402 billing_error, nothing reserved", async () => {
    h = await startHarness({ credits: 0n });
    h.chain.fund(h.wallet, 0n);
    const res = await h.messages(msgBody());
    expect(res.status).toBe(402);
    const b = await res.json();
    expect(b.error.type).toBe("billing_error");
    expect(b.error.message).toMatch(
      /^Not enough credits\. Available: 0\.00, this request may cost up to [\d.]+\. Lower max_tokens or top up\.$/,
    );
    expect(h.chain.reserveCalls).toBe(0);
  });

  it("worst case above max_reservation → 400", async () => {
    h = await startHarness();
    // 200 web searches held at 20k result tokens each puts the worst case far above 25 credits
    const res = await h.messages(
      msgBody({
        model: "claude-opus-5-5",
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 200 }],
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(
      /above the 25\.00-credit limit per request\. Lower max_tokens\.$/,
    );
  });

  it("reservation not confirmed in 20 s → 503, never dispatched; a late landing is released by the reconciler", async () => {
    h = await startHarness();
    h.chain.reserveMode = "timeout_then_land";
    const res = await h.messages(msgBody());
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect((await res.json()).error.message).toBe(
      "Solana did not confirm the reservation in time. You were not charged.",
    );
    expect(h.mock.requests).toHaveLength(0);
    expect((await h.chain.user(h.wallet))!.reserved).toBeGreaterThan(0n);
    await h.reconciler.runOnce();
    await h.settle.drain();
    expect((await h.chain.user(h.wallet))!.reserved).toBe(0n);
    expect(h.mock.requests).toHaveLength(0);
  });

  it("a reservation that never lands is closed once its blockhash expires", async () => {
    h = await startHarness();
    h.chain.reserveMode = "timeout_never_lands";
    expect((await h.messages(msgBody())).status).toBe(503);
    await h.reconciler.runOnce();
    expect((await onlyRequest()).status).toBe("reserve_timeout");
    h.chain.height += 1_000n;
    await h.reconciler.runOnce();
    expect((await onlyRequest()).status).toBe("released");
  });

  it("shutdown → 410 with the redeem hint", async () => {
    h = await startHarness();
    h.chain.state.shutDown = true;
    const res = await h.messages(msgBody());
    expect(res.status).toBe(410);
    expect((await res.json()).error.message).toBe(
      "Unspent is shut down. Withdraw and redeem your credits at http://localhost:3000/app.",
    );
  });

  it("unknown model → 400 with the catalog hint", async () => {
    h = await startHarness();
    const res = await h.messages(msgBody({ model: "claude-fable-5-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe(
      "Model claude-fable-5-1 is not available on Unspent. See /v1/models.",
    );
  });

  it("invalid key → 401 authentication_error", async () => {
    h = await startHarness();
    const res = await h.messages(msgBody(), {}, "usp_test_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(res.status).toBe(401);
    expect((await res.json()).error.type).toBe("authentication_error");
  });
});

describe("crash recovery (brief 8.12)", () => {
  it("a dispatched request with no progress for 2 minutes is released and never resent", async () => {
    h = await startHarness();
    h.mock.setScenario({ type: "text" });
    await (await h.messages(msgBody({ stream: true }))).text();
    await until(async () => (await h.db.select().from(settleQueue)).length > 0);
    // Simulate a crash right after dispatch: put the request back to `dispatched`, drop its queue entry,
    // and recreate the onchain hold.
    const r = await onlyRequest();
    await h.db.delete(settleQueue);
    h.chain.applyReserve(hex(new Uint8Array(r.requestId)), h.wallet, r.reservedUcr);
    const { eq } = await import("@unspent/db");
    await h.db
      .update(requests)
      .set({ status: "dispatched", lastProgressAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(requests.id, r.id));
    const sentBefore = h.mock.requests.length;
    await h.reconciler.runOnce();
    await h.settle.drain();
    const after = await onlyRequest();
    expect(after.status).toBe("released");
    expect(after.chargedUcr).toBe(0n);
    expect((await h.chain.user(h.wallet))!.reserved).toBe(0n);
    expect(h.mock.requests.length).toBe(sentBefore);
  });

  it("a reservation that expired before settlement is closed out at Unspent's cost", async () => {
    h = await startHarness();
    await (await h.messages(msgBody({ stream: true }))).text();
    await until(async () => (await h.db.select().from(settleQueue)).length > 0);
    const r = await onlyRequest();
    h.chain.expire(new Uint8Array(r.requestId));
    await h.settle.drain();
    const after = await onlyRequest();
    expect(after.status).toBe("expired");
    expect(after.chargedUcr).toBe(0n);
  });

  it("a failed settle_many is retried entry by entry", async () => {
    h = await startHarness();
    await (await h.messages(msgBody({ stream: true }))).text();
    await until(async () => (await h.db.select().from(settleQueue)).length > 0);
    h.chain.settleFails = 1;
    await h.settle.drain();
    expect((await onlyRequest()).status).toBe("settled");
  });
});

describe("idempotency (brief 8.4)", () => {
  it("repeat during and after the request never reaches the provider twice", async () => {
    h = await startHarness();
    h.mock.setScenario({ type: "text", chunkDelayMs: 100 });
    const hdr = { "idempotency-key": "idem-key-0001" };
    const first = await h.messages(msgBody({ stream: true }), hdr);
    const during = await h.messages(msgBody({ stream: true }), hdr);
    expect(during.status).toBe(409);
    expect((await during.json()).error.message).toMatch(/still running/);
    await first.text();
    await until(async () => (await h.db.select().from(settleQueue)).length > 0);
    const after = await h.messages(msgBody({ stream: true }), hdr);
    expect(after.status).toBe(409);
    const b = await after.json();
    expect(b.unspent.request_id).toHaveLength(64);
    expect(h.mock.requests.filter((r) => r.path.startsWith("/v1/messages"))).toHaveLength(1);
  });

  it("same key with a different body → 409 idempotency_key_reused", async () => {
    h = await startHarness();
    const hdr = { "idempotency-key": "idem-key-0002" };
    await (await h.messages(msgBody(), hdr)).text();
    const res = await h.messages(msgBody({ max_tokens: 100 }), hdr);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/different request body/);
  });

  it("a key whose request failed before the provider (402, reservation timeout, provider error) can be reused", async () => {
    h = await startHarness({ credits: 0n });
    const hdr = { "idempotency-key": "idem-key-0003" };
    expect((await h.messages(msgBody(), hdr)).status).toBe(402);
    h.chain.fund(h.wallet, 10n);
    h.chain.reserveMode = "timeout_never_lands";
    expect((await h.messages(msgBody(), hdr)).status).toBe(503);
    h.chain.reserveMode = "ok";
    h.mock.setScenario({ type: "error_before_first_token", status: 529 });
    expect((await h.messages(msgBody(), hdr)).status).toBe(529);
    h.mock.setScenario({ type: "text" });
    expect((await h.messages(msgBody(), hdr)).status).toBe(200);
  });
});

describe("limits", () => {
  it("rate limit per wallet summed over its keys → 429 with integer retry-after", async () => {
    h = await startHarness({ limiter: new MemoryRateLimiter(3, 10) });
    const k2 = await h.newKey({ wallet: h.wallet });
    for (const key of [h.apiKey, k2.apiKey, h.apiKey])
      expect((await h.messages(msgBody(), {}, key)).status).toBe(200);
    const res = await h.messages(msgBody(), {}, k2.apiKey);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("daily key limit holds under parallel requests (reservations count against it)", async () => {
    h = await startHarness({ credits: 40n });
    const k = await h.newKey({ wallet: h.wallet, dailyLimitUcr: 10_000n });
    h.mock.setScenario({ type: "text", chunkDelayMs: 50 });
    const res = await Promise.all(
      Array.from({ length: 8 }, () => h.messages(msgBody({ max_tokens: 200 }), {}, k.apiKey)),
    );
    const ok = res.filter((r) => r.status === 200).length;
    const limited = res.filter((r) => r.status === 429);
    expect(ok).toBeGreaterThan(0);
    expect(limited.length).toBeGreaterThan(0);
    expect((await limited[0]!.json()).error.message).toMatch(/daily limit of 0\.01 credits/);
    await Promise.all(res.map((r) => r.text().catch(() => "")));
    await until(async () => (await h.db.select().from(settleQueue)).length === ok);
    await h.settle.drain();
    const rows = await h.db.select().from(requests);
    expect(rows.reduce((s, r) => s + (r.chargedUcr ?? 0n), 0n)).toBeLessThanOrEqual(10_000n);
  });

  it("50 parallel requests on a nearly empty balance: extra reservations are refused, the balance never goes negative", async () => {
    h = await startHarness({ limiter: new MemoryRateLimiter(1_000, 1_000) });
    h.chain.users.set(h.wallet, { balance: 50_000n, reserved: 0n, reserveCap: 0n });
    h.chain.reserveDelayMs = 5;
    const res = await Promise.all(Array.from({ length: 50 }, () => h.messages(msgBody({ max_tokens: 300 }))));
    const codes = res.map((r) => r.status);
    expect(codes.filter((c) => c === 200).length).toBeGreaterThan(0);
    expect(codes.every((c) => c === 200 || c === 402)).toBe(true);
    await Promise.all(res.map((r) => r.text()));
    await until(
      async () => (await h.db.select().from(settleQueue)).length === codes.filter((c) => c === 200).length,
    );
    await h.settle.drain();
    const u = (await h.chain.user(h.wallet))!;
    expect(u.balance).toBeGreaterThanOrEqual(0n);
    expect(u.reserved).toBe(0n);
  });
});

describe("filter (brief 8.5, D2)", () => {
  it("rejects an unknown tool type in the provider's wording", async () => {
    h = await startHarness();
    const res = await h.messages(msgBody({ tools: [{ type: "advisor_20260301", name: "advisor" }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(
      /^tools\.0: Input tag 'advisor_20260301' found using 'type' does not match any of the expected tags: /,
    );
    expect(h.chain.reserveCalls).toBe(0);
  });

  it.each([
    [{ speed: "fast" }],
    [{ mcp_servers: [] }],
    [{ container: "c" }],
    [{ inference_geo: "us" }],
    [{ service_tier: "priority" }],
    [{ fallbacks: "default" }],
    [{ context_management: { edits: [{ type: "compact_20260112" }] } }],
    [{ tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] }],
    [{ tools: [{ type: "code_execution_20250825", name: "code_execution" }] }],
  ])("rejects %j", async (extra) => {
    h = await startHarness();
    expect((await h.messages(msgBody(extra))).status).toBe(400);
    expect(h.mock.requests).toHaveLength(0);
  });

  it("lets client tools, tool search and web search through byte for byte", async () => {
    h = await startHarness();
    const body = JSON.stringify(
      msgBody({
        tools: [
          { name: "my_tool", input_schema: { type: "object" } },
          { type: "bash_20250124", name: "bash" },
          { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
          { type: "tool_search_tool_regex_20251119", name: "tool_search" },
          { type: "web_search_20260209", name: "web_search" },
        ],
      }),
    );
    expect((await h.messages(body)).status).toBe(200);
    expect(h.mock.requests[0]!.body).toBe(body);
  });
});

describe("privacy (brief 8.11)", () => {
  it("no text from the request or response body appears in logs or the database", async () => {
    h = await startHarness();
    const marker = `secret-${crypto.randomUUID()}`;
    h.mock.setScenario({ type: "text", chunks: [`answer-${marker}`] });
    await (
      await h.messages(
        msgBody({ stream: true, system: `sys ${marker}`, messages: [{ role: "user", content: marker }] }),
      )
    ).text();
    await settled();
    expect(h.logs.join("\n")).not.toContain(marker);
    for (const table of [
      "requests",
      "settle_queue",
      "idempotency_keys",
      "api_keys",
      "wallets",
      "chain_events",
      "reconciliation",
    ]) {
      const { sql } = await import("@unspent/db");
      const rows = await h.db.execute(sql.raw(`select row_to_json(t)::text as j from ${table} t`));
      const dump = JSON.stringify((rows as unknown as { rows?: unknown[] }).rows ?? rows);
      expect(dump).not.toContain(marker);
    }
  });
});

describe("misc routes", () => {
  it("/v1/balance, count_tokens and /v1/models", async () => {
    h = await startHarness();
    const bal = await (await fetch(`${h.url}/v1/balance`, { headers: { "x-api-key": h.apiKey } })).json();
    expect(bal).toEqual({ available: "40", reserved: "0", balance: "40" });
    const ct = await fetch(`${h.url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "x-api-key": h.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(ct.status).toBe(200);
    expect(typeof (await ct.json()).input_tokens).toBe("number");
    const models = await (await fetch(`${h.url}/v1/models?limit=1000`)).json();
    expect(models.data.map((m: { id: string }) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    expect((await fetch(`${h.url}/api/hello`, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(`${h.url}/v1/messages/batches`, { method: "POST" })).status).toBe(404);
  });

  it("images trigger an exact count_tokens for the reservation", async () => {
    h = await startHarness();
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
    expect(
      (
        await h.messages(
          msgBody({ messages: [{ role: "user", content: [img, { type: "text", text: "what" }] }] }),
        )
      ).status,
    ).toBe(200);
    expect(h.mock.requests.map((r) => r.path)).toEqual(["/v1/messages/count_tokens", "/v1/messages"]);
  });
});

describe("chat completions (brief 8.8)", () => {
  it("non-stream: translated response with the unspent field", async () => {
    h = await startHarness();
    const res = await h.chat({
      model: "claude-sonnet-5-5",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
      ],
      temperature: 0.7,
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.object).toBe("chat.completion");
    expect(b.choices[0].finish_reason).toBe("stop");
    expect(b.unspent.request_id).toHaveLength(64);
    expect(Number(b.unspent.credits_charged)).toBeGreaterThan(0);
    const sent = JSON.parse(h.mock.requests[0]!.body);
    expect(sent.temperature).toBeUndefined();
    expect(sent.system).toBe("s");
  });

  it("stream with include_usage ends with usage, unspent and [DONE]", async () => {
    h = await startHarness();
    const res = await h.chat({
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const text = await res.text();
    const datas = text.split("\n\n").filter(Boolean);
    expect(datas.at(-1)).toBe("data: [DONE]");
    const last = JSON.parse(datas.at(-2)!.slice(6));
    expect(last.usage.prompt_tokens).toBeGreaterThan(0);
    expect(last.unspent.credits_charged).toBeTruthy();
  });

  it("errors in the OpenAI format", async () => {
    h = await startHarness({ credits: 0n });
    const res = await h.chat({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe("insufficient_credits");
    const bad = await h.chat({
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "hi" }],
      n: 2,
    });
    expect(bad.status).toBe(400);
  });
});

void sleep;
