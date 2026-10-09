import { type NextRequest, NextResponse } from "next/server";
import { chain } from "@/lib/env";
import { SIWS_TTL_SEC, setSiwsCookie, signToken } from "@/lib/session";
import { SIWS_STATEMENT, type SiwsInput } from "@/lib/siws";

// Issues a one-time SIWS input. The exact input is kept in a signed httpOnly cookie and checked on verify.
export async function POST(req: NextRequest) {
  const now = new Date();
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const input: SiwsInput = {
    domain: req.nextUrl.host,
    statement: SIWS_STATEMENT,
    uri: req.nextUrl.origin,
    version: "1",
    chainId: chain.slice("solana:".length),
    nonce,
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + SIWS_TTL_SEC * 1000).toISOString(),
  };
  await setSiwsCookie(await signToken({ input }, SIWS_TTL_SEC, "siws"));
  return NextResponse.json(input, { headers: { "cache-control": "no-store" } });
}
