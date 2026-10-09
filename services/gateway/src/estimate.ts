// Reservation inputs from a Messages request body (brief 5.5 step 2).

import type { CacheWriteTtl, ReservationInput } from "@unspent/shared";
import { isWebSearchTool } from "./filter";

export type BodyEstimate = {
  /** UTF-8 bytes of everything that becomes prompt text. */
  textBytes: number;
  /** Images or documents present: the input must be counted exactly with count_tokens. */
  needsExactCount: boolean;
  cacheWrite: CacheWriteTtl;
  webSearch?: { maxUses?: number };
  maxTokens: number;
};

function scan(node: unknown, acc: { media: boolean; ttl: CacheWriteTtl }) {
  if (Array.isArray(node)) {
    for (const x of node) scan(x, acc);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (o.type === "image" || o.type === "document") acc.media = true;
  const cc = o.cache_control as { ttl?: unknown } | undefined;
  if (cc && typeof cc === "object") acc.ttl = cc.ttl === "1h" || acc.ttl === "1h" ? "1h" : "5m";
  for (const v of Object.values(o)) if (v && typeof v === "object") scan(v, acc);
}

export function estimateBody(body: Record<string, unknown>): BodyEstimate {
  const acc = { media: false, ttl: "none" as CacheWriteTtl };
  scan(body, acc);
  const promptParts = {
    system: body.system,
    messages: body.messages,
    tools: body.tools,
    tool_choice: body.tool_choice,
  };
  const textBytes = new TextEncoder().encode(JSON.stringify(promptParts)).length;
  const search = Array.isArray(body.tools)
    ? (body.tools as { type?: unknown; max_uses?: unknown }[]).find((t) => isWebSearchTool(t?.type))
    : undefined;
  return {
    textBytes,
    needsExactCount: acc.media,
    cacheWrite: acc.ttl,
    ...(search ? { webSearch: typeof search.max_uses === "number" ? { maxUses: search.max_uses } : {} } : {}),
    maxTokens: body.max_tokens as number,
  };
}

export function toReservationInput(est: BodyEstimate, inputTokens: number): ReservationInput {
  return {
    inputTokens,
    maxTokens: est.maxTokens,
    cacheWrite: est.cacheWrite,
    ...(est.webSearch ? { webSearch: est.webSearch } : {}),
  };
}
