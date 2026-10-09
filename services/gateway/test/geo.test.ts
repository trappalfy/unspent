// Regional check (Q13): known unsupported country → 403 before any hold; supported or unknown → served.

import { existsSync } from "node:fs";
import { requests } from "@unspent/db";
import { afterEach, describe, expect, it } from "vitest";
import { clientIp, loadGeo } from "../src/geo";
import { type Harness, msgBody, startHarness } from "./harness";

const COUNTRIES: Record<string, string> = { "203.0.113.1": "US", "203.0.113.2": "CN" };
const geo = (ip: string) => COUNTRIES[ip] ?? null;

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
const use = async (o: Parameters<typeof startHarness>[0]) => {
  h = await startHarness(o);
  return h;
};

describe("regional check", () => {
  it("refuses a request from an unsupported country before holding anything", async () => {
    const h = await use({ geo });
    const res = await h.messages(msgBody(), { "fly-client-ip": "203.0.113.2" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toEqual({
      type: "permission_error",
      message: "Unspent is not available in your country or region.",
    });
    expect(await h.db.select().from(requests)).toHaveLength(0);
    expect(h.mock.requests).toHaveLength(0);
  });

  it("answers in the OpenAI format on /v1/chat/completions", async () => {
    const h = await use({ geo });
    const res = await h.chat(
      { model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }] },
      { "fly-client-ip": "203.0.113.2" },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("region_not_supported");
  });

  it("serves a supported country and an unknown one", async () => {
    const h = await use({ geo });
    expect((await h.messages(msgBody(), { "fly-client-ip": "203.0.113.1" })).status).toBe(200);
    expect((await h.messages(msgBody(), { "fly-client-ip": "198.51.100.7" })).status).toBe(200);
    expect((await h.messages(msgBody())).status).toBe(200);
  });

  it("takes Fly's client IP over X-Forwarded-For", () => {
    expect(clientIp(new Headers({ "fly-client-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" }))).toBe(
      "1.2.3.4",
    );
    expect(clientIp(new Headers({ "x-forwarded-for": "5.6.7.8, 10.0.0.1" }))).toBe("5.6.7.8");
    expect(clientIp(new Headers())).toBeNull();
  });

  // The real database, when one has been fetched: GEOIP_TEST_DB=path/to/country.mmdb
  const db = process.env.GEOIP_TEST_DB;
  it.skipIf(!db || !existsSync(db))("reads countries from the DB-IP database", () => {
    const lookup = loadGeo(db!)!;
    expect(lookup("8.8.8.8")).toBe("US");
    expect(lookup("127.0.0.1")).toBeNull();
  });
});
