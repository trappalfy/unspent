// Browser e2e of /app/admin on a local Surfpool mainnet fork (owner, 2026-10-10: no multisig; the admin wallet signs
// every admin action on this page). The test wallet holds keys/localnet-admin-keypair.json, the admin that
// ops/surfpool-up.sh and ops/rehearse.sh launch with. Covers: hidden for other wallets, pause and resume, a limit
// raise that waits admin_delay and is applied after it, an immediate lowering, a backup gateway key proposed and
// cancelled, freezing upgrades, axe and 390 px; with E2E_SHUTDOWN=1 also the irreversible shutdown. E2E_CLOSE=1
// (with E2E_SHUTDOWN=1) skips the freeze and ends by closing the program for its SOL deposit: cleanly when no credits
// are out, or with funds left behind its own confirmation after tests/e2e/ui.ts (owner, 2026-10-10: a test launch that
// must give its SOL back, and a test of what happens to money left in a closed program).
//
// Prereqs: ops/surfpool-up.sh (or ops/rehearse.sh), `pnpm --filter @unspent/db devdb`, Chrome.
//   pnpm --filter @unspent/e2e admin

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSolanaRpc, generateKeyPairSigner, getAddressFromPublicKey } from "@solana/kit";
import { chromium, type Page } from "playwright-core";
import {
  readProgram,
  readProgramCode,
  readReserveBalances,
  readTokenMetadata,
} from "../../apps/web/lib/chain/read";
import { axe, describe } from "./axe";
import { cheat, installWallet, until, walletFromKeypairFile } from "./wallet";

const ROOT = new URL("../../", import.meta.url).pathname;
const RPC = "http://127.0.0.1:8899";
const DB_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/unspent";
const WEB_PORT = 3101;
const WEB = `http://localhost:${WEB_PORT}`;
const SHOTS = process.env.SHOTS ?? join(tmpdir(), "unspent-admin-e2e");
const C = 1_000_000n;
mkdirSync(SHOTS, { recursive: true });

const rpc = createSolanaRpc(RPC);
let checks = 0;
function ok(label: string, cond: unknown) {
  if (!cond) throw new Error(`✗ ${label}`);
  checks++;
  console.log(`✓ ${label}`);
}
const state = async () => {
  const p = await readProgram(rpc);
  if (!p) throw new Error("program not initialized on the fork: run ops/surfpool-up.sh");
  return p;
};

const cleanup: (() => unknown)[] = [];

