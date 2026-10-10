// Smoke test of a deployed site and API, run after every deploy and before opening (no transactions: the test
// wallet only signs the sign-in message). Checks that the deployment has its real configuration (no localhost
// defaults), every public page renders and reads the chain, the RPC relay answers, a fresh wallet can sign in and
// open every app page, the admin page stays hidden, and the API gateway answers.
//
//   LIVE_URL=https://www.example.com pnpm --filter @unspent/e2e live      (LIVE_NO_API=1 while the gateway isn't up;
//   LIVE_API=https://api.… when the API host isn't api.<site domain>)

import { getAddressFromPublicKey } from "@solana/kit";
import { chromium } from "playwright-core";
import { DOCS } from "../../apps/web/lib/docs";
import { installWallet } from "./wallet";

const WEB = (process.env.LIVE_URL ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(WEB)) throw new Error("LIVE_URL=https://… is required");
const host = new URL(WEB).host;
// Running against a local copy, the site's own address is localhost; "localhost" is a defect only on a real host.
const LOCAL = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
const DEFECT = LOCAL
  ? /can.t be read right now|Couldn.t load this page/
  : /can.t be read right now|Couldn.t load this page|localhost:/;
const apiBase = process.env.LIVE_API ?? `https://api.${host.replace(/^www\./, "")}`;

let failed = 0;
let passed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` (${detail})` : ""}`);
  if (ok) passed++;
  else failed++;
}
const get = (path: string) =>
  fetch(`${WEB}${path}`, { redirect: "follow", signal: AbortSignal.timeout(30_000) });

// 1. Configuration baked into the deployment
const home = await (await get("/")).text();
const og = /property="og:image" content="([^"]+)"/.exec(home)?.[1] ?? "";
check("site URL configured (og:image on the site's own host)", og.startsWith(WEB), og || "no og:image");
const token = (await (await get("/token.json")).json()) as { symbol?: string; image?: string };
check(
  "token.json has a symbol and the site's image",
  !!token.symbol && !!token.image?.startsWith(WEB),
  JSON.stringify(token),
);
const quickstart = await (await get("/docs/quickstart")).text();
check(
  "Docs show the real API host",
  quickstart.includes(apiBase) && (LOCAL || !quickstart.includes("localhost")),
  apiBase,
);

// 2. Every public page
const pages = ["/", "/reserve", "/terms", "/privacy", "/docs", ...DOCS.map((d) => `/docs/${d.slug}`)];
for (const path of pages) {
  const r = await get(path);
  const html = await r.text();
  const broken = DEFECT.exec(html)?.[0];
  check(`${path} renders`, r.ok && !broken, broken ?? String(r.status));
}
const reserve = await (await get("/reserve")).text();
check("/reserve reads the program from the chain", /Coverage/.test(reserve) && !/Not live yet/.test(reserve));

// 3. The browser's RPC relay
{
  const r = await fetch(`${WEB}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash" }),
  });
  const body = (await r.json().catch(() => ({}))) as { result?: unknown };
  check("/api/rpc relays to Solana", r.ok && !!body.result, String(r.status));
}

// 4. A fresh wallet signs in and opens every app page; the admin page doesn't exist for it
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const wallet = {
    address: await getAddressFromPublicKey(kp.publicKey),
    publicKey: [...new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))],
    pkcs8: [...new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey))],
    chain: "solana:mainnet",
  };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript({
    content: `var __name = (f) => f; (${installWallet.toString()})(${JSON.stringify(wallet)});`,
  });
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${WEB}/app`);
  await page.getByRole("button", { name: "Test Wallet" }).click({ timeout: 30_000 });
  const signedIn = await page
    .getByRole("link", { name: "Overview" })
    .waitFor({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check("a new wallet signs in (SIWS)", signedIn);
  for (const path of ["/app", "/app/buy", "/app/balance", "/app/keys", "/app/usage", "/app/sell"]) {
    const res = await page.goto(`${WEB}${path}`);
    await page.waitForLoadState("networkidle").catch(() => {});
    const text = (await page.locator("main").textContent()) ?? "";
    const broken = /Couldn.t load this page|Something went wrong|can.t be read right now/.exec(text)?.[0];
    check(`${path} works for a signed-in wallet`, !!res?.ok() && !broken, broken ?? String(res?.status()));
  }
  const admin = await page.goto(`${WEB}/app/admin`);
  check("/app/admin is a 404 for other wallets", admin?.status() === 404);
  check("no uncaught errors in the browser", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} finally {
  await browser.close();
}

// 5. The API gateway
if (process.env.LIVE_NO_API === "1") console.log("· skipped the API gateway (LIVE_NO_API=1)");
else {
  const health = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  check(`${apiBase}/health`, !!health?.ok, String(health?.status ?? "unreachable"));
  const models = await fetch(`${apiBase}/v1/models`, { signal: AbortSignal.timeout(15_000) }).catch(
    () => null,
  );
  const list = (await models?.json().catch(() => null)) as { data?: unknown[] } | null;
  check(`${apiBase}/v1/models lists models`, !!models?.ok && (list?.data?.length ?? 0) > 0);
}

console.log(
  failed ? `\n${failed} OF ${passed + failed} LIVE CHECKS FAILED` : `\nALL ${passed} LIVE CHECKS PASSED`,
);
process.exit(failed ? 1 : 0);
