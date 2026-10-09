// Keys and usage data access against PGlite: scoping to the signed-in wallet, validation, show-once secrets,
// spend aggregation and CSV export.

import { apiKeys, type Db, openTestDb, requests } from "@unspent/db";
import { isApiKeyFormat, sha256 } from "@unspent/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKey, listKeys, MAX_ACTIVE_KEYS, parseKeyInput, revokeKey } from "../lib/keys";
import { CSV_HEADER, spendByDay, toCsvLine, usageRows } from "../lib/usage";
import { parseCursor, parseUsageFilter } from "../lib/usage-filter";

let db: Db;
let close: () => Promise<void>;
const A = "WalletA111111111111111111111111111111111111";
const B = "WalletB111111111111111111111111111111111111";

beforeAll(async () => {
  ({ db, close } = await openTestDb());
});
afterAll(() => close());

describe("keys", () => {
  it("validates input", () => {
    expect(parseKeyInput({ name: " ", dailyLimit: "", models: [] })).toMatchObject({ ok: false });
    expect(parseKeyInput({ name: "x".repeat(65), dailyLimit: "", models: [] })).toMatchObject({ ok: false });
    expect(parseKeyInput({ name: "a", dailyLimit: "abc", models: [] })).toMatchObject({ ok: false });
    expect(parseKeyInput({ name: "a", dailyLimit: "0", models: [] })).toMatchObject({ ok: false });
    expect(parseKeyInput({ name: "a", dailyLimit: "", models: ["gpt-5"] })).toMatchObject({ ok: false });
    expect(parseKeyInput({ name: "a", dailyLimit: "2.5", models: ["claude-opus-5-5"] })).toEqual({
      ok: true,
      name: "a",
      dailyLimitUcr: 2_500_000n,
      allowedModels: ["claude-opus-5-5"],
    });
    // All selected = unrestricted, so models added later work too.
    expect(
      parseKeyInput({
        name: "a",
        dailyLimit: "",
        models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
      }),
    ).toMatchObject({ ok: true, allowedModels: null });
  });

  it("creates a key shown once; only the hash and last 4 are stored", async () => {
    const r = await createKey(db, A, "mainnet", { name: "laptop", dailyLimit: "5", models: [] });
    if (!r.ok) throw new Error(r.error);
    expect(isApiKeyFormat(r.apiKey)).toBe(true);
    expect(r.apiKey.startsWith("usp_live_")).toBe(true);
    const [row] = await db.select().from(apiKeys);
    expect(Buffer.from(row!.keyHash).equals(Buffer.from(await sha256(r.apiKey)))).toBe(true);
    expect(row!.last4).toBe(r.apiKey.slice(-4));
    expect(Object.values(row!).some((v) => typeof v === "string" && v.includes(r.apiKey.slice(9, 30)))).toBe(
      false,
    );
    const keys = await listKeys(db, A, "mainnet");
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ name: "laptop", dailyLimitUcr: 5_000_000n, status: "active" });
    expect(await listKeys(db, B, "mainnet")).toHaveLength(0);
    expect(await listKeys(db, A, "localnet")).toHaveLength(0);
  });

  it("revokes only the owner's own active key", async () => {
    const [k] = await listKeys(db, A, "mainnet");
    expect(await revokeKey(db, B, "mainnet", k!.id)).toBe(false);
    expect(await revokeKey(db, A, "mainnet", k!.id)).toBe(true);
    expect(await revokeKey(db, A, "mainnet", k!.id)).toBe(false);
    expect((await listKeys(db, A, "mainnet"))[0]!.status).toBe("revoked");
  });

  it("caps active keys per wallet", async () => {
    for (let i = 0; i < MAX_ACTIVE_KEYS; i++) {
      const r = await createKey(db, B, "mainnet", { name: `k${i}`, dailyLimit: "", models: [] });
      expect(r.ok).toBe(true);
    }
    const r = await createKey(db, B, "mainnet", { name: "one more", dailyLimit: "", models: [] });
    expect(r).toMatchObject({ ok: false });
  });
});

