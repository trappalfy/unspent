// Gateway test harness: PGlite + FakeChain + mock Anthropic provider + a funded wallet with an API key.
// No paid provider calls and no public cluster (brief rule 0.3).

import { serve } from "@hono/node-server";
import { apiKeys, openTestDb, wallets } from "@unspent/db";
import { generateApiKey, sha256 } from "@unspent/shared";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Db } from "../src/db";
import { createLogger } from "../src/log";
import type { Deps } from "../src/pipeline";
import { MemoryRateLimiter } from "../src/ratelimit";
import { Reconciler } from "../src/reconcile";
import { SettleWorker } from "../src/settle";
import { AnthropicUpstream } from "../src/upstream";
import { FakeChain } from "./fakes/chain";
import { type MockAnthropic, startMockAnthropic } from "./mock/mockAnthropic";

export const C = 1_000_000n;

export type Harness = {
  url: string;
  db: Db;
  chain: FakeChain;
  mock: MockAnthropic;
  settle: SettleWorker;
  reconciler: Reconciler;
  logs: string[];
  wallet: string;
  apiKey: string;
  keyId: string;
  deps: Deps;
  newKey(opts?: {
    wallet?: string;
    dailyLimitUcr?: bigint;
    allowedModels?: string[];
  }): Promise<{ apiKey: string; id: string; wallet: string }>;
  messages(body: unknown, headers?: Record<string, string>, key?: string): Promise<Response>;
  chat(body: unknown, headers?: Record<string, string>, key?: string): Promise<Response>;
  close(): Promise<void>;
};

let walletN = 0;
export const newWallet = () => `Wallet${String(++walletN).padStart(4, "0")}${"1".repeat(32)}`.slice(0, 44);

export async function startHarness(
  opts: { credits?: bigint; env?: Record<string, string>; limiter?: MemoryRateLimiter } = {},
): Promise<Harness> {
  const mock = await startMockAnthropic();
  const { db, close: closeDb } = await openTestDb();
  const chain = new FakeChain();
  const logs: string[] = [];
  const log = createLogger({ sink: (l) => logs.push(l) });
  const config = loadConfig({
    PROVIDER_MODE: "mock",
    ANTHROPIC_BASE_URL: mock.url,
    ANTHROPIC_API_KEYS: "sk-ant-test-key-1,sk-ant-test-key-2",
    NEXT_PUBLIC_SOLANA_NETWORK: "localnet",
    RESERVE_TIMEOUT_MS: "200",
    PROGRESS_INTERVAL_MS: "50",
    SETTLE_FLUSH_MS: "20",
    ...opts.env,
  });
  const upstream = new AnthropicUpstream(config.anthropicBaseUrl, config.anthropicKeys, log);
  const deps: Deps = { config, db, chain, upstream, limiter: opts.limiter ?? new MemoryRateLimiter(), log };
  const settle = new SettleWorker(db, chain, log, config.settleFlushMs);
  const reconciler = new Reconciler(db, chain, log, {
    intervalMs: 60_000,
    staleAfterMs: config.staleAfterMs,
  });
  const server = serve({ fetch: createApp(deps).fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  async function newKey(o: { wallet?: string; dailyLimitUcr?: bigint; allowedModels?: string[] } = {}) {
    const wallet = o.wallet ?? newWallet();
    await db.insert(wallets).values({ address: wallet }).onConflictDoNothing();
    const apiKey = generateApiKey("localnet");
    const [row] = await db
      .insert(apiKeys)
      .values({
        wallet,
        network: "localnet",
        name: "test",
        keyHash: await sha256(apiKey),
        last4: apiKey.slice(-4),
        dailyLimitUcr: o.dailyLimitUcr ?? null,
        allowedModels: o.allowedModels ?? null,
      })
      .returning({ id: apiKeys.id });
    return { apiKey, id: row!.id, wallet };
  }

  const main = await newKey();
  chain.fund(main.wallet, opts.credits ?? 40n);

  const post =
    (path: string) =>
    (body: unknown, headers: Record<string, string> = {}, key = main.apiKey) =>
      fetch(`${url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });

  return {
    url,
    db,
    chain,
    mock,
    settle,
    reconciler,
    logs,
    wallet: main.wallet,
    apiKey: main.apiKey,
    keyId: main.id,
    deps,
    newKey,
    messages: post("/v1/messages"),
    chat: post("/v1/chat/completions"),
    async close() {
      settle.stop();
      reconciler.stop();
      await new Promise<void>((r) => server.close(() => r()));
      await mock.close();
      await closeDb();
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until the condition holds (background stream processing finishes after the response). */
export async function until(cond: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const t = Date.now();
  while (!(await cond())) {
    if (Date.now() - t > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(10);
  }
}

export const msgBody = (extra: Record<string, unknown> = {}) => ({
  model: "claude-sonnet-5-5",
  max_tokens: 512,
  messages: [{ role: "user", content: "Hello" }],
  ...extra,
});
