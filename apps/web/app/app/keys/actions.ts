"use server";

import { revalidatePath } from "next/cache";
import { network } from "@/lib/env";
import { type CreateKeyInput, type CreateKeyResult, createKey, revokeKey } from "@/lib/keys";
import { getDb } from "@/lib/server/db";
import { getSession } from "@/lib/session";

// Server actions run with the signed-in wallet from the session cookie; a key is only ever issued to that wallet.

export async function createKeyAction(input: CreateKeyInput): Promise<CreateKeyResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Your session ended. Sign in again." };
  const r = await createKey(await getDb(), session.address, network, {
    name: String(input.name ?? ""),
    dailyLimit: String(input.dailyLimit ?? ""),
    models: Array.isArray(input.models) ? input.models.map(String) : [],
  });
  if (r.ok) revalidatePath("/app/keys");
  return r;
}

export async function revokeKeyAction(id: string): Promise<{ ok: boolean }> {
  const session = await getSession();
  if (!session) return { ok: false };
  const ok = await revokeKey(await getDb(), session.address, network, String(id));
  if (ok) revalidatePath("/app/keys");
  return { ok };
}
