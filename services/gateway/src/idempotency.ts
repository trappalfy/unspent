// Idempotency-Key (brief 8.4): bound to sha256 of the normalized body and to the wallet. A repeat never reaches the
// provider twice. The key is "burned" only once the request was sent to the provider; earlier failures free it.

import { and, eq, idempotencyKeys, lt, requests } from "@unspent/db";
import { sha256 } from "@unspent/shared";

import type { Db } from "./db";

const TTL_MS = 24 * 3600 * 1000;

/** JSON with sorted keys, so the same request body always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export type IdemClaim =
  | { kind: "none" }
  | { kind: "claimed"; keyHash: Uint8Array }
  | { kind: "in_progress" }
  | { kind: "already_processed"; requestId: string; chargedUcr: bigint | null }
  | { kind: "reused" }
  | { kind: "invalid" };

const OPEN = new Set(["reserving", "reserved", "dispatched"]);

export async function claimIdempotency(
  db: Db,
  wallet: string,
  header: string | null,
  body: unknown,
): Promise<IdemClaim> {
  if (header === null) return { kind: "none" };
  if (header.length < 8 || header.length > 128) return { kind: "invalid" };
  const keyHash = await sha256(header);
  const bodyHash = await sha256(canonicalJson(body));
  const now = new Date();
  await db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, now));
  const inserted = await db
    .insert(idempotencyKeys)
    .values({ wallet, keyHash, bodyHash, expiresAt: new Date(now.getTime() + TTL_MS) })
    .onConflictDoNothing()
    .returning({ wallet: idempotencyKeys.wallet });
  if (inserted.length) return { kind: "claimed", keyHash };

  const [row] = await db
    .select({ bodyHash: idempotencyKeys.bodyHash, requestUuid: idempotencyKeys.requestUuid })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.wallet, wallet), eq(idempotencyKeys.keyHash, keyHash)));
  if (!row) return claimIdempotency(db, wallet, header, body);
  if (Buffer.compare(Buffer.from(row.bodyHash), Buffer.from(bodyHash)) !== 0) return { kind: "reused" };
  if (!row.requestUuid) return { kind: "in_progress" };
  const [req] = await db
    .select({
      requestId: requests.requestId,
      status: requests.status,
      charged: requests.chargedUcr,
      dispatchedAt: requests.dispatchedAt,
    })
    .from(requests)
    .where(eq(requests.id, row.requestUuid));
  if (!req || OPEN.has(req.status)) return { kind: "in_progress" };
  if (!req.dispatchedAt) {
    // Ended without reaching the provider (e.g. an internal error): the key is free again.
    await releaseIdempotency(db, wallet, keyHash);
    return claimIdempotency(db, wallet, header, body);
  }
  return {
    kind: "already_processed",
    requestId: Buffer.from(req.requestId).toString("hex"),
    chargedUcr: req.charged,
  };
}

export async function linkIdempotency(db: Db, wallet: string, keyHash: Uint8Array, requestUuid: string) {
  await db
    .update(idempotencyKeys)
    .set({ requestUuid })
    .where(and(eq(idempotencyKeys.wallet, wallet), eq(idempotencyKeys.keyHash, keyHash)));
}

/** Frees the key when the request ended before reaching the provider (or got an error before the first token). */
export async function releaseIdempotency(db: Db, wallet: string, keyHash: Uint8Array) {
  await db
    .delete(idempotencyKeys)
    .where(and(eq(idempotencyKeys.wallet, wallet), eq(idempotencyKeys.keyHash, keyHash)));
}
