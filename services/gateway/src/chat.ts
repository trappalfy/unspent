// POST /v1/chat/completions for Claude models (brief 8.8): OpenAI request → Messages API through the same pipeline →
// OpenAI response. Every response and the final stream chunk carry `unspent: { request_id, credits_charged, available }`.

import { ucrToCredits } from "@unspent/shared";
import type { Context } from "hono";
import { readJson, streamHeaders } from "./app";
import { authenticate } from "./auth";
import { hex } from "./chain";
import { gwErr, renderOpenAI } from "./errors";
import {
  type AnthropicMessage,
  anthropicErrorToOpenAI,
  createStreamTranslator,
  translateRequest,
  translateResponse,
  type UnspentInfo,
} from "./openai";
import { type Deps, dispatch, type Prepared, prepare } from "./pipeline";

const json = (body: unknown, status: number, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function unspentInfo(deps: Deps, pr: Prepared, charged: bigint): Promise<UnspentInfo> {
  // Available once this request settles: the hold is released and only `charged` is burned.
  const u = await deps.chain.user(pr.key.wallet);
  const now = u ? u.balance - u.reserved : 0n;
  const after = now + pr.reservedUcr - charged;
  return {
    request_id: hex(pr.requestId),
    credits_charged: ucrToCredits(charged),
    available: ucrToCredits(after < 0n ? 0n : after),
  };
}

export async function chatCompletions(c: Context, deps: Deps): Promise<Response> {
  const key = await authenticate(deps.db, c.req.raw.headers);
  if (!key) return renderOpenAI(gwErr(401, "authentication_error", "invalid_api_key", "Invalid API key."));
  const parsed = await readJson(c.req.raw);
  if ("status" in parsed) return renderOpenAI(parsed);
  const tr = translateRequest(parsed.body);
  if (!tr.ok) return json(tr.error, tr.status);

  const body = tr.messages as unknown as Record<string, unknown>;
  const raw = new TextEncoder().encode(JSON.stringify(body));
  const r = await prepare(deps, {
    key,
    body,
    raw,
    headers: c.req.raw.headers,
    endpoint: "chat_completions",
    aborted: c.req.raw.signal,
  });
  if (!r.ok) return renderOpenAI(r.error);
  const pr = r.prepared;
  const providerDown = () =>
    renderOpenAI(
      gwErr(
        503,
        "overloaded_error",
        "provider_unavailable",
        "Model provider is unavailable right now. You were not charged.",
      ),
    );

  if (!tr.stream) {
    const d = await dispatch(deps, pr, "/v1/messages", null, { forwardRaw: false });
    if (d.kind === "unavailable") return providerDown();
    if (d.kind === "provider_error") return providerError(d.status, d.body, d.headers);
    if (d.kind !== "json") return providerDown();
    const info = await unspentInfo(deps, pr, await d.charged);
    return json(translateResponse(d.message as unknown as AnthropicMessage, info), 200, {
      "x-unspent-request-id": info.request_id,
    });
  }

  const translator = createStreamTranslator({ model: String(body.model), includeUsage: tr.includeUsage });
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let gone = false;
  const out = new ReadableStream<Uint8Array>({
    start(c2) {
      ctrl = c2;
    },
    cancel() {
      gone = true;
    },
  });
  const emit = (lines: string[]) => {
    if (gone) return;
    try {
      for (const l of lines) ctrl.enqueue(enc.encode(l));
    } catch {
      gone = true;
    }
  };
  const d = await dispatch(deps, pr, "/v1/messages", null, {
    forwardRaw: false,
    onEvent: (ev) => {
      try {
        emit(translator.push({ event: ev.event, data: JSON.parse(ev.data) }));
      } catch {}
    },
  });
  if (d.kind === "unavailable") return providerDown();
  if (d.kind === "provider_error") return providerError(d.status, d.body, d.headers);
  if (d.kind !== "stream") return providerDown();

  void d.charged
    .then(async (charged) => {
      if (!translator.done) {
        const m = d.meter;
        if (!m.complete)
          emit(
            translator.fail(
              anthropicErrorToOpenAI(502, {
                type: "error",
                error: { type: "api_error", message: "The model stream ended early." },
              }),
            ),
          );
        else
          emit(
            translator.finish(await unspentInfo(deps, pr, charged), {
              input_tokens: m.input,
              output_tokens: m.output,
              cache_read_input_tokens: m.cacheRead,
              cache_creation_input_tokens: m.cacheWrite,
            }),
          );
      }
    })
    .catch(() => {})
    .finally(() => {
      if (!gone) {
        try {
          ctrl.close();
        } catch {}
      }
    });
  const h = streamHeaders(new Headers());
  h.set("x-unspent-request-id", hex(pr.requestId));
  return new Response(out, { status: 200, headers: h });
}

function providerError(status: number, body: string, headers: Headers): Response {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {}
  const h: Record<string, string> = {};
  const ra = headers.get("retry-after");
  if (ra) h["retry-after"] = ra;
  return json(anthropicErrorToOpenAI(status, parsed), status, h);
}
