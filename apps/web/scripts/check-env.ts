// Runs before `next build`. On a Vercel production build (or with CHECK_ENV=1) it refuses to ship a site that can't
// work: every required variable set and sane, the Solana RPC answering on the right cluster, the database reachable
// and its tables migrated. Anything missing fails the build with one readable list instead of a broken deployment.

import { openPostgres } from "@unspent/db";

const strict = process.env.VERCEL_ENV === "production" || process.env.CHECK_ENV === "1";
if (!strict) process.exit(0);

const env = (k: string) => (process.env[k] ?? "").trim();
const problems: string[] = [];
const warnings: string[] = [];
const isLocal = (s: string) => /localhost|127\.0\.0\.1/.test(s);

const site = env("NEXT_PUBLIC_SITE_URL");
if (!/^https:\/\/[^/]+$/.test(site) || isLocal(site))
  problems.push(
    `NEXT_PUBLIC_SITE_URL must be the site's https address without a trailing slash (now "${site}")`,
  );
const apiHost = env("NEXT_PUBLIC_API_HOST");
if (!apiHost || isLocal(apiHost) || apiHost.includes("/"))
  problems.push(`NEXT_PUBLIC_API_HOST must be the API host, e.g. api.example.com (now "${apiHost}")`);
const network = env("NEXT_PUBLIC_SOLANA_NETWORK") || "mainnet";
if (network !== "mainnet") problems.push(`NEXT_PUBLIC_SOLANA_NETWORK must be mainnet (now "${network}")`);
if (env("SESSION_SECRET").length < 32) problems.push("SESSION_SECRET must be set (32+ characters)");
if (!env("TOKEN_SYMBOL")) problems.push("TOKEN_SYMBOL must be set");
if (!env("JUPITER_API_KEY"))
  warnings.push("JUPITER_API_KEY is empty: buying with SOL and selling credits won't work");

const rpc = env("RPC_URL");
if (!/^https:\/\//.test(rpc)) problems.push("RPC_URL must be set (https)");
else {
  try {
    const r = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await r.json()) as { result?: string };
    if (body.result !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")
      problems.push(`RPC_URL doesn't answer as Solana mainnet (HTTP ${r.status})`);
  } catch (e) {
    problems.push(`RPC_URL is unreachable: ${(e as Error).message}`);
  }
}

// Migrations need a direct connection (the advisory lock is per session); Neon's Vercel integration names it
// DATABASE_URL_UNPOOLED. The site itself runs on the pooled DATABASE_URL.
const pooled = env("DATABASE_URL");
const direct = env("DATABASE_URL_UNPOOLED") || env("DATABASE_URL_DIRECT") || pooled;
if (!/^postgres(ql)?:\/\//.test(pooled))
  problems.push("DATABASE_URL must be set (Neon pooled connection string)");
else {
  try {
    const { close } = await openPostgres(direct, { max: 2, migrate: true, prepare: false });
    await close();
  } catch (e) {
    problems.push(`database unreachable or migration failed: ${(e as Error).message}`);
  }
}

for (const w of warnings) console.warn(`! ${w}`);
if (problems.length) {
  console.error(
    `\nThe site can't ship: fix these in Vercel → Settings → Environment Variables, then redeploy.\n`,
  );
  for (const p of problems) console.error(`✗ ${p}`);
  console.error("");
  process.exit(1);
}
console.log(
  "✓ environment checked: site URL, API host, Solana mainnet RPC, session secret, database migrated",
);
