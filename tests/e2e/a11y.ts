// Public pages, accessibility and layout (brief 11.8):
//  1. 390 / 768 / 1280: no horizontal page scroll.
//  2. axe-core WCAG 2.1 A/AA (contrast of --fg and --mute on --bg included) at 390 and 1280.
//  3. Keyboard: the first Tab reaches "Skip to content", every Tab stop is visible and outlined.
//  4. prefers-reduced-motion: no running animations, static hero.
// App pages are covered by ui.ts (they need a wallet and the program). Run: pnpm --filter @unspent/e2e a11y
// BASE=http://localhost:3000 reuses a running dev server.

import { type ChildProcess, spawn } from "node:child_process";
import { chromium, type Page } from "playwright-core";
import { axe, describe } from "./axe";

const ROOT = new URL("../../", import.meta.url).pathname;
const PORT = 3201;
const WEB = process.env.BASE ?? `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DOCS = [
  "quickstart",
  "authentication",
  "messages",
  "chat-completions",
  "models",
  "claude-code",
  "errors",
  "rate-limits",
  "credits",
  "onchain",
  "privacy",
];
const PAGES = [
  "/",
  "/docs",
  ...DOCS.map((d) => `/docs/${d}`),
  "/reserve",
  "/privacy",
  "/terms",
  "/unavailable",
  "/no-such-page",
];

let failed = false;
let passed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `\n    ${detail}`}`);
  if (ok) passed++;
  else failed = true;
}

async function open(page: Page, path: string) {
  await page.goto(`${WEB}${path}`);
  await page.waitForLoadState("networkidle");
}

/** Tabs through the page; returns the stops without a visible focus outline. */
async function tabStops(page: Page, max = 60): Promise<{ first: string; bad: string[]; count: number }> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  let first = "";
  const bad: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const s = (await page.evaluate(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      if (el.tagName === "NEXTJS-PORTAL") return { skip: true };
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const id = el.tagName.toLowerCase() + ":" + (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30) + "@" + Math.round(r.top + scrollY);
      const outlined = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
      return { id, outlined, visible: r.width > 0 && r.height > 0 };
    })()`)) as { id: string; outlined: boolean; visible: boolean; skip?: boolean } | null;
    if (!s) break;
    if (s.skip) continue; // Next's dev tools button, dev only
    if (seen.has(s.id)) break;
    seen.add(s.id);
    if (i === 0) first = s.id;
    if (!s.outlined || !s.visible) bad.push(s.id);
  }
  return { first, bad, count: seen.size };
}

let web: ChildProcess | null = null;
async function main() {
  if (!process.env.BASE) {
    web = spawn("pnpm", ["exec", "next", "dev", "-p", String(PORT)], {
      cwd: `${ROOT}apps/web`,
      env: { ...process.env, NEXT_PUBLIC_SOLANA_NETWORK: "mainnet", NEXT_PUBLIC_PRELAUNCH: "false" },
      stdio: "ignore",
    });
    for (let i = 0; i < 240; i++) {
      if (
        await fetch(WEB).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      await sleep(500);
    }
  }
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  for (const width of [390, 768, 1280]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    for (const path of PAGES) {
      await open(page, path);
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      check(`${width}px ${path}: no horizontal scroll (${sw})`, sw <= width);
      if (width !== 768) {
        const v = await axe(page);
        check(`${width}px ${path}: axe WCAG 2.1 AA`, v.length === 0, describe(v));
      }
    }
    await ctx.close();
  }

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  for (const path of ["/", "/docs/quickstart", "/reserve", "/no-such-page"]) {
    await open(page, path);
    const t = await tabStops(page);
    check(
      `keyboard ${path}: first Tab is "Skip to content"`,
      t.first.startsWith("a:Skip to content"),
      t.first,
    );
    check(
      `keyboard ${path}: ${t.count} Tab stops, all visible with a focus outline`,
      t.bad.length === 0,
      t.bad.join(", "),
    );
  }
  // The skip link moves focus past the navigation.
  await open(page, "/docs/quickstart");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  const afterSkip = await page.evaluate(() => !!document.activeElement?.closest("main"));
  check("skip link: the next Tab lands inside <main>", afterSkip);
  await ctx.close();

  const rm = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const rp = await rm.newPage();
  for (const path of ["/", "/reserve"]) {
    await open(rp, path);
    await sleep(500);
    const running = await rp.evaluate(
      () => document.getAnimations().filter((a) => a.playState === "running").length,
    );
    check(`reduced motion ${path}: no running animations (${running})`, running === 0);
  }
  await open(rp, "/");
  check(
    "reduced motion: static hero, no canvas",
    (await rp.locator('.hero-art[data-mode="static"]').count()) === 1 &&
      (await rp.locator(".hero-art canvas").count()) === 0,
  );
  await rm.close();
  await browser.close();
}

main()
  .catch((e) => {
    console.error(e);
    failed = true;
  })
  .finally(() => {
    web?.kill("SIGTERM");
    console.log(failed ? "\nA11Y CHECKS FAILED" : `\nALL ${passed} A11Y CHECKS PASSED`);
    process.exit(failed ? 1 : 0);
  });
