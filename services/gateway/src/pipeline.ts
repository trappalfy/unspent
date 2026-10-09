// Request lifecycle (brief 5.5): checks → reservation onchain → one provider call → metered cost → settle queue.
// Format-agnostic: routes render errors and responses in the Anthropic or OpenAI format.

import { and, apiKeys, eq, gte, inArray, requests, settleQueue, sql, sum } from "@unspent/db";
import {
  applyMarkup,
  CLAUDE_MODELS,
  chargeUcr,
  costPusd,
  estimateInputTokens,
  findModel,
  formatCredits,
  MIN_CHARGE_UCR,
  type ModelEntry,
  maxRequestDurationSec,
  minBig,
  reservationUcr,
} from "@unspent/shared";
import type { AuthedKey } from "./auth";
import { type Chain, hex } from "./chain";
import type { GatewayConfig } from "./config";
import type { Db } from "./db";
import { type GatewayError, gwErr } from "./errors";
import { estimateBody, toReservationInput } from "./estimate";
import { filterMessagesBody } from "./filter";
import { claimIdempotency, linkIdempotency, releaseIdempotency } from "./idempotency";
import type { Logger } from "./log";
import type { RateLimiter } from "./ratelimit";
import { type SseEvent, SseParser, UsageMeter } from "./sse";
import { type AnthropicUpstream, forwardedResponseHeaders } from "./upstream";

export type Deps = {
  config: GatewayConfig;
  db: Db;
  chain: Chain;
  upstream: AnthropicUpstream;
  limiter: RateLimiter;
  log: Logger;
  catalog?: ModelEntry[];
};

export type Endpoint = "messages" | "chat_completions";

export type Prepared = {
  key: AuthedKey;
  model: ModelEntry;
  body: Record<string, unknown>;
  /** Bytes forwarded to the provider: the client's original bytes on /v1/messages. */
  raw: Uint8Array;
  requestUuid: string;
  requestId: Uint8Array;
  reservedUcr: bigint;
  idemKey: Uint8Array | null;
  releaseSlot: () => void;
};

const credits = (ucr: bigint) => formatCredits(ucr, 2, "ceil");
const OPEN_STATUSES = ["reserving", "reserved", "dispatched"] as const;

