// API keys (brief 8.3): usp_live_ (mainnet) / usp_test_ (other networks) + 32 base62 chars.
// Only sha256(key) and the last 4 characters are stored; the full key is shown once.

import type { Network } from "./addresses";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BODY_LEN = 32;
const KEY_RE = /^usp_(live|test)_[0-9A-Za-z]{32}$/;

export function apiKeyPrefix(network: Network): string {
  return network === "mainnet" ? "usp_live_" : "usp_test_";
}

/** Uniform base62 via rejection sampling (bytes ≥ 248 are discarded). */
export function generateApiKey(network: Network): string {
  let body = "";
  while (body.length < BODY_LEN) {
    for (const b of crypto.getRandomValues(new Uint8Array(BODY_LEN))) {
      if (b < 248 && body.length < BODY_LEN) body += ALPHABET[b % 62];
    }
  }
  return apiKeyPrefix(network) + body;
}

export function isApiKeyFormat(key: string): boolean {
  return KEY_RE.test(key);
}

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

export function apiKeyLast4(key: string): string {
  return key.slice(-4);
}
