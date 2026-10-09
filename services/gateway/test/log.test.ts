// Alerts reach chat webhooks: Slack and Telegram read `text`, Discord reads `content`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log";

afterEach(() => vi.unstubAllGlobals());

describe("alert webhook", () => {
  it("posts a chat message with the alert and its fields", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    const lines: string[] = [];
    createLogger({ webhookUrl: "https://hooks.example/x", sink: (l) => lines.push(l) }).alert(
      "provider_key_disabled",
      { key: 2, amount: 5n },
    );
    expect(lines).toHaveLength(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example/x");
    const body = JSON.parse(init.body as string);
    expect(body.content).toBe(body.text);
    expect(body.text).toContain("Unspent alert:");
    expect(body.text).toContain('"msg":"provider_key_disabled"');
    expect(body.text).toContain('"amount":"5"');
  });
});
