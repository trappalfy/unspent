// Browser end-to-end on a local Surfpool mainnet fork (brief 13, 16 stages 5–6): real Chrome, a Wallet Standard test
// wallet holding a throwaway keypair, `next dev`, the gateway with the mock provider and the indexer, all on one
// Postgres. Covers sign-in, buy with USDC and with SOL (real Jupiter route), withdraw, hold limit, key creation,
// API requests reserved + settled onchain, usage, overview, /reserve against the chain, sell without a market, and
// no horizontal scroll at 390 px.
//
// Prereqs: ops/surfpool-up.sh (OFFLINE=1 for a network-independent run), `pnpm --filter @unspent/db devdb`, Chrome.
//   pnpm --filter @unspent/e2e ui        (screenshots → $SHOTS or the OS temp dir)

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  getAddressFromPublicKey,
  getTransactionDecoder,
  getTransactionEncoder,
  lamports,
  signTransaction,
} from "@solana/kit";
import { chainEvents, eq, indexerCursor, openPostgres, settleQueue } from "@unspent/db";
import { getShutdownInstructionAsync } from "@unspent/program";
import { formatCredits } from "@unspent/shared";
import { chromium, type Page } from "playwright-core";
import { readProgram, readUser, readWallet } from "../../apps/web/lib/chain/read";
import { prepare, signAndConfirm } from "../../apps/web/lib/chain/tx";
import { createApp } from "../../services/gateway/src/app";
import { SolanaChain } from "../../services/gateway/src/chain";
import { loadConfig } from "../../services/gateway/src/config";
import { createLogger } from "../../services/gateway/src/log";
import { MemoryRateLimiter } from "../../services/gateway/src/ratelimit";
import { SettleWorker } from "../../services/gateway/src/settle";
import { AnthropicUpstream } from "../../services/gateway/src/upstream";
import { startMockAnthropic } from "../../services/gateway/test/mock/mockAnthropic";
import { Indexer } from "../../services/indexer/src/indexer";
import { createLogger as indexerLogger } from "../../services/indexer/src/log";
import { axe, describe } from "./axe";
import { cheat, installWallet, sleep, until } from "./wallet";

const ROOT = new URL("../../", import.meta.url).pathname;
const RPC = "http://127.0.0.1:8899";
const DB_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/unspent";
const WEB_PORT = 3100;
const WEB = `http://localhost:${WEB_PORT}`;
const GW_PORT = 8790;
const SHOTS = process.env.SHOTS ?? join(tmpdir(), "unspent-ui-e2e");
const C = 1_000_000n;
mkdirSync(SHOTS, { recursive: true });

const rpc = createSolanaRpc(RPC);
const steps: string[] = [];
function ok(label: string, cond: unknown) {
  if (!cond) throw new Error(`✗ ${label}`);
  steps.push(label);
  console.log(`✓ ${label}`);
}
const procs: ChildProcess[] = [];
let failShot: () => Promise<unknown> = async () => {};
let failText: () => Promise<string> = async () => "";
const closers: (() => Promise<unknown> | unknown)[] = [];