function utcMidnight(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Everything up to and including the onchain reservation. */
export async function prepare(
  deps: Deps,
  p: {
    key: AuthedKey;
    body: Record<string, unknown>;
    raw: Uint8Array;
    headers: Headers;
    endpoint: Endpoint;
    aborted: AbortSignal;
  },
): Promise<{ ok: true; prepared: Prepared } | { ok: false; error: GatewayError }> {
  const { db, chain, config, log } = deps;
  const { key, body } = p;
  const fail = (error: GatewayError) => ({ ok: false as const, error });

  const program = await chain.program();
  if (program.shutDown) {
    return fail(
      gwErr(
        410,
        "invalid_request_error",
        "service_shut_down",
        `Unspent is shut down. Withdraw and redeem your credits at ${config.siteUrl}/app.`,
      ),
    );
  }
  const model = findModel(String(body.model), deps.catalog ?? CLAUDE_MODELS);
  const path = p.endpoint === "messages" ? "/v1/messages" : "/v1/chat/completions";
  if (!model?.enabled || !model.endpoints.includes(path)) {
    return fail(
      gwErr(
        400,
        "invalid_request_error",
        "model_not_found",
        `Model ${String(body.model)} is not available on Unspent. See /v1/models.`,
      ),
    );
  }
  if (key.allowedModels?.length && !key.allowedModels.includes(model.id)) {
    return fail(
      gwErr(
        400,
        "invalid_request_error",
        "model_not_found",
        `Model ${model.id} is not allowed for this API key.`,
      ),
    );
  }
  const filtered = filterMessagesBody(body);
  if (filtered) return fail(gwErr(400, "invalid_request_error", "unsupported_parameter", filtered.message));
  if (!deps.upstream.available()) {
    return fail(
      gwErr(
        503,
        "overloaded_error",
        "provider_unavailable",
        "Model provider is unavailable right now. You were not charged.",
      ),
    );
  }

  const slot = deps.limiter.acquire(key.id, key.wallet);
  if (!slot.ok) {
    return fail(
      gwErr(429, "rate_limit_error", "rate_limit_exceeded", "Rate limit exceeded. Retry later.", {
        retryAfterSec: slot.retryAfterSec,
      }),
    );
  }
  let keepSlot = false;
  let idemKey: Uint8Array | null = null;
  const freeIdem = async () => {
    if (idemKey) await releaseIdempotency(db, key.wallet, idemKey);
  };
  try {
    const idem = await claimIdempotency(db, key.wallet, p.headers.get("idempotency-key"), body);
    switch (idem.kind) {
      case "invalid":
        return fail(
          gwErr(400, "invalid_request_error", "invalid_request", "Idempotency-Key must be 8–128 characters."),
        );
      case "reused":
        return fail(
          gwErr(
            409,
            "invalid_request_error",
            "idempotency_key_reused",
            "This Idempotency-Key was used with a different request body.",
          ),
        );
      case "in_progress":
        return fail(
          gwErr(
            409,
            "invalid_request_error",
            "request_in_progress",
            "A request with this Idempotency-Key is still running.",
          ),
        );
      case "already_processed":
        return fail(
          gwErr(
            409,
            "invalid_request_error",
            "already_processed",
            "A request with this Idempotency-Key was already processed.",
            {
              extra: {
                unspent: {
                  request_id: idem.requestId,
                  credits_charged: idem.chargedUcr === null ? null : credits(idem.chargedUcr),
                },
              },
            },
          ),
        );
      case "claimed":
        idemKey = idem.keyHash;
    }

    const est = estimateBody(body);
    const inputTokens = est.needsExactCount
      ? await deps.upstream.countTokens(body, p.headers)
      : estimateInputTokens(est.textBytes, model.contextWindow);
    const amount = reservationUcr(model, toReservationInput(est, inputTokens), {
      markupBps: config.markupBps,
    });
    if (amount > program.maxReservation) {
      await freeIdem();
      return fail(
        gwErr(
          400,
          "invalid_request_error",
          "request_too_expensive",
          `This request may cost up to ${credits(amount)} credits, above the ${credits(program.maxReservation)}-credit limit per request. Lower max_tokens.`,
        ),
      );
    }
    const user = await chain.user(key.wallet);
    const available = user ? user.balance - user.reserved : 0n;
    if (amount > available) {
      await freeIdem();
      return fail(
        gwErr(
          402,
          "billing_error",
          "insufficient_credits",
          `Not enough credits. Available: ${formatCredits(available, 2)}, this request may cost up to ${credits(amount)}. Lower max_tokens or top up.`,
        ),
      );
    }
    const holdLimit =
      user && user.reserveCap > 0n
        ? minBig(user.reserveCap, program.maxReservedPerUser)
        : program.maxReservedPerUser;
    if ((user?.reserved ?? 0n) + amount > holdLimit) {
      await freeIdem();
      return fail(
        gwErr(
          429,
          "rate_limit_error",
          "too_many_in_flight",
          "Too many requests in flight for this wallet. Wait for them to finish.",
          { retryAfterSec: 5 },
        ),
      );
    }

    // Daily key limit, checked and recorded atomically under a row lock on the key (brief 8.3).
    const requestId = crypto.getRandomValues(new Uint8Array(32));
    const tier = model.tiers.map((t) => ({
      maxPromptTokens: t.maxPromptTokens,
      ...Object.fromEntries(Object.entries(t.prices).map(([k, v]) => [k, v.toString()])),
    }));
    const requestUuid = await db.transaction(async (tx) => {
      await tx.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.id, key.id)).for("update");
      if (key.dailyLimitUcr !== null) {
        const [spent] = await tx
          .select({ v: sum(requests.chargedUcr) })
          .from(requests)
          .where(and(eq(requests.apiKeyId, key.id), gte(requests.createdAt, utcMidnight())));
        const [held] = await tx
          .select({ v: sum(requests.reservedUcr) })
          .from(requests)
          .where(and(eq(requests.apiKeyId, key.id), inArray(requests.status, [...OPEN_STATUSES])));
        if (BigInt(spent?.v ?? 0) + BigInt(held?.v ?? 0) + amount > key.dailyLimitUcr) return null;
      }
      const [row] = await tx
        .insert(requests)
        .values({
          requestId,
          apiKeyId: key.id,
          wallet: key.wallet,
          network: config.network,
          model: model.id,
          provider: model.provider,
          endpoint: p.endpoint,
          status: "reserving",
          reservedUcr: amount,
          prices: { tiers: JSON.stringify(tier) },
          ccSessionId: p.headers.get("x-claude-code-session-id"),
          ccAgentId: p.headers.get("x-claude-code-agent-id"),
        })
        .returning({ id: requests.id });
      await tx.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id));
      return row!.id;
    });
    if (!requestUuid) {
      await freeIdem();
      return fail(
        gwErr(
          429,
          "rate_limit_error",
          "key_limit_exceeded",
          `This key reached its daily limit of ${formatCredits(key.dailyLimitUcr!, 2)} credits.`,
        ),
      );
    }
    if (idemKey) await linkIdempotency(db, key.wallet, idemKey, requestUuid);

    const result = await chain.reserve(
      requestId,
      key.wallet,
      amount,
      async (signature, lastValidBlockHeight) => {
        await db
          .update(requests)
          .set({ reserveSig: signature, reserveLastValidBlockHeight: lastValidBlockHeight })
          .where(eq(requests.id, requestUuid));
      },
      config.reserveTimeoutMs,
    );
    if (result.kind === "timeout") {
      // Never dispatched from here on; the reconciler releases it if the transaction lands later.
      await db.update(requests).set({ status: "reserve_timeout" }).where(eq(requests.id, requestUuid));
      await freeIdem();
      return fail(
        gwErr(
          503,
          "overloaded_error",
          "reservation_timeout",
          "Solana did not confirm the reservation in time. You were not charged.",
          { retryAfterSec: 5 },
        ),
      );
    }
    if (result.kind === "rejected") {
      await db
        .update(requests)
        .set({ status: "released", errorCode: `program_${result.code ?? "unknown"}` })
        .where(eq(requests.id, requestUuid));
      await freeIdem();
      log.warn("reserve rejected", { request: hex(requestId), code: result.code });
      return fail(rejectionError(result.code, amount, deps));
    }

    await db.update(requests).set({ status: "reserved" }).where(eq(requests.id, requestUuid));
    if (p.aborted.aborted) {
      // The client left before dispatch: release now and never call the provider.
      await finalize(
        deps,
        { requestUuid, requestId, wallet: key.wallet, model, reservedUcr: amount },
        { kind: "charge", chargedUcr: 0n, httpStatus: 499 },
      );
      await freeIdem();
      return fail(gwErr(499, "invalid_request_error", "client_closed", "Client closed the request."));
    }
    keepSlot = true;
    return {
      ok: true,
      prepared: {
        key,
        model,
        body,
        raw: p.raw,
        requestUuid,
        requestId,
        reservedUcr: amount,
        idemKey,
        releaseSlot: slot.release,
      },
    };
  } finally {
    if (!keepSlot) slot.release();
  }
}

