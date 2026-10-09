// The Anthropic API as the upstream provider (brief 8.2). One attempt per request: plain fetch, no retries.
// Several keys spread rate limits; a key answered with 401/403 is taken out of rotation and alerted on.

import type { Logger } from "./log";

/** Response headers passed back to the client (brief 8.7). */
const FORWARD_RESPONSE = /^(content-type|request-id|retry-after|x-should-retry|anthropic-.*)$/i;

export function forwardedResponseHeaders(res: Response): Headers {
  const h = new Headers();
  res.headers.forEach((v, k) => {
    if (FORWARD_RESPONSE.test(k)) h.set(k, v);
  });
  return h;
}

export class AnthropicUpstream {
  private readonly disabled = new Set<string>();
  private next = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly keys: string[],
    private readonly log: Logger,
  ) {}

  available(): boolean {
    return this.keys.some((k) => !this.disabled.has(k));
  }

  private pick(): string | null {
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[(this.next + i) % this.keys.length]!;
      if (!this.disabled.has(k)) {
        this.next = (this.next + i + 1) % this.keys.length;
        return k;
      }
    }
    return null;
  }

  disable(key: string, status: number) {
    if (this.disabled.has(key)) return;
    this.disabled.add(key);
    this.log.alert("provider_key_disabled", {
      provider: "anthropic",
      status,
      key_last4: key.slice(-4),
      remaining: this.keys.length - this.disabled.size,
    });
  }

  /** anthropic-* request headers are forwarded unchanged (brief 8.7); our key replaces the client's. */
  private headers(client: Headers | null, key: string): Headers {
    const h = new Headers({
      "content-type": "application/json",
      "x-api-key": key,
      "user-agent": "unspent-gateway",
    });
    client?.forEach((v, k) => {
      if (/^anthropic-/i.test(k)) h.set(k, v);
    });
    if (!h.has("anthropic-version")) h.set("anthropic-version", "2023-06-01");
    return h;
  }

  /** Sends the body bytes exactly as received. Returns the key used so a 401/403 can disable it. */
  async send(
    pathAndQuery: string,
    body: Uint8Array,
    client: Headers | null,
    signal: AbortSignal,
  ): Promise<{ res: Response; key: string }> {
    const key = this.pick();
    if (!key) throw new Error("no provider key available");
    const res = await fetch(new URL(pathAndQuery, this.baseUrl), {
      method: "POST",
      headers: this.headers(client, key),
      body: body as Uint8Array<ArrayBuffer>,
      signal,
    });
    return { res, key };
  }

  /** Exact input count for requests with images or documents (free endpoint). */
  async countTokens(body: Record<string, unknown>, client: Headers | null): Promise<number> {
    const { model, messages, system, tools, tool_choice, thinking } = body;
    const payload = JSON.stringify({ model, messages, system, tools, tool_choice, thinking });
    const { res } = await this.send(
      "/v1/messages/count_tokens",
      new TextEncoder().encode(payload),
      client,
      AbortSignal.timeout(15_000),
    );
    if (!res.ok) throw new Error(`count_tokens ${res.status}`);
    return ((await res.json()) as { input_tokens: number }).input_tokens;
  }
}
