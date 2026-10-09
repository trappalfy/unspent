import { UNSPENT_PROGRAM_ADDRESS } from "@unspent/program";
import { clientIp, limited } from "@/lib/server/ratelimit";
import { rpcUrl } from "@/lib/server/rpc";

// JSON-RPC relay for the browser: only the methods the app uses, so the private RPC key stays on the server.
const ALLOWED = new Set([
  "getLatestBlockhash",
  "simulateTransaction",
  "sendTransaction",
  "getSignatureStatuses",
  "getRecentPrioritizationFees",
  "getBlockHeight",
  "getBalance",
  "getAccountInfo",
  "getMultipleAccounts",
  "getTokenAccountsByOwner",
  "getProgramAccounts",
  "getMinimumBalanceForRentExemption",
]);

const fail = (status: number, message: string, id: unknown = null) =>
  Response.json({ jsonrpc: "2.0", id, error: { code: -32600, message } }, { status });

export async function POST(req: Request) {
  if (limited(`rpc:${clientIp(req)}`, 300, 60_000)) return fail(429, "Too many requests");
  const text = await req.text();
  if (text.length > 64_000) return fail(413, "Request too large");
  let body: { id?: unknown; method?: string; params?: unknown[] };
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "Invalid JSON");
  }
  if (Array.isArray(body) || typeof body.method !== "string" || !ALLOWED.has(body.method))
    return fail(403, "Method not allowed", body?.id);
  if (body.method === "getProgramAccounts" && body.params?.[0] !== UNSPENT_PROGRAM_ADDRESS)
    return fail(403, "Method not allowed", body.id);
  const upstream = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: text,
    cache: "no-store",
  }).catch(() => null);
  if (!upstream) return fail(502, "RPC unreachable", body.id);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