function rejectionError(code: number | null, amount: bigint, deps: Deps): GatewayError {
  switch (code) {
    case 0x177c: // InsufficientAvailable: a parallel request reserved first
      return gwErr(
        402,
        "billing_error",
        "insufficient_credits",
        `Not enough credits. This request may cost up to ${credits(amount)}. Lower max_tokens or top up.`,
      );
    case 0x177e: // UserHoldLimitExceeded
      return gwErr(
        429,
        "rate_limit_error",
        "too_many_in_flight",
        "Too many requests in flight for this wallet. Wait for them to finish.",
        { retryAfterSec: 5 },
      );
    case 0x1773: // ShutDown
      return gwErr(
        410,
        "invalid_request_error",
        "service_shut_down",
        `Unspent is shut down. Withdraw and redeem your credits at ${deps.config.siteUrl}/app.`,
      );
    default:
      return gwErr(
        503,
        "overloaded_error",
        "reservation_failed",
        "The reservation was not accepted onchain. You were not charged.",
        { retryAfterSec: 5 },
      );
  }
}

type Billing = {
  requestUuid: string;
  requestId: Uint8Array;
  wallet: string;
  model: ModelEntry;
  reservedUcr: bigint;
};

export type Outcome =
  | { kind: "metered"; meter: UsageMeter; httpStatus: number; providerRequestId: string | null }
  | { kind: "charge"; chargedUcr: bigint; httpStatus: number; providerRequestId?: string | null };

