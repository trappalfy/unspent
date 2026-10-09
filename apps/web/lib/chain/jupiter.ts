// Jupiter Swap API v2 `/build` (docs/STAGE1_RECON.md, 4.1 p.6): raw instructions we compose with our own in one
// versioned transaction. ExactIn only; the browser talks to our /api/jupiter proxy so the key stays on the server.

import { AccountRole, type Address, address, getBase64Encoder, type Instruction } from "@solana/kit";

type JupIx = {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
};

export type JupiterBuild = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct?: string;
  routePlan: { percent: number; swapInfo: { label: string } }[];
  computeBudgetInstructions: JupIx[];
  setupInstructions: JupIx[];
  swapInstruction: JupIx;
  cleanupInstruction: JupIx | null;
  otherInstructions: JupIx[];
  tipInstruction: JupIx | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
};

const b64 = getBase64Encoder();

function role(a: JupIx["accounts"][number]): AccountRole {
  if (a.isSigner) return a.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER;
  return a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;
}

export function toInstruction(ix: JupIx): Instruction {
  return {
    programAddress: address(ix.programId),
    accounts: ix.accounts.map((a) => ({ address: address(a.pubkey), role: role(a) })),
    data: b64.encode(ix.data),
  };
}

/** Swap instructions in execution order; compute budget is ours (set after simulation), no tips. */
export function jupiterInstructions(b: JupiterBuild): { before: Instruction[] } {
  return {
    before: [
      ...b.otherInstructions.map(toInstruction),
      ...b.setupInstructions.map(toInstruction),
      toInstruction(b.swapInstruction),
      ...(b.cleanupInstruction ? [toInstruction(b.cleanupInstruction)] : []),
    ],
  };
}

export function lookupTables(b: JupiterBuild): Record<Address, Address[]> {
  const out: Record<Address, Address[]> = {};
  for (const [k, v] of Object.entries(b.addressesByLookupTableAddress ?? {}))
    out[address(k)] = v.map(address);
  return out;
}

export type JupiterSide = "buy" | "sell";

/** Smaller routes when the composed transaction doesn't fit in 1232 bytes (recon: 48 → 40 → 32 → 24). */
export const MAX_ACCOUNTS_STEPS = [48, 40, 32, 24] as const;

export class NoRouteError extends Error {}

export async function fetchBuild(params: {
  side: JupiterSide;
  mint: string;
  amount: bigint;
  taker: string;
  slippageBps: number;
  maxAccounts: number;
}): Promise<JupiterBuild> {
  const q = new URLSearchParams({
    side: params.side,
    mint: params.mint,
    amount: params.amount.toString(),
    taker: params.taker,
    slippageBps: String(params.slippageBps),
    maxAccounts: String(params.maxAccounts),
  });
  const res = await fetch(`/api/jupiter/build?${q}`);
  const body = await res.json().catch(() => ({}));
  if (res.status === 404) throw new NoRouteError(body.error ?? "No route found.");
  if (!res.ok) throw new Error(body.error ?? `Quote failed (${res.status})`);
  return body as JupiterBuild;
}

export type TokenInfo = { mint: string; symbol: string; name: string; icon: string | null; decimals: number };

export async function fetchTokenInfo(mints: string[]): Promise<Record<string, TokenInfo>> {
  if (!mints.length) return {};
  const res = await fetch(`/api/jupiter/tokens?mints=${mints.join(",")}`);
  if (!res.ok) return {};
  return (await res.json()) as Record<string, TokenInfo>;
}

/**
 * Fetches a route and composes it with our instructions, shrinking the route until the transaction fits
 * (1232 bytes). `prepareTx` is tx.prepare bound to the RPC and fee payer.
 */
export async function composeSwap<T>(
  getBuild: (maxAccounts: number) => Promise<JupiterBuild>,
  compose: (b: JupiterBuild) => Promise<Instruction[]>,
  prepareTx: (ixs: Instruction[], alts: Record<Address, Address[]>) => Promise<T>,
  isTooLarge: (e: unknown) => boolean,
): Promise<{ build: JupiterBuild; prepared: T; ixs: Instruction[] }> {
  let last: unknown;
  for (const max of MAX_ACCOUNTS_STEPS) {
    const build = await getBuild(max);
    const ixs = await compose(build);
    try {
      return { build, ixs, prepared: await prepareTx(ixs, lookupTables(build)) };
    } catch (e) {
      if (!isTooLarge(e)) throw e;
      last = e;
    }
  }
  throw last;
}
