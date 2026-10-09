import type { NextRequest } from "next/server";
import type { JupiterSide } from "@/lib/chain/jupiter";
import { jupiterBuild } from "@/lib/jupiter-api";
import { getProgram } from "@/lib/server/program";
import { clientIp, limited } from "@/lib/server/ratelimit";

export async function GET(req: NextRequest) {
  if (limited(`jup:${clientIp(req)}`, 30, 60_000))
    return Response.json({ error: "Too many quote requests. Wait a few seconds." }, { status: 429 });
  const q = req.nextUrl.searchParams;
  const side = q.get("side") as JupiterSide;
  if (side !== "buy" && side !== "sell") return Response.json({ error: "Invalid side." }, { status: 400 });
  const program = await getProgram();
  if (!program) return Response.json({ error: "Unspent isn't live on this network yet." }, { status: 503 });
  let amount: bigint;
  try {
    amount = BigInt(q.get("amount") ?? "");
  } catch {
    return Response.json({ error: "Invalid amount." }, { status: 400 });
  }
  const r = await jupiterBuild(
    {
      side,
      mint: q.get("mint") ?? "",
      amount,
      taker: q.get("taker") ?? "",
      slippageBps: Number(q.get("slippageBps") ?? 50),
      maxAccounts: Number(q.get("maxAccounts") ?? 48),
    },
    { usdc: program.usdcMint, credit: program.creditMint },
  );
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json(r.build, { headers: { "cache-control": "no-store" } });
}
