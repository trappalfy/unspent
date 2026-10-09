import { describe, expect, it } from "vitest";
import { apiKeyLast4, generateApiKey, isApiKeyFormat, sha256 } from "../src";

describe("api keys", () => {
  it("formats by network", () => {
    const live = generateApiKey("mainnet");
    expect(live).toMatch(/^usp_live_[0-9A-Za-z]{32}$/);
    expect(generateApiKey("localnet")).toMatch(/^usp_test_/);
    expect(isApiKeyFormat(live)).toBe(true);
    expect(isApiKeyFormat(`${live}x`)).toBe(false);
    expect(apiKeyLast4(live)).toBe(live.slice(-4));
  });

  it("hashes with sha256", async () => {
    const h = await sha256("abc");
    expect(Buffer.from(h).toString("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
