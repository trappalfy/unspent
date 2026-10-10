import { regionAllowed } from "@unspent/shared";
import { type NextRequest, NextResponse } from "next/server";

const ACCESS_COOKIE = "unspent_access";
const ACCESS_DAYS = 30;

export function proxy(req: NextRequest) {
  // Test site on a throwaway domain (owner, 2026-10-10): with SITE_ACCESS_KEY set, every path answers 404 until the
  // visitor opens any URL once with ?access=<key>; a cookie then lets that browser in for 30 days.
  const key = process.env.SITE_ACCESS_KEY;
  if (key) {
    if (req.nextUrl.searchParams.get("access") === key) {
      const url = req.nextUrl.clone();
      url.searchParams.delete("access");
      const res = NextResponse.redirect(url);
      res.cookies.set(ACCESS_COOKIE, key, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: ACCESS_DAYS * 86_400,
      });
      return res;
    }
    if (req.cookies.get(ACCESS_COOKIE)?.value !== key) return new NextResponse(null, { status: 404 });
  }

  // Q13: the app and its APIs serve only countries where Anthropic's services are available. Vercel puts the
  // visitor's country in x-vercel-ip-country; without it (local development) nothing is blocked. The landing page,
  // Docs and the legal pages stay readable everywhere.
  const { pathname } = req.nextUrl;
  const app = pathname === "/app" || pathname.startsWith("/app/") || pathname.startsWith("/api/");
  if (!app || regionAllowed(req.headers.get("x-vercel-ip-country"))) return NextResponse.next();
  if (pathname.startsWith("/api/"))
    return NextResponse.json(
      { error: "Unspent is not available in your country or region." },
      { status: 451 },
    );
  return NextResponse.rewrite(new URL("/unavailable", req.url));
}

// Everything but Next's own build assets: the access key guards every page and file when it is set.
export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
