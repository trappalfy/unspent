// Regional check on the site (Q13): the app and its APIs are closed to known unsupported countries.

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "../proxy";

const req = (path: string, country?: string) =>
  new NextRequest(`http://localhost${path}`, { headers: country ? { "x-vercel-ip-country": country } : {} });

describe("proxy", () => {
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

  it("runs only on the app and its APIs", () => {
    expect(config.matcher).toEqual(["/app/:path*", "/api/:path*"]);
  });
});
