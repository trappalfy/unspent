/**
 * Mock of the Anthropic Messages API for gateway tests (brief rule 0.3, section 13): no paid calls.
 * Wire format follows platform.claude.com/docs (streaming, api/messages, api/errors, api/models/list).
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ERROR_DEFAULTS,
  type ErrorHeaderOptions,
  errorBody,
  errorHeaders,
  statusForErrorType,
} from "./fixtures/errors";
import { successHeaders } from "./fixtures/headers";
import { getModel, listModels } from "./fixtures/models";
import {
  buildMessage,
  buildStreamPlan,
  estimateInputTokens,
  ids,
  planDurationMs,
  type Scenario,
  timingOf,
} from "./fixtures/scenarios";
import { encodeSse } from "./sse";

export * from "./fixtures/errors";
export * from "./fixtures/headers";
export * from "./fixtures/models";
export * from "./fixtures/scenarios";
export * from "./fixtures/usage";
export * from "./sse";

export interface RecordedRequest {
  method: string;
  /** Path with query string, e.g. `/v1/messages?beta=true`. */
  path: string;
  /** Lower-cased names; repeated headers joined with ", ". */
  headers: Record<string, string>;
  /** Raw body exactly as received (UTF-8). */
  body: string;
  /** Parsed body; undefined when the body is not JSON. */
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary request fields
  json: any;
  receivedAt: number;
  /** The connection closed before the mock finished its response (client abort, or mock closed). */
  clientAborted: boolean;
  /** When the response was fully written; null while in flight, aborted or dropped. */
  finishedAt: number | null;
}

export type ScenarioSource = Scenario | ((req: RecordedRequest) => Scenario);

export interface MockAnthropic {
  url: string;
  requests: RecordedRequest[];
  /** Applies to POST /v1/messages and /v1/messages/count_tokens; the default is { type: "text" }. */
  setScenario(s: ScenarioSource): void;
  close(): Promise<void>;
}

const DEFAULT_MODEL = "claude-opus-5-5";

export async function startMockAnthropic(): Promise<MockAnthropic> {
  const requests: RecordedRequest[] = [];
  let source: ScenarioSource = { type: "text" };
  let counter = 0;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const receivedAt = Date.now();
    const abort = new AbortController();
    const signal = abort.signal;
    let rec: RecordedRequest | undefined;
    let dropping = false;
    res.on("close", () => {
      abort.abort();
      if (rec && !res.writableFinished && !dropping) rec.clientAborted = true;
    });
    res.on("finish", () => {
      if (rec) rec.finishedAt = Date.now();
    });

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    rec = {
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: flattenHeaders(req.headers),
      body,
      json: parseJson(body),
      receivedAt,
      clientAborted: false,
      finishedAt: null,
    };
    requests.push(rec);

    const n = ++counter;
    const requestId = ids.request(n);
    const url = new URL(rec.path, "http://mock.invalid");
    const route = `${rec.method} ${url.pathname}`;
    const fail = (status: number, type: string, message: string, opts?: ErrorHeaderOptions, extra = {}) =>
      sendJson(res, status, errorBody(type, message, requestId), {
        ...errorHeaders(status, requestId, opts),
        ...extra,
      });

    if (route === "GET /v1/models") {
      return sendJson(res, 200, listModels(url.searchParams), successHeaders(requestId, "json"));
    }
    if (rec.method === "GET" && url.pathname.startsWith("/v1/models/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/models/".length));
      const model = getModel(id);
      if (model) return sendJson(res, 200, model, successHeaders(requestId, "json"));
      return fail(404, "not_found_error", `model: ${id}`);
    }
    const countTokens = route === "POST /v1/messages/count_tokens";
    if (route !== "POST /v1/messages" && !countTokens) return fail(404, "not_found_error", "Not Found");
    if (typeof rec.json !== "object" || rec.json === null) {
      return fail(
        400,
        "invalid_request_error",
        "There was an issue with the format or content of your request.",
      );
    }

    const scenario = typeof source === "function" ? source(rec) : source;
    const timing = timingOf(scenario);
    const extra = scenario.headers ?? {};
    if (!(await pause(timing.headersDelayMs, signal))) return;

    if (scenario.type === "error_before_first_token") {
      const defaults = ERROR_DEFAULTS[scenario.status];
      return fail(
        scenario.status,
        scenario.errorType ?? defaults.type,
        scenario.message ?? defaults.message,
        { retryAfter: scenario.retryAfter, shouldRetry: scenario.shouldRetry },
        extra,
      );
    }
    if (countTokens) {
      const input_tokens = scenario.countTokens ?? estimateInputTokens(rec.json);
      return sendJson(res, 200, { input_tokens }, successHeaders(requestId, "json", extra));
    }

    const ctx = { n, model: typeof rec.json.model === "string" ? rec.json.model : DEFAULT_MODEL };
    const plan = buildStreamPlan(scenario, ctx);

    if (rec.json.stream) {
      res.writeHead(200, successHeaders(requestId, "stream", extra));
      res.flushHeaders();
      for (const [i, event] of plan.events.entries()) {
        if (!(await pause(event.delayMs ?? (i === 0 ? 0 : timing.chunkDelayMs), signal))) return;
        if (!(await write(res, encodeSse(event)))) return;
      }
      if (plan.ending === "destroy") {
        dropping = true;
        res.destroy();
      } else {
        res.end();
      }
      return;
    }

    // Non-streaming: take as long as the stream would, then answer in one piece.
    if (!(await pause(planDurationMs(plan, timing.chunkDelayMs), signal))) return;
    if (scenario.type === "drop_mid_stream") {
      dropping = true;
      res.destroy();
      return;
    }
    if (scenario.type === "error_mid_stream") {
      const type = scenario.errorType ?? "overloaded_error";
      return fail(statusForErrorType(type), type, scenario.message ?? "Overloaded", {}, extra);
    }
    return sendJson(res, 200, buildMessage(scenario, ctx), successHeaders(requestId, "json", extra));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) res.destroy();
      else
        sendJson(res, 500, errorBody("api_error", `mock failure: ${String(err)}`, "req_mock_error"), {
          "content-type": "application/json",
        });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setScenario(s) {
      source = s;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...headers, "content-length": String(Buffer.byteLength(text)) });
  res.end(text);
}

/** Resolves once the chunk is handed to the socket; false if the response is gone. */
function write(res: ServerResponse, chunk: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (res.destroyed || res.writableEnded) return resolve(false);
    res.write(chunk, (err) => resolve(!err));
  });
}

/** Waits `ms`; false if the connection closed meanwhile. */
async function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (ms > 0) await sleep(ms, undefined, { signal }).catch(() => {});
  return !signal.aborted;
}