describe("usage", () => {
  let keyId: string;
  const now = new Date("2026-10-09T12:00:00Z");

  beforeAll(async () => {
    const r = await createKey(db, A, "mainnet", { name: "usage", dailyLimit: "", models: [] });
    if (!r.ok) throw new Error(r.error);
    keyId = r.id;
    const base = {
      apiKeyId: keyId,
      wallet: A,
      network: "mainnet" as const,
      provider: "anthropic",
      endpoint: "/v1/messages",
      reservedUcr: 100_000n,
      prices: {},
    };
    const rows = [
      { day: "2026-10-09T10:00:00Z", model: "claude-opus-5-5", status: "settled", charged: 71_300n },
      { day: "2026-10-09T11:00:00Z", model: "claude-sonnet-5-5", status: "completed", charged: 10_350n },
      { day: "2026-10-08T11:00:00Z", model: "claude-opus-5-5", status: "settled", charged: 1_000n },
      { day: "2026-10-08T12:00:00Z", model: "claude-opus-5-5", status: "released", charged: 0n },
      { day: "2026-09-01T12:00:00Z", model: "claude-opus-5-5", status: "settled", charged: 9_999n },
      { day: "2026-10-09T11:30:00Z", model: "claude-opus-5-5", status: "dispatched", charged: null },
    ] as const;
    for (const [i, r] of rows.entries())
      await db.insert(requests).values({
        ...base,
        requestId: new Uint8Array(32).fill(i + 1),
        model: r.model,
        status: r.status,
        chargedUcr: r.charged,
        inputTokens: 2000,
        outputTokens: 500,
        createdAt: new Date(r.day),
        ccSessionId: i === 0 ? 'sess,"quoted"' : null,
        reserveSig: `res${i}`,
      });
    // Another wallet's request never shows up.
    await db.insert(requests).values({
      ...base,
      wallet: B,
      requestId: new Uint8Array(32).fill(99),
      model: "claude-opus-5-5",
      status: "settled",
      chargedUcr: 5n,
    });
  });

  it("aggregates 30-day spend by day and model (settled + settling only)", async () => {
    const s = await spendByDay(db, A, "mainnet", 30, now);
    expect(s).toEqual([
      { day: "2026-10-08", model: "claude-opus-5-5", ucr: 1_000n },
      { day: "2026-10-09", model: "claude-opus-5-5", ucr: 71_300n },
      { day: "2026-10-09", model: "claude-sonnet-5-5", ucr: 10_350n },
    ]);
  });

  it("lists rows newest first, filters, pages by cursor", async () => {
    const all = await usageRows(db, A, "mainnet", {});
    expect(all).toHaveLength(6);
    expect(all[0]!.status).toBe("dispatched");
    expect(all.every((r) => r.keyName === "usage")).toBe(true);
    const opus = await usageRows(db, A, "mainnet", { model: "claude-opus-5-5" });
    expect(opus).toHaveLength(5);
    const day = await usageRows(db, A, "mainnet", parseUsageFilter({ from: "2026-10-08", to: "2026-10-08" }));
    expect(day).toHaveLength(2);
    const p1 = await usageRows(db, A, "mainnet", {}, { limit: 4 });
    const last = p1.at(-1)!;
    const cursor = parseCursor(`${last.createdAt.getTime()}_${last.id}`);
    const p2 = await usageRows(db, A, "mainnet", {}, { limit: 4, before: cursor });
    expect([...p1, ...p2].map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(parseUsageFilter({ key: "'; drop table", model: "x y", from: "yesterday" })).toEqual({});
  });

  it("exports CSV with escaping and exact credit amounts", async () => {
    const rows = await usageRows(db, A, "mainnet", {});
    const line = toCsvLine(rows.find((r) => r.chargedUcr === 71_300n)!);
    expect(CSV_HEADER).toHaveLength(line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).length);
    expect(line).toContain("0.0713");
    expect(line).toContain('"sess,""quoted"""');
    expect(line).toContain("settled");
  });
});
