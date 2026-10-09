// Server side of the Jupiter integration: the only place that talks to api.jup.ag (key from JUPITER_API_KEY).
// Buy routes always end in USDC; sell routes always start from the credit mint, so the proxy isn't a general relay.

import type { JupiterBuild, JupiterSide, TokenInfo } from "./chain/jupiter";

const BASE = process.env.JUPITER_API_URL ?? "https://api.jup.ag";
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function headers(): Record<string, string> {
  const key = process.env.JUPITER_API_KEY;
  return key ? { "x-api-key": key } : {};
}

export type BuildParams = {
  side: JupiterSide;
  /** Token being sold for a buy; ignored for a sell (always the credit mint). */
  mint: string;
  amount: bigint;
  taker: string;
  slippageBps: number;
  maxAccounts: number;
  /** Restrict the route to these DEX labels (forked-chain tests avoid oracle-driven prop AMMs). */
  dexes?: string;
};

export type BuildResult = { ok: true; build: JupiterBuild } | { ok: false; status: number; error: string };

export async function jupiterBuild(
  p: BuildParams,
  mints: { usdc: string; credit: string },
): Promise<BuildResult> {
  const inputMint = p.side === "buy" ? p.mint : mints.credit;
  if (!MINT_RE.test(inputMint) || !MINT_RE.test(p.taker))
    return { ok: false, status: 400, error: "Invalid address." };
  if (p.side === "buy" && inputMint === mints.usdc)
    return { ok: false, status: 400, error: "Use the USDC tab to buy with USDC." };
  if (p.amount <= 0n) return { ok: false, status: 400, error: "Enter an amount above zero." };
  if (!Number.isInteger(p.slippageBps) || p.slippageBps < 1 || p.slippageBps > 500)
    return { ok: false, status: 400, error: "Slippage must be between 0.01% and 5%." };
  const q = new URLSearchParams({
    inputMint,
    outputMint: mints.usdc,
    amount: p.amount.toString(),
    taker: p.taker,
    slippageBps: String(p.slippageBps),
    maxAccounts: String(Math.min(64, Math.max(16, p.maxAccounts))),
    wrapAndUnwrapSol: "true",
  });
  // JUPITER_DEXES only for local forks, whose stale clocks break oracle-driven AMMs; unset in production.
  const dexes = p.dexes ?? process.env.JUPITER_DEXES;
  if (dexes) q.set("dexes", dexes);
  let res: Response;
  try {
    res = await fetch(`${BASE}/swap/v2/build?${q}`, { headers: headers(), cache: "no-store" });
  } catch {
    return { ok: false, status: 502, error: "Jupiter is unreachable. Try again in a moment." };
  }
  const body = (await res.json().catch(() => ({}))) as Partial<JupiterBuild> & {
    error?: string;
    errorCode?: string;
  };
  if (res.status === 429)
    return { ok: false, status: 429, error: "Too many quote requests. Wait a few seconds." };
  if (!res.ok || !body.swapInstruction) {
    const msg = body.error ?? "";
    if (
      res.status === 400 &&
      /route|liquidity|TOKEN_NOT_TRADABLE|not tradable/i.test(`${msg} ${body.errorCode}`)
    )
      return {
        ok: false,
        status: 404,
        error: p.side === "sell" ? "No market for credits yet." : "No route for this token.",
      };
    if (/amount/i.test(msg)) return { ok: false, status: 400, error: "Amount is too small to swap." };
    return {
      ok: false,
      status: res.status >= 500 ? 502 : 400,
      error: msg || "Jupiter couldn't build this swap.",
    };
  }
  if (body.swapMode !== "ExactIn") return { ok: false, status: 502, error: "Unexpected swap mode." };
  return { ok: true, build: body as JupiterBuild };
}

export async function jupiterTokens(mints: string[]): Promise<Record<string, TokenInfo>> {
  const valid = [...new Set(mints)].filter((m) => MINT_RE.test(m)).slice(0, 100);
  if (!valid.length) return {};
  const res = await fetch(`${BASE}/tokens/v2/search?query=${valid.join(",")}`, {
    headers: headers(),
    next: { revalidate: 3600 },
  }).catch(() => null);
  if (!res?.ok) return {};
  const list = (await res.json().catch(() => [])) as {
    id: string;
    symbol: string;
    name: string;
    icon?: string;
    decimals: number;
  }[];
  const out: Record<string, TokenInfo> = {};
  for (const t of list)
    out[t.id] = { mint: t.id, symbol: t.symbol, name: t.name, icon: t.icon ?? null, decimals: t.decimals };
  return out;
}
