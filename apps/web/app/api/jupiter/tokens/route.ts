import type { NextRequest } from "next/server";
import { jupiterTokens } from "@/lib/jupiter-api";

export async function GET(req: NextRequest) {
  const mints = (req.nextUrl.searchParams.get("mints") ?? "").split(",").filter(Boolean);
  return Response.json(await jupiterTokens(mints), { headers: { "cache-control": "public, max-age=3600" } });
}