/** Prices the outcome, records it and queues settle(min(cost, reserved)). Unspent pays anything above the reservation. */
export async function finalize(deps: Deps, b: Billing, o: Outcome): Promise<bigint> {
  const now = new Date();
  let actual: bigint;
  const set: Partial<typeof requests.$inferInsert> = {
    status: "completed",
    completedAt: now,
    httpStatus: o.httpStatus,
  };
  if (o.kind === "metered") {
    const { usage, estimated } = o.meter.toUsage();
    const pusd = costPusd(b.model, usage);
    const charge = chargeUcr(b.model, usage, { markupBps: deps.config.markupBps });
    actual = minBig(charge, b.reservedUcr);
    if (charge > b.reservedUcr)
      deps.log.warn("cost above reservation, paid by Unspent", {
        request: hex(b.requestId),
        over_ucr: charge - b.reservedUcr,
      });
    if (o.meter.unknownFields.size)
      deps.log.alert("unmetered_usage_field", {
        request: hex(b.requestId),
        fields: [...o.meter.unknownFields].join(","),
      });
    Object.assign(set, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      cacheWrite5mTokens: usage.cacheCreationInputTokens - (usage.cacheCreation1hInputTokens ?? 0),
      cacheWrite1hTokens: usage.cacheCreation1hInputTokens ?? 0,
      webSearchRequests: usage.webSearchRequests ?? 0,
      costPusd: pusd.toString(),
      costUcr: applyMarkup(pusd, deps.config.markupBps),
      estimated,
      providerRequestId: o.providerRequestId,
    });
  } else {
    actual = minBig(o.chargedUcr, b.reservedUcr);
    if (o.providerRequestId) set.providerRequestId = o.providerRequestId;
  }
  set.chargedUcr = actual;
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ dispatchedAt: requests.dispatchedAt })
      .from(requests)
      .where(eq(requests.id, b.requestUuid));
    if (row?.dispatchedAt) set.durationMs = now.getTime() - row.dispatchedAt.getTime();
    await tx.update(requests).set(set).where(eq(requests.id, b.requestUuid));
    await tx
      .insert(settleQueue)
      .values({ requestUuid: b.requestUuid, requestId: b.requestId, owner: b.wallet, actualUcr: actual })
      .onConflictDoNothing();
  });
  deps.log.info("request completed", {
    request: hex(b.requestId),
    model: b.model.id,
    charged_ucr: actual,
    status: o.httpStatus,
  });
  return actual;
}

export type Dispatch =
  | { kind: "provider_error"; status: number; headers: Headers; body: string; released: boolean }
  | { kind: "unavailable" }
  | {
      kind: "json";
      status: number;
      headers: Headers;
      body: string;
      message: Record<string, unknown>;
      charged: Promise<bigint>;
    }
  | {
      kind: "stream";
      status: number;
      headers: Headers;
      /** Raw upstream bytes, untouched. */
      body: ReadableStream<Uint8Array>;
      charged: Promise<bigint>;
      meter: UsageMeter;
    };

/**
 * Sends the request to the provider exactly once. The stream is forwarded chunk by chunk as it arrives; if the client
 * disconnects the gateway keeps reading to the final usage (brief 5.5 step 5).
 */
