// API keys of a wallet (brief 8.3, 10.1): the secret is shown once, only its SHA-256 and last 4 chars are stored.
// Every query is scoped to the signed-in wallet and network.

import { and, apiKeys, count, type Db, desc, eq, wallets } from "@unspent/db";
import {
  apiKeyPrefix,
  CLAUDE_MODELS,
  creditsToUcr,
  generateApiKey,
  type Network,
  sha256,
} from "@unspent/shared";

export const MAX_ACTIVE_KEYS = 20;
export const KEY_NAME_MAX = 64;

export type KeyRow = {
  id: string;
  name: string;
  last4: string;
  prefix: string;
  dailyLimitUcr: bigint | null;
  allowedModels: string[] | null;
  status: "active" | "revoked";
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

export const selectableModels = () => CLAUDE_MODELS.filter((m) => m.enabled).map((m) => m.id);

export async function listKeys(db: Db, wallet: string, network: Network): Promise<KeyRow[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.wallet, wallet), eq(apiKeys.network, network)))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    last4: r.last4,
    prefix: apiKeyPrefix(network),
    dailyLimitUcr: r.dailyLimitUcr,
    allowedModels: r.allowedModels,
    status: r.status as KeyRow["status"],
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
  }));
}

export type CreateKeyInput = { name: string; dailyLimit: string; models: string[] };

export type CreateKeyResult = { ok: true; apiKey: string; id: string } | { ok: false; error: string };

/** Validates the form values; returns the error to show next to the form. */
export function parseKeyInput(
  input: CreateKeyInput,
):
  | { ok: true; name: string; dailyLimitUcr: bigint | null; allowedModels: string[] | null }
  | { ok: false; error: string } {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the key a name." };
  if (name.length > KEY_NAME_MAX) return { ok: false, error: `Names are up to ${KEY_NAME_MAX} characters.` };
  let dailyLimitUcr: bigint | null = null;
  if (input.dailyLimit.trim()) {
    try {
      dailyLimitUcr = creditsToUcr(input.dailyLimit);
    } catch {
      return { ok: false, error: "Daily limit must be a number of credits, like 5 or 2.5." };
    }
    if (dailyLimitUcr <= 0n)
      return { ok: false, error: "Daily limit must be above zero, or leave it empty." };
  }
  const known = new Set(selectableModels());
  const models = [...new Set(input.models)];
  if (models.some((m) => !known.has(m))) return { ok: false, error: "Unknown model selected." };
  // All models selected = no restriction, so models added later work too.
  const allowedModels = models.length === 0 || models.length === known.size ? null : models;
  return { ok: true, name, dailyLimitUcr, allowedModels };
}

export async function createKey(
  db: Db,
  wallet: string,
  network: Network,
  input: CreateKeyInput,
): Promise<CreateKeyResult> {
  const parsed = parseKeyInput(input);
  if (!parsed.ok) return parsed;
  const [active] = await db
    .select({ n: count() })
    .from(apiKeys)
    .where(and(eq(apiKeys.wallet, wallet), eq(apiKeys.network, network), eq(apiKeys.status, "active")));
  if ((active?.n ?? 0) >= MAX_ACTIVE_KEYS)
    return { ok: false, error: `You have ${MAX_ACTIVE_KEYS} active keys. Revoke one to create another.` };
  await db.insert(wallets).values({ address: wallet }).onConflictDoNothing();
  const apiKey = generateApiKey(network);
  const [row] = await db
    .insert(apiKeys)
    .values({
      wallet,
      network,
      name: parsed.name,
      keyHash: await sha256(apiKey),
      last4: apiKey.slice(-4),
      dailyLimitUcr: parsed.dailyLimitUcr,
      allowedModels: parsed.allowedModels,
    })
    .returning({ id: apiKeys.id });
  return { ok: true, apiKey, id: row!.id };
}

export async function revokeKey(db: Db, wallet: string, network: Network, id: string): Promise<boolean> {
  const rows = await db
    .update(apiKeys)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, id),
        eq(apiKeys.wallet, wallet),
        eq(apiKeys.network, network),
        eq(apiKeys.status, "active"),
      ),
    )
    .returning({ id: apiKeys.id });
  return rows.length === 1;
}
