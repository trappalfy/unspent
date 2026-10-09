import { ucrToCredits } from "@unspent/shared";
import { Hono } from "hono";
import { authenticate } from "./auth";
import { chatCompletions } from "./chat";
import { type GatewayError, gwErr, renderAnthropic } from "./errors";
import { modelsResponse } from "./models";
import { type Deps, dispatch, prepare } from "./pipeline";

const unauthorized = gwErr(401, "authentication_error", "invalid_api_key", "Invalid API key.");
const providerDown = gwErr(
  503,
  "overloaded_error",
  "provider_unavailable",
  "Model provider is unavailable right now. You were not charged.",
);

export async function readJson(
  req: Request,
): Promise<{ raw: Uint8Array; body: Record<string, unknown> } | GatewayError> {
  const raw = new Uint8Array(await req.arrayBuffer());
  try {
    const body = JSON.parse(new TextDecoder().decode(raw));
    if (body && typeof body === "object" && !Array.isArray(body)) return { raw, body };
  } catch {}
  return gwErr(400, "invalid_request_error", "invalid_request", "Request body must be a JSON object.");
}

export function streamHeaders(h: Headers): Headers {
  h.set("content-type", "text/event-stream");
  h.set("cache-control", "no-cache");
  h.set("x-accel-buffering", "no");
  return h;
}

// Routes match on path only, so Claude Code's /v1/messages?beta=true lands on /v1/messages (brief 8.7).
export function createApp(deps: Deps) {
  const app = new Hono();
  app.onError((e, c) => {
    deps.log.error("unhandled", { path: c.req.path, error: e instanceof Error ? e.message : "unknown" });
    return renderAnthropic(
      gwErr(
        500,
        "api_error",
        "internal_error",
        "Internal error. If a reservation was made, it is released automatically.",
      ),
    );
  });

  app.get("/health", (c) => c.json({ ok: true }));
  // Claude Code connection warm-up; Hono serves HEAD through the GET route.
  app.get("/api/hello", (c) => c.body(null, 200));
  app.get("/v1/models", (c) => c.json(modelsResponse(deps.config.markupBps, deps.catalog)));

  app.post("/v1/messages", async (c) => {
    const key = await authenticate(deps.db, c.req.raw.headers);
    if (!key) return renderAnthropic(unauthorized);
    const parsed = await readJson(c.req.raw);
    if ("status" in parsed) return renderAnthropic(parsed);
    const r = await prepare(deps, {
      key,
      ...parsed,
      headers: c.req.raw.headers,
      endpoint: "messages",
      aborted: c.req.raw.signal,
    });
    if (!r.ok) return renderAnthropic(r.error);
    const d = await dispatch(deps, r.prepared, `/v1/messages${new URL(c.req.url).search}`, c.req.raw.headers);
    switch (d.kind) {
      case "unavailable":
        return renderAnthropic(providerDown);
      case "provider_error":
      case "json":
        // Provider bodies are forwarded unchanged (brief 8.7).
        return new Response(d.body, { status: d.status, headers: d.headers });
      case "stream":
        return new Response(d.body, { status: d.status, headers: streamHeaders(d.headers) });
    }
  });

  app.post("/v1/chat/completions", (c) => chatCompletions(c, deps));

  // Free token counting, forwarded as is.
  app.post("/v1/messages/count_tokens", async (c) => {
    const key = await authenticate(deps.db, c.req.raw.headers);
    if (!key) return renderAnthropic(unauthorized);
    const slot = deps.limiter.acquire(key.id, key.wallet);
    if (!slot.ok)
      return renderAnthropic(
        gwErr(429, "rate_limit_error", "rate_limit_exceeded", "Rate limit exceeded. Retry later.", {
          retryAfterSec: slot.retryAfterSec,
        }),
      );
    try {
      if (!deps.upstream.available()) return renderAnthropic(providerDown);
      const raw = new Uint8Array(await c.req.arrayBuffer());
      const { res } = await deps.upstream.send(
        `/v1/messages/count_tokens${new URL(c.req.url).search}`,
        raw,
        c.req.raw.headers,
        AbortSignal.timeout(30_000),
      );
      const { forwardedResponseHeaders } = await import("./upstream");
      return new Response(await res.text(), { status: res.status, headers: forwardedResponseHeaders(res) });
    } finally {
      slot.release();
    }
  });

  app.get("/v1/balance", async (c) => {
    const key = await authenticate(deps.db, c.req.raw.headers);
    if (!key) return renderAnthropic(unauthorized);
    const u = await deps.chain.user(key.wallet);
    const balance = u?.balance ?? 0n;
    const reserved = u?.reserved ?? 0n;
    return c.json({
      available: ucrToCredits(balance - reserved),
      reserved: ucrToCredits(reserved),
      balance: ucrToCredits(balance),
    });
  });

  // Batch API, Files API and everything else under /v1 are not offered in v1 (brief 5.2).
  app.all("/v1/*", (c) =>
    c.json({ type: "error", error: { type: "not_found_error", message: `Not found: ${c.req.path}` } }, 404),
  );

  return app;
}
