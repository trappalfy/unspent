import { Hono } from "hono";
import type { GatewayConfig } from "./config";
import { anthropicError, openaiError } from "./errors";
import { modelsResponse } from "./models";

// Routes match on path only, so Claude Code's /v1/messages?beta=true lands on /v1/messages (brief 8.7).
export function createApp(config: GatewayConfig) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));
  // Hono serves HEAD through the GET route.
  app.get("/api/hello", (c) => c.body(null, 200));

  app.get("/v1/models", (c) => c.json(modelsResponse(config.markupBps)));

  // Stage 4 implements these against the mock provider and a local validator.
  app.post("/v1/messages", (c) => c.json(anthropicError("api_error", "Not implemented yet."), 501));
  app.post("/v1/messages/count_tokens", (c) =>
    c.json(anthropicError("api_error", "Not implemented yet."), 501),
  );
  app.post("/v1/chat/completions", (c) =>
    c.json(openaiError("not_implemented", "Not implemented yet.", "api_error"), 501),
  );
  app.get("/v1/balance", (c) => c.json(anthropicError("api_error", "Not implemented yet."), 501));

  // Batch API, Files API and everything else under /v1 are not offered in v1 (brief 5.2).
  app.all("/v1/*", (c) => c.json(anthropicError("not_found_error", `Not found: ${c.req.path}`), 404));

  return app;
}