export async function dispatch(
  deps: Deps,
  pr: Prepared,
  pathAndQuery: string,
  clientHeaders: Headers | null,
  opts: { onEvent?: (ev: SseEvent) => void; forwardRaw?: boolean } = {},
): Promise<Dispatch> {
  const { db, config } = deps;
  const billing: Billing = {
    requestUuid: pr.requestUuid,
    requestId: pr.requestId,
    wallet: pr.key.wallet,
    model: pr.model,
    reservedUcr: pr.reservedUcr,
  };
  const program = await deps.chain.program();
  const maxMs = maxRequestDurationSec(Number(program.reservationTtl)) * 1000;
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(new Error("max request duration")), maxMs);

  // The dispatch moment is recorded before sending: from here the request counts as sent (brief 8.4).
  await db
    .update(requests)
    .set({ status: "dispatched", dispatchedAt: new Date(), lastProgressAt: new Date() })
    .where(eq(requests.id, pr.requestUuid));

  let res: Response;
  let usedKey: string;
  try {
    ({ res, key: usedKey } = await deps.upstream.send(pathAndQuery, pr.raw, clientHeaders, ac.signal));
  } catch (e) {
    clearTimeout(deadline);
    deps.log.warn("provider unreachable", {
      request: hex(pr.requestId),
      error: e instanceof Error ? e.message : "unknown",
    });
    await finalize(deps, billing, { kind: "charge", chargedUcr: 0n, httpStatus: 502 });
    if (pr.idemKey) await releaseIdempotency(db, pr.key.wallet, pr.idemKey);
    pr.releaseSlot();
    return { kind: "unavailable" };
  }
  const headers = forwardedResponseHeaders(res);
  const providerRequestId = res.headers.get("request-id");
  headers.set("x-unspent-request-id", hex(pr.requestId));

  if (!res.ok) {
    clearTimeout(deadline);
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      // Our provider key was rejected (brief 8.2): release and report the provider as unavailable.
      deps.upstream.disable(usedKey, res.status);
      await finalize(deps, billing, {
        kind: "charge",
        chargedUcr: 0n,
        httpStatus: res.status,
        providerRequestId,
      });
      if (pr.idemKey) await releaseIdempotency(db, pr.key.wallet, pr.idemKey);
      pr.releaseSlot();
      return { kind: "unavailable" };
    }
    // Request's fault (400, 413, 422): the model didn't run but the network did → MIN_CHARGE. Otherwise free.
    const charge = [400, 413, 422].includes(res.status) ? MIN_CHARGE_UCR : 0n;
    await finalize(deps, billing, {
      kind: "charge",
      chargedUcr: charge,
      httpStatus: res.status,
      providerRequestId,
    });
    if (charge === 0n && pr.idemKey) await releaseIdempotency(db, pr.key.wallet, pr.idemKey);
    pr.releaseSlot();
    return { kind: "provider_error", status: res.status, headers, body, released: charge === 0n };
  }

  const meter = new UsageMeter();
  const isStream = (res.headers.get("content-type") ?? "").includes("text/event-stream");
  if (!isStream) {
    const body = await res.text().finally(() => clearTimeout(deadline));
    let message: Record<string, unknown> = {};
    try {
      message = JSON.parse(body);
      meter.observeMessage(message);
    } catch {}
    const charged = finalize(deps, billing, {
      kind: "metered",
      meter,
      httpStatus: res.status,
      providerRequestId,
    }).finally(pr.releaseSlot);
    await charged;
    return { kind: "json", status: res.status, headers, body, message, charged };
  }

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let clientGone = opts.forwardRaw === false;
  const out = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      clientGone = true;
    },
  });
  const upstreamBody = res.body!;
  const charged = (async () => {
    const reader = upstreamBody.getReader();
    const parser = new SseParser();
    let lastProgress = Date.now();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!clientGone) {
          try {
            controller.enqueue(value);
          } catch {
            clientGone = true;
          }
        }
        for (const ev of parser.push(value)) {
          meter.observe(ev);
          opts.onEvent?.(ev);
        }
        if (Date.now() - lastProgress >= config.progressIntervalMs) {
          lastProgress = Date.now();
          await db
            .update(requests)
            .set({ lastProgressAt: new Date() })
            .where(eq(requests.id, pr.requestUuid));
        }
      }
    } catch (e) {
      deps.log.warn("stream interrupted", {
        request: hex(pr.requestId),
        reason: e instanceof Error ? e.message : "unknown",
      });
    } finally {
      clearTimeout(deadline);
    }
    if (!clientGone) {
      try {
        controller.close();
      } catch {}
    }
    try {
      return await finalize(deps, billing, {
        kind: "metered",
        meter,
        httpStatus: res.status,
        providerRequestId,
      });
    } finally {
      pr.releaseSlot();
    }
  })();
  return { kind: "stream", status: res.status, headers, body: out, charged, meter };
}

/** Queue health for tests and metrics. */
export async function pendingSettlements(db: Db): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(settleQueue)
    .where(eq(settleQueue.status, "pending"));
  return r?.n ?? 0;
}
