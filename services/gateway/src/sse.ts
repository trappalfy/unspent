// Incremental parser for the provider's SSE stream. The gateway forwards raw bytes untouched; this only observes
// events to meter usage (brief 8.6) and to estimate output if the stream breaks (brief 5.5 step 8).

import { estimateOutputTokens, type Usage } from "@unspent/shared";

export type SseEvent = { event: string; data: string };

export class SseParser {
  private buf = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): SseEvent[] {
    this.buf += this.decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    const out: SseEvent[] = [];
    let i = this.buf.indexOf("\n\n");
    while (i >= 0) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      let event = "message";
      const data: string[] = [];
      for (const l of raw.split("\n")) {
        if (l.startsWith("event:")) event = l.slice(6).trim();
        else if (l.startsWith("data:")) data.push(l.slice(5).replace(/^ /, ""));
      }
      if (data.length) out.push({ event, data: data.join("\n") });
      i = this.buf.indexOf("\n\n");
    }
    return out;
  }
}

type RawUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
  server_tool_use?: Record<string, number | null | undefined> | null;
  iterations?: RawUsage[] | null;
  type?: string;
  [k: string]: unknown;
};

/** Usage fields the gateway knows how to price. Anything else non-zero in usage is reported for an alert. */
const KNOWN_USAGE = new Set([
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "cache_creation",
  "server_tool_use",
  "service_tier",
  "inference_geo",
  "output_tokens_details",
  "iterations",
]);
const KNOWN_SERVER_TOOLS = new Set(["web_search_requests", "web_fetch_requests"]);

export class UsageMeter {
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  cacheWrite5m: number | undefined;
  cacheWrite1h: number | undefined;
  webSearch = 0;
  webFetch = 0;
  deltaChars = 0;
  sawStart = false;
  sawStop = false;
  errorEvent: string | null = null;
  providerRequestId: string | null = null;
  unknownFields = new Set<string>();
  /** Tokens of non-message iterations, which the top-level counts leave out. */
  private extra = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  private apply(u: RawUsage | undefined | null) {
    if (!u) return;
    if (Array.isArray(u.iterations)) {
      // A client that enables the compaction beta gets `iterations` on every response. Its message entries are what the
      // top-level counts already sum; any other entry (a compaction, which the filter refuses) is billed on top.
      const n = (v: unknown) => (typeof v === "number" ? v : 0);
      this.extra = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const it of u.iterations) {
        if (it?.type === "message") continue;
        this.unknownFields.add(`iterations.${String(it?.type)}`);
        this.extra.input += n(it?.input_tokens);
        this.extra.output += n(it?.output_tokens);
        this.extra.cacheRead += n(it?.cache_read_input_tokens);
        this.extra.cacheWrite += n(it?.cache_creation_input_tokens);
      }
    }
    if (typeof u.input_tokens === "number") this.input = u.input_tokens;
    if (typeof u.output_tokens === "number") this.output = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number") this.cacheRead = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") this.cacheWrite = u.cache_creation_input_tokens;
    if (u.cache_creation) {
      if (typeof u.cache_creation.ephemeral_5m_input_tokens === "number")
        this.cacheWrite5m = u.cache_creation.ephemeral_5m_input_tokens;
      if (typeof u.cache_creation.ephemeral_1h_input_tokens === "number")
        this.cacheWrite1h = u.cache_creation.ephemeral_1h_input_tokens;
    }
    const stu = u.server_tool_use;
    if (stu) {
      if (typeof stu.web_search_requests === "number") this.webSearch = stu.web_search_requests;
      if (typeof stu.web_fetch_requests === "number") this.webFetch = stu.web_fetch_requests;
      for (const [k, v] of Object.entries(stu))
        if (!KNOWN_SERVER_TOOLS.has(k) && v) this.unknownFields.add(`server_tool_use.${k}`);
    }
    for (const [k, v] of Object.entries(u)) {
      if (!KNOWN_USAGE.has(k) && v !== null && v !== 0 && !(Array.isArray(v) && v.length === 0))
        this.unknownFields.add(k);
    }
  }

  /** Observe one SSE event of a Messages stream. */
  observe(ev: SseEvent) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (d.type) {
      case "message_start": {
        this.sawStart = true;
        const m = d.message as { id?: string; usage?: RawUsage } | undefined;
        this.apply(m?.usage);
        break;
      }
      case "message_delta":
        this.apply(d.usage as RawUsage);
        break;
      case "message_stop":
        this.sawStop = true;
        break;
      case "content_block_delta": {
        const delta = d.delta as Record<string, unknown> | undefined;
        for (const key of ["text", "thinking", "partial_json", "signature"]) {
          const v = delta?.[key];
          if (typeof v === "string") this.deltaChars += v.length;
        }
        break;
      }
      case "error":
        this.errorEvent = JSON.stringify(d.error ?? null);
        break;
    }
  }

  /** Observe a complete non-streaming Message. */
  observeMessage(m: { usage?: RawUsage }) {
    this.sawStart = true;
    this.sawStop = true;
    this.apply(m.usage);
  }

  get complete(): boolean {
    return this.sawStop && !this.errorEvent;
  }

  /** Usage for billing; when the stream broke, output is the larger of the last reported and the delta estimate. */
  toUsage(): { usage: Usage; estimated: boolean } {
    const estimated = !this.complete;
    const output = estimated ? Math.max(this.output, estimateOutputTokens(this.deltaChars)) : this.output;
    const known = (this.cacheWrite5m ?? 0) + (this.cacheWrite1h ?? 0);
    return {
      estimated,
      usage: {
        inputTokens: this.input + this.extra.input,
        outputTokens: output + this.extra.output,
        cacheReadInputTokens: this.cacheRead + this.extra.cacheRead,
        cacheCreationInputTokens: Math.max(this.cacheWrite, known) + this.extra.cacheWrite,
        cacheCreation5mInputTokens: this.cacheWrite5m,
        cacheCreation1hInputTokens: this.cacheWrite1h,
        webSearchRequests: this.webSearch,
      },
    };
  }
}
