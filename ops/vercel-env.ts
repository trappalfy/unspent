// Builds .env.vercel (gitignored) from the owner's .env.mainnet: every variable the site needs on Vercel, ready to
// paste into Project → Settings → Environment Variables (it accepts a whole .env). Generated secrets
// (SESSION_SECRET, SITE_ACCESS_KEY) are kept from an existing .env.vercel, so re-running doesn't log anyone out.
//
//   pnpm --filter @unspent/ops vercel-env          # test site on TEST_DOMAIN behind SITE_ACCESS_KEY, "Test Credit"
//   LAUNCH=1 pnpm --filter @unspent/ops vercel-env # the open site on DOMAIN, no access key

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./lib";

const parse = (path: string): Record<string, string> =>
  existsSync(path)
    ? Object.fromEntries(
        readFileSync(path, "utf8")
          .split("\n")
          .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l))
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
      )
    : {};

const owner = parse(resolve(ROOT, ".env.mainnet"));
const out = resolve(ROOT, ".env.vercel");
const prev = parse(out);
const launch = process.env.LAUNCH === "1";
const domain = launch ? owner.DOMAIN : owner.TEST_DOMAIN;
const need = (k: string, v: string | undefined) => {
  if (!v) throw new Error(`Fill ${k} in .env.mainnet first`);
  return v;
};
need(launch ? "DOMAIN" : "TEST_DOMAIN", domain);

const vars: Record<string, string> = {
  ENABLE_EXPERIMENTAL_COREPACK: "1",
  NEXT_PUBLIC_SOLANA_NETWORK: "mainnet",
  NEXT_PUBLIC_SITE_URL: `https://${domain}`,
  NEXT_PUBLIC_API_HOST: `api.${domain}`,
  NEXT_PUBLIC_X_URL: owner.X_URL ?? "",
  NEXT_PUBLIC_PRELAUNCH: "false",
  NEXT_PUBLIC_PROJECT_TOKEN_CA: "",
  SESSION_SECRET: prev.SESSION_SECRET || randomBytes(32).toString("base64"),
  DATABASE_URL: need("DATABASE_URL_POOLED", owner.DATABASE_URL_POOLED),
  RPC_URL: `https://mainnet.helius-rpc.com/?api-key=${need("HELIUS_API_KEY", owner.HELIUS_API_KEY)}`,
  JUPITER_API_KEY: owner.JUPITER_API_KEY ?? "",
  TOKEN_SYMBOL: launch ? need("TOKEN_SYMBOL", owner.TOKEN_SYMBOL) : "TST",
  SITE_ACCESS_KEY: launch ? "" : prev.SITE_ACCESS_KEY || randomBytes(18).toString("base64url"),
  LEGAL_ENTITY: owner.LEGAL_ENTITY ?? "",
  CONTACT_EMAIL: owner.CONTACT_EMAIL ?? "",
  GOVERNING_LAW: owner.GOVERNING_LAW ?? "",
};
writeFileSync(
  out,
  `${Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`,
  { mode: 0o600 },
);
console.log(`wrote .env.vercel (${Object.keys(vars).length} variables) for https://${domain}`);
if (!launch) console.log(`test site link: https://${domain}/?access=<SITE_ACCESS_KEY from .env.vercel>`);
