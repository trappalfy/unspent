// API key authentication (brief 8.3): x-api-key or Authorization: Bearer. Keys are looked up by sha256.

import { and, apiKeys, eq, wallets } from "@unspent/db";
import { isApiKeyFormat, sha256 } from "@unspent/shared";

import type { Db } from "./db";

export type AuthedKey = {
  id: string;
  wallet: string;
  name: string;
  dailyLimitUcr: bigint | null;
  allowedModels: string[] | null;
};

export function extractKey(headers: Headers): string | null {
  const x = headers.get("x-api-key");
  if (x) return x.trim();
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return null;
}

export async function authenticate(db: Db, headers: Headers): Promise<AuthedKey | null> {
  const key = extractKey(headers);
  if (!key || !isApiKeyFormat(key)) return null;
  const hash = await sha256(key);
  const rows = await db
    .select({
      id: apiKeys.id,
      wallet: apiKeys.wallet,
      name: apiKeys.name,
      dailyLimitUcr: apiKeys.dailyLimitUcr,
      allowedModels: apiKeys.allowedModels,
      blocked: wallets.blocked,
    })
    .from(apiKeys)
    .innerJoin(wallets, eq(wallets.address, apiKeys.wallet))
    .where(and(eq(apiKeys.keyHash, hash), eq(apiKeys.status, "active")))
    .limit(1);
  const r = rows[0];
  if (!r || r.blocked) return null;
  return {
    id: r.id,
    wallet: r.wallet,
    name: r.name,
    dailyLimitUcr: r.dailyLimitUcr,
    allowedModels: r.allowedModels,
  };
}
