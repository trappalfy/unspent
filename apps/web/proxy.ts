import { regionAllowed } from "@unspent/shared";
import { type NextRequest, NextResponse } from "next/server";

// Q13: the app and its APIs serve only countries where Anthropic's services are available. Vercel puts the visitor's
// country in x-vercel-ip-country; without it (local development) nothing is blocked. The landing page, Docs and the
// legal pages stay readable everywhere.
export function proxy(req: NextRequest) {
  if (regionAllowed(req.headers.get("x-vercel-ip-country"))) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/"))
    return NextResponse.json(
      { error: "Unspent is not available in your country or region." },
      { status: 451 },
    );
  return NextResponse.rewrite(new URL("/unavailable", req.url));
}

export const config = { matcher: ["/app/:path*", "/api/:path*"] };