async function main() {
  const start = await state();
  const admin = await walletFromKeypairFile(`${ROOT}keys/localnet-admin-keypair.json`);
  if (start.admin !== admin.address)
    throw new Error(`admin on the fork is ${start.admin}, not the local admin key`);
  // Already shut down (tests/e2e/ui.ts with E2E_SHUTDOWN=1 redeemed everything): only the closing is left to test.
  const closing = process.env.E2E_CLOSE === "1";
  if (start.shutDown && !closing) throw new Error("the fork is already shut down: run ops/surfpool-up.sh");

  const web = spawn("pnpm", ["exec", "next", "dev", "-p", String(WEB_PORT)], {
    cwd: `${ROOT}apps/web`,
    env: {
      ...process.env,
      NEXT_PUBLIC_SOLANA_NETWORK: "localnet",
      NEXT_PUBLIC_SITE_URL: WEB,
      NEXT_PUBLIC_API_HOST: "127.0.0.1:8790",
      NEXT_PUBLIC_PRELAUNCH: "false",
      SESSION_SECRET: "e2e-session-secret-0123456789abcdef0123456789",
      DATABASE_URL: DB_URL,
      RPC_URL: RPC,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cleanup.push(() => web.kill("SIGTERM"));
  let webLog = "";
  web.stdout?.on("data", (d) => (webLog += d));
  web.stderr?.on("data", (d) => (webLog += d));
  webErrors = () =>
    webLog
      .split("\n")
      .filter((l) => /rror|⨯/.test(l))
      .slice(-10)
      .join("\n");
  await until("next dev", async () => (await fetch(`${WEB}/reserve`)).ok, 120_000);

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  cleanup.push(() => browser.close());

  async function signedIn(wallet: { address: string; publicKey: number[]; pkcs8: number[] }) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const arg = { ...wallet, chain: "solana:localnet" };
    await ctx.addInitScript({
      content: `var __name = (f) => f; (${installWallet.toString()})(${JSON.stringify(arg)});`,
    });
    const page = await ctx.newPage();
    await page.goto(`${WEB}/app`);
    await page.getByRole("button", { name: "Test Wallet" }).click();
    await page.getByRole("link", { name: "Overview" }).waitFor({ timeout: 60_000 });
    return page;
  }

  // 1. Another wallet: no Admin link, and the page doesn't exist for it.
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const stranger = {
    address: await getAddressFromPublicKey(kp.publicKey),
    publicKey: [...new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))],
    pkcs8: [...new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey))],
  };
  const other = await signedIn(stranger);
  ok("another wallet sees no Admin link", (await other.getByRole("link", { name: "Admin" }).count()) === 0);
  const res = await other.goto(`${WEB}/app/admin`);
  ok("/app/admin is a 404 for another wallet", res?.status() === 404);
  await other.context().close();

  // 2. The admin wallet
  const page = await signedIn(admin);
  failShot = () => page.screenshot({ path: join(SHOTS, "FAIL.png"), fullPage: true });
  await page.getByRole("link", { name: "Admin" }).click();
  await page.getByRole("heading", { name: "Status" }).waitFor({ timeout: 60_000 });
  ok("admin wallet: Admin link → status", (await page.getByText("This wallet").count()) > 0);
  await page.screenshot({ path: join(SHOTS, "01-admin.png"), fullPage: true });

  /** Opens an action, types its confirmation if any, signs, and waits for the chain to agree. */
  async function act(
    label: string,
    check: () => Promise<boolean>,
    confirm?: string,
    fill?: (p: Page) => Promise<void>,
  ) {
    await page.goto(`${WEB}/app/admin`);
    await fill?.(page);
    await page.getByRole("button", { name: label, exact: true }).click();
    if (confirm) await page.getByLabel(/Type .* to confirm/).fill(confirm);
    const sign = page.getByRole("button", { name: label, exact: true });
    await until(`${label} ready`, async () => !(await sign.isDisabled()), 90_000);
    await sign.click();
    // Applying or cancelling removes the pending row, and its "Done" with it: the chain is the judge.
    await until(`${label} onchain`, check, 90_000);
  }

  if (!start.shutDown) {
    // 3. Pause and resume buying
    await act("Pause buying", async () => (await state()).buyPaused);
    ok("pause buying → buy_paused onchain", true);
    await act("Resume buying", async () => !(await state()).buyPaused);
    ok("resume buying → buy_paused false", true);

    // 4. A raise waits admin_delay; after it the page offers Apply; lowering applies at once.
    const limitForm = (value: string) => async (p: Page) => {
      await p.getByLabel("Limit", { exact: true }).selectOption({ label: "Max hold per request" });
      await p.getByLabel("New value, credits").fill(value);
    };
    const raised = start.maxReservation + 10n * C;
    await act(
      "Set limit",
      async () => (await state()).pending.some((r) => r.value === raised),
      undefined,
      limitForm(String(raised / C)),
    );
    ok("raise max hold → pending, limit unchanged", (await state()).maxReservation === start.maxReservation);
    await page.goto(`${WEB}/app/admin`);
    ok("pending change listed", (await page.getByText("Takes effect").count()) === 1);
    const effectiveAt = (await state()).pending[0]!.effectiveAt;
    await cheat("surfnet_timeTravel", [{ absoluteTimestamp: (Number(effectiveAt) + 60) * 1000 }]);
    await until("page sees the change as ready", async () => {
      await page.goto(`${WEB}/app/admin`);
      return (await page.getByText("ready to apply").count()) > 0;
    });
    await act("Apply: Max hold per request", async () => (await state()).maxReservation === raised);
    ok("after admin_delay: Apply → limit raised, nothing pending", (await state()).pending.length === 0);
    await act(
      "Set limit",
      async () => (await state()).maxReservation === start.maxReservation,
      undefined,
      limitForm(String(start.maxReservation / C)),
    );
    ok("lowering applies at once", (await state()).pending.length === 0);

    // 5. Backup gateway key: proposed (waits), then cancelled
    const backup = (await generateKeyPairSigner()).address;
    await act(
      "Propose backup key",
      async () => (await state()).pending.some((r) => r.key === backup),
      undefined,
      async (p) => p.getByLabel("Backup gateway key").fill(backup),
    );
    ok("backup key proposed → pending", true);
    await act("Cancel: Backup gateway key", async () => (await state()).pending.length === 0);
    ok("backup key cancelled", true);

    // 5b. Token metadata: tested under a neutral name, renamed on launch day (needs Metaplex: online fork only)
    if (await readTokenMetadata(rpc, start.creditMint)) {
      await act(
        "Update token metadata",
        async () => (await readTokenMetadata(rpc, start.creditMint))?.symbol === "UCRED",
        undefined,
        async (pg) => {
          await pg.getByRole("button", { name: "Fill in the launch name and URI" }).click();
          await pg.getByLabel("Symbol").fill("UCRED");
        },
      );
      const m = await readTokenMetadata(rpc, start.creditMint);
      ok(
        `token metadata → ${m?.name} / ${m?.symbol} / ${m?.uri}`,
        m?.name === "Unspent Credit" && m.uri === `${WEB}/token.json`,
      );
    } else console.log("· skipped token metadata: no Metaplex on an offline fork");

    // 6. Layout and accessibility of the page
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${WEB}/app/admin`);
      await page.waitForLoadState("networkidle");
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      ok(`${width}px /app/admin: no horizontal scroll (${sw})`, sw <= width);
      const v = await axe(page);
      if (v.length) console.log(`    ${describe(v)}`);
      ok(`${width}px /app/admin: axe WCAG 2.1 AA`, v.length === 0);
    }
    await page.screenshot({ path: join(SHOTS, "02-admin.png"), fullPage: true });

    // 7. Freeze upgrades (typed confirmation); not when the run ends by closing the program
    if (!closing) {
      await act(
        "Freeze upgrades forever",
        async () => (await readProgramCode(rpc)).authority === null,
        "FREEZE",
      );
      await page.goto(`${WEB}/app/admin`);
      ok(
        "upgrades frozen onchain and on the page",
        (await page.getByText("Upgrades are frozen.").count()) === 1,
      );
    }

    // 8. Irreversible, opt-in: shutdown
    if (process.env.E2E_SHUTDOWN === "1") {
      await act("Shut down Unspent", async () => (await state()).shutDown, "SHUT DOWN");
      ok("shutdown → shut_down onchain", true);
    }
  }

  // 9. Close the program and take its rent back, only when nobody's money is left with it
  if (closing) {
    const p = await state();
    await page.goto(`${WEB}/app/admin`);
    await page.getByRole("heading", { name: "Close the program" }).waitFor();
    const v = await axe(page);
    if (v.length) console.log(`    ${describe(v)}`);
    ok("close section: axe WCAG 2.1 AA", v.length === 0);
    await page.screenshot({ path: join(SHOTS, "03-close.png"), fullPage: true });
    if (p.supply > 0n) {
      // Owner's test: close with funds left, and see what stays where.
      const before = await readReserveBalances(rpc, p);
      ok(
        "closing with credits out: consequences and holders listed",
        (await page.getByText("are still in circulation").count()) === 1 &&
          (await page.getByText("Check that every one is yours").count()) === 1,
      );
      await act(
        "Close the program and leave the funds",
        async () => (await readProgramCode(rpc)).closed,
        "LEAVE THE FUNDS",
      );
      const after = await readReserveBalances(rpc, p);
      const mintAfter = await readProgram(rpc);
      ok(
        `closed with funds: reserve keeps ${Number(after.reserveUsdc) / 1e6} USDC, vault ${Number(after.vaultCredits) / 1e6} credits, supply ${Number(mintAfter?.supply ?? 0n) / 1e6}`,
        after.reserveUsdc === before.reserveUsdc &&
          after.vaultCredits === before.vaultCredits &&
          mintAfter?.supply === p.supply,
      );
    } else {
      if ((await readReserveBalances(rpc, p)).reserveUsdc > 0n)
        await act(
          "Sweep surplus to the treasury",
          async () => (await readReserveBalances(rpc, p)).reserveUsdc === 0n,
        );
      const rent = (await readProgramCode(rpc)).rentLamports;
      const before = (await rpc.getBalance(admin.address as never).send()).value;
      await act(
        "Close the program and return its SOL",
        async () => (await readProgramCode(rpc)).closed,
        "CLOSE",
      );
      const gained = (await rpc.getBalance(admin.address as never).send()).value - before;
      ok(
        `program closed → ${Number(gained) / 1e9} SOL back to the admin wallet (rent ${Number(rent) / 1e9})`,
        gained > rent - 1_000_000n,
      );
      await page.goto(`${WEB}/app/admin`);
      ok("page shows the program closed", (await page.getByText("Program closed").count()) === 1);
    }
  }

  // Navigating away mid-stream makes next dev log "destination stream errored"; that is not a page error.
  const errors = webLog.split("\n").filter((l) => /⨯/.test(l) && !/destination stream errored/.test(l));
  ok(`no server errors in next dev (${errors.slice(0, 3).join(" | ")})`, errors.length === 0);
}

let failShot: () => Promise<unknown> = async () => {};
let webErrors: () => string = () => "";
main()
  .then(() => console.log(`\nALL ${checks} ADMIN CHECKS PASSED · screenshots in ${SHOTS}`))
  .catch(async (e) => {
    console.error(e);
    console.error(webErrors());
    await failShot().catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const c of cleanup.reverse()) await Promise.resolve(c()).catch(() => {});
    setTimeout(() => process.exit(), 1000);
  });