async function main() {
  const program = await readProgram(rpc);
  if (!program) throw new Error("program not initialized on the fork: run ops/surfpool-up.sh");

  // ---- user keypair (extractable so the page can sign with WebCrypto) ----
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const owner = await getAddressFromPublicKey(kp.publicKey);
  await rpc.requestAirdrop(owner, lamports(3_000_000_000n)).send();
  await cheat("surfnet_setTokenAccount", [
    owner,
    program.usdcMint,
    { amount: Number(100n * C) },
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  ]);
  await until("airdrop", async () => (await rpc.getBalance(owner).send()).value > 0n);
  ok(`user ${owner} funded with 3 SOL + 100 USDC`, true);

  // ---- gateway (mock provider) + settle worker + indexer on the shared DB ----
  const mock = await startMockAnthropic();
  closers.push(() => mock.close());
  const { db, close: closeDb } = await openPostgres(DB_URL, { max: 5 });
  closers.push(closeDb);
  // A fresh fork has a new history: drop the previous fork's index (a stale cursor makes Surfpool chase an unknown
  // signature on mainnet and stall).
  await db.delete(chainEvents).where(eq(chainEvents.network, "localnet"));
  await db.delete(indexerCursor).where(eq(indexerCursor.network, "localnet"));
  const config = loadConfig({
    PROVIDER_MODE: "mock",
    ANTHROPIC_BASE_URL: mock.url,
    ANTHROPIC_API_KEYS: "sk-ant-test-key-1",
    NEXT_PUBLIC_SOLANA_NETWORK: "localnet",
    RPC_URL: RPC,
    GATEWAY_KEYPAIR_PATH: `${ROOT}keys/localnet-gateway-keypair.json`,
    SETTLE_FLUSH_MS: "500",
  });
  const log = createLogger({ sink: () => {} });
  const chain = await SolanaChain.create(RPC, config.gatewayKeypairPath, 0n);
  const deps = {
    config,
    db,
    chain,
    upstream: new AnthropicUpstream(config.anthropicBaseUrl, config.anthropicKeys, log),
    limiter: new MemoryRateLimiter(),
    log,
  };
  const gw = serve({ fetch: createApp(deps).fetch, port: GW_PORT, hostname: "127.0.0.1" });
  closers.push(() => new Promise((r) => gw.close(r)));
  const settle = new SettleWorker(db, chain, log, config.settleFlushMs);
  settle.start();
  closers.push(() => settle.stop());
  const indexer = new Indexer({
    db,
    rpc,
    rpcSubscriptions: createSolanaRpcSubscriptions("ws://127.0.0.1:8900"),
    network: "localnet",
    log: indexerLogger(() => {}),
    backfillMs: 3_000,
  });
  indexer.start();
  closers.push(() => indexer.stop());

  // ---- next dev on the fork ----
  const web = spawn("pnpm", ["exec", "next", "dev", "-p", String(WEB_PORT)], {
    cwd: `${ROOT}apps/web`,
    env: {
      ...process.env,
      NEXT_PUBLIC_SOLANA_NETWORK: "localnet",
      NEXT_PUBLIC_SITE_URL: WEB,
      NEXT_PUBLIC_API_HOST: `127.0.0.1:${GW_PORT}`,
      NEXT_PUBLIC_PRELAUNCH: "false",
      SESSION_SECRET: "e2e-session-secret-0123456789abcdef0123456789",
      DATABASE_URL: DB_URL,
      RPC_URL: RPC,
      JUPITER_DEXES: "Whirlpool,Raydium CLMM,Meteora DLMM,Raydium,Orca V2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(web);
  let webLog = "";
  web.stdout?.on("data", (d) => (webLog += d));
  web.stderr?.on("data", (d) => (webLog += d));
  await until("next dev", async () => (await fetch(`${WEB}/reserve`)).ok, 120_000);
  ok("next dev serves /reserve", true);

  // ---- browser ----
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  closers.push(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // tsx keeps function names via an injected __name helper; define it for the serialized function.
  const arg = { address: owner, publicKey: [...pub], pkcs8: [...pkcs8], chain: "solana:localnet" };
  await ctx.addInitScript({
    content: `var __name = (f) => f; (${installWallet.toString()})(${JSON.stringify(arg)});`,
  });
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => m.type() === "error" && console.log(`  [console] ${m.text().slice(0, 300)}`));
  failShot = () => page.screenshot({ path: join(SHOTS, "FAIL.png"), fullPage: true });
  failText = async () =>
    `${(await page.locator("body").textContent())?.replace(/\s+/g, " ").slice(0, 600)}\n${webLog
      .split("\n")
      .filter((l) => /rror|⨯/.test(l))
      .slice(-15)
      .join("\n")}`;
  const shot = (name: string, p: Page = page) =>
    p.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });

  async function txDone(button: RegExp) {
    const b = page.getByRole("button", { name: button });
    await b.waitFor({ timeout: 60_000 });
    await until(`${button} enabled`, async () => !(await b.isDisabled()), 90_000);
    await b.click();
    await page.locator("[data-stage=done]").waitFor({ timeout: 90_000 });
  }

  // 1. Sign in with Solana
  await page.goto(`${WEB}/app`);
  await page.getByRole("button", { name: "Test Wallet" }).click();
  await page.getByRole("link", { name: "Overview" }).waitFor({ timeout: 60_000 });
  await page.getByText("No credits yet. Buy some to start.").waitFor();
  ok("SIWS sign-in → overview with next step", true);
  await shot("01-overview-empty");

  // 2. Buy 20 credits with USDC (+ deposit)
  await page.goto(`${WEB}/app/buy`);
  await page.getByPlaceholder("25").fill("20");
  await page.getByText("API balance").first().waitFor();
  await shot("02-buy-usdc");
  await txDone(/^Buy 20 credits$/);
  let u = await readUser(rpc, owner);
  ok("buy 20 with USDC → API balance 20 onchain", u.balance === 20n * C);

  // 3. Withdraw 5, then set a 3-credit hold limit
  await page.goto(`${WEB}/app/balance`);
  await page.locator("#withdraw input").fill("5");
  await txDone(/^Withdraw 5\.00 credits$/);
  await page.goto(`${WEB}/app/balance`);
  await page.locator("#limit input").fill("3");
  await txDone(/^Save limit$/);
  u = await readUser(rpc, owner);
  const w = await readWallet(rpc, owner, program);
  ok(
    "withdraw 5 → balance 15, wallet 5; hold limit 3",
    u.balance === 15n * C && w.credits === 5n * C && u.reserveCap === 3n * C,
  );
  await until("indexed withdrawal in activity", async () => {
    await page.goto(`${WEB}/app/balance`);
    return (await page.getByText("Withdrawn to wallet").count()) > 0;
  });
  ok("activity from the indexer shows the withdrawal", true);
  await shot("03-balance");

  // 4. Create an API key (shown once)
  await page.goto(`${WEB}/app/keys`);
  await page.getByText("No API keys yet. Create one to start spending credits.").waitFor();
  await page.getByPlaceholder("Default").fill("e2e");
  await page.getByRole("button", { name: "Create key" }).click();
  const secret = (await page.locator("code").first().textContent({ timeout: 30_000 }))?.trim() ?? "";
  ok("key created and shown once", /^usp_test_[0-9A-Za-z]{32}$/.test(secret));
  await shot("04-key-created");
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("cell", { name: "e2e" }).waitFor();

  // 5. Three API requests through the gateway: each reserved and settled onchain
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`http://127.0.0.1:${GW_PORT}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": secret, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        max_tokens: 256,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    ok(`request ${i + 1} → ${r.status}`, r.status === 200);
    await r.text();
  }
  await until("3 settlements confirmed", async () => {
    const rows = await db.select().from(settleQueue).where(eq(settleQueue.owner, owner));
    return rows.filter((r) => r.status === "confirmed").length >= 3;
  });
  u = await readUser(rpc, owner);
  ok("holds released after settlement; balance charged", u.reserved === 0n && u.balance < 15n * C);

  // 6. Usage and overview
  await page.goto(`${WEB}/app/usage`);
  const usageRows = page.locator("tbody tr");
  await until("3 usage rows settled", async () => {
    await page.reload();
    return (
      (await usageRows.count()) === 3 && (await page.getByRole("cell", { name: "settled" }).count()) === 3
    );
  });
  ok(
    "usage shows 3 settled requests with reserve + settle links",
    (await page.locator("tbody a").count()) === 6,
  );
  const csv = await page.request.get(`${WEB}/app/usage/export`);
  ok("CSV export has header + 3 rows", (await csv.text()).trim().split("\n").length === 4);
  await shot("05-usage");
  await page.goto(`${WEB}/app`);
  await page.locator("svg[role=img]").waitFor();
  ok("overview spend chart renders", (await page.locator("svg[role=img] rect").count()) >= 1);
  await shot("06-overview");

  // 7. /reserve matches the chain
  await until("indexer has the settlements", async () => {
    await page.goto(`${WEB}/reserve`);
    return (await page.getByRole("cell", { name: `${owner.slice(0, 4)}…${owner.slice(-4)}` }).count()) >= 1;
  });
  const p2 = (await readProgram(rpc))!;
  await sleep(1500); // figures roll into place once on first view
  const text = (await page.locator("main").textContent()) ?? "";
  ok("reserve: circulation equals mint supply", text.includes(formatCredits(p2.supply, 2)));
  ok("reserve: burned equals total_burned", text.includes(formatCredits(p2.totalBurned, 2)));
  ok("reserve: coverage ≥ 100%", /Coverage(1\d\d|[2-9]\d\d|\d{4,})\.\d\d%/.test(text.replace(/\s+/g, "")));
  await shot("07-reserve");

  // 8. Buy with SOL through Jupiter (real mainnet route executed on the fork). An offline fork has no AMM accounts.
  if (process.env.OFFLINE === "1") {
    console.log("· skipped buy with SOL: offline fork (covered by apps/web/test/chain-e2e.test.ts online)");
  } else {
    const before = await readUser(rpc, owner);
    await page.goto(`${WEB}/app/buy`);
    await page.getByRole("tab", { name: "Any token" }).click();
    await page.getByPlaceholder("0.5").fill("0.05");
    await page.getByText("You get at least").waitFor({ timeout: 60_000 });
    await shot("08-buy-swap");
    await txDone(/^Buy [\d.]+ credits$/);
    const after = await readUser(rpc, owner);
    ok("buy with SOL via Jupiter → API balance up", after.balance > before.balance);
  }

  // 9. Sell: no market for the fork's credit mint
  await page.goto(`${WEB}/app/sell`);
  await page.getByPlaceholder("10").fill("1");
  await page.getByText("No market for credits yet.").waitFor({ timeout: 60_000 });
  ok("sell explains there's no market yet", true);

  // 10. Phone and tablet widths: no horizontal page scroll anywhere; WCAG 2.1 AA (axe) on every page with live data.
  const appPages = [
    "/app",
    "/app/buy",
    "/app/balance",
    "/app/keys",
    "/app/usage",
    "/app/sell",
    "/reserve",
    "/",
  ];
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of appPages) {
      await page.goto(`${WEB}${path}`);
      await page.waitForLoadState("networkidle");
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      ok(`${width}px ${path}: no horizontal scroll (${sw})`, sw <= width);
      if (width === 390) {
        await shot(`m-${path.replaceAll("/", "_") || "root"}`);
        const v = await axe(page);
        if (v.length) console.log(`    ${describe(v)}`);
        ok(`390px ${path}: axe WCAG 2.1 AA`, v.length === 0);
      }
    }
  }
  // 11. Irreversible, opt-in: admin shuts Unspent down → banner on every app page → redeem everything 1:1 in the UI.
  if (process.env.E2E_SHUTDOWN === "1") {
    await page.setViewportSize({ width: 1280, height: 900 });
    const admin = await createKeyPairSignerFromBytes(
      Uint8Array.from(JSON.parse(readFileSync(`${ROOT}keys/localnet-admin-keypair.json`, "utf8"))),
    );
    const prepared = await prepare(rpc, admin.address, [await getShutdownInstructionAsync({ admin })]);
    await signAndConfirm(
      rpc,
      prepared,
      async (bytes) => ({
        signed: new Uint8Array(
          getTransactionEncoder().encode(
            await signTransaction([admin.keyPair], getTransactionDecoder().decode(bytes)),
          ),
        ),
      }),
      () => {},
    );
    await until("shutdown banner", async () => {
      await page.goto(`${WEB}/app`);
      return (
        (await page.getByText("Unspent is shut down. Withdraw your balance and redeem credits").count()) > 0
      );
    });
    ok("shutdown banner on the app", true);
    const usdcBefore = (await readWallet(rpc, owner, program)).usdc;
    const total = (await readWallet(rpc, owner, program)).credits + (await readUser(rpc, owner)).available;
    await page.getByRole("link", { name: "Redeem" }).first().click();
    await txDone(/^Redeem [\d.]+ credits for [\d.]+ USDC$/);
    const end = await readWallet(rpc, owner, program);
    ok(
      `redeemed ${total} μcr → +${end.usdc - usdcBefore} USDC base units, wallet credits 0`,
      end.usdc - usdcBefore === total && end.credits === 0n,
    );
    await shot("09-redeemed");
  }

  ok(`no uncaught page errors (${pageErrors.join(" | ")})`, pageErrors.length === 0);
  if (/Error:|⨯/.test(webLog))
    console.log(
      webLog
        .split("\n")
        .filter((l) => /Error|⨯/.test(l))
        .slice(0, 10)
        .join("\n"),
    );
}

main()
  .then(() => console.log(`\nALL ${steps.length} CHECKS PASSED · screenshots in ${SHOTS}`))
  .catch(async (e) => {
    console.error(e);
    await failShot().catch(() => {});
    console.error(await failText().catch(() => ""));
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const c of closers.reverse()) await Promise.resolve(c()).catch(() => {});
    for (const p of procs) p.kill("SIGTERM");
    setTimeout(() => process.exit(), 1000);
  });
