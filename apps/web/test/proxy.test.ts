// Site proxy: the regional check (Q13) on the app and its APIs, and the optional access key for a test domain.

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, proxy } from "../proxy";

const req = (path: string, country?: string, cookie?: string) =>
  new NextRequest(`http://localhost${path}`, {
    headers: { ...(country ? { "x-vercel-ip-country": country } : {}), ...(cookie ? { cookie } : {}) },
  });

afterEach(() => vi.unstubAllEnvs());

describe("proxy: regional check", () => {
  it("lets supported and unknown countries through", () => {
    expect(proxy(req("/app/buy", "US")).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(req("/app/buy")).headers.get("x-middleware-next")).toBe("1");
  });

  it("shows the unavailable page for the app and 451 for APIs elsewhere", async () => {
    const page = proxy(req("/app/buy", "CN"));
    expect(page.headers.get("x-middleware-rewrite")).toBe("http://localhost/unavailable");
    const api = proxy(req("/api/rpc", "CN"));
    expect(api.status).toBe(451);
  });

  it("leaves the landing page, Docs and legal pages open everywhere", () => {
    for (const path of ["/", "/docs/quickstart", "/terms", "/privacy"])
      expect(proxy(req(path, "CN")).headers.get("x-middleware-next")).toBe("1");
  });

  it("runs on everything but Next's build assets", () => {
    expect(config.matcher).toEqual(["/((?!_next/static|_next/image).*)"]);
  });
});

describe("proxy: access key for a test domain", () => {
  it("is off without SITE_ACCESS_KEY", () => {
    expect(proxy(req("/")).headers.get("x-middleware-next")).toBe("1");
  });

  it("answers 404 without the key, sets a cookie from ?access= and then lets the browser in", () => {
    vi.stubEnv("SITE_ACCESS_KEY", "s3cret-key");
    expect(proxy(req("/")).status).toBe(404);
    expect(proxy(req("/app/buy?access=wrong")).status).toBe(404);
    const open = proxy(req("/app/buy?access=s3cret-key&x=1"));
    expect(open.status).toBe(307);
    expect(open.headers.get("location")).toBe("http://localhost/app/buy?x=1");
    expect(open.cookies.get("unspent_access")?.value).toBe("s3cret-key");
    expect(proxy(req("/docs", undefined, "unspent_access=s3cret-key")).headers.get("x-middleware-next")).toBe(
      "1",
    );
    expect(proxy(req("/docs", undefined, "unspent_access=old")).status).toBe(404);
  });
});
