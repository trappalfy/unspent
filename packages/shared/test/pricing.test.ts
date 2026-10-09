import { describe, expect, it } from "vitest";
import {
  applyMarkup,
  CLAUDE_MODELS,
  chargeUcr,
  costPusd,
  creditsPerMillion,
  estimateInputTokens,
  estimateOutputTokens,
  findModel,
  type ModelEntry,
  reservationUcr,
  reserveTierFor,
  settleAmount,
  tierFor,
  type Usage,
} from "../src";

const model = (id: string): ModelEntry => findModel(id)!;
const opus = model("claude-opus-5-5");
const sonnet = model("claude-sonnet-5-5");
const haiku = model("claude-haiku-5-5");
const usage = (u: Partial<Usage>): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  ...u,
});

describe("brief 5.5 examples", () => {
  it("example 1: Sonnet 5.5, 2 000 in / 500 out = 10 350 μcr", () => {
    const u = usage({ inputTokens: 2_000, outputTokens: 500 });
    expect(costPusd(sonnet, u)).toBe(9_000_000_000n);
    expect(chargeUcr(sonnet, u)).toBe(10_350n);
  });

  it("example 2: Opus 5.5 Claude Code turn = 0.0713 credits", () => {
    const u = usage({
      inputTokens: 3_000,
      cacheReadInputTokens: 80_000,
      cacheCreationInputTokens: 2_000,
      cacheCreation5mInputTokens: 2_000,
      outputTokens: 1_200,
    });
    expect(costPusd(opus, u)).toBe(62_000_000_000n);
    expect(chargeUcr(opus, u)).toBe(71_300n);
  });
});

describe("price list (brief 5.2 table, credits per 1M)", () => {
  const rows: Record<string, string[][]> = {
    "claude-opus-5-5": [["4.60", "23.00", "5.75", "9.20", "0.23"]],
    "claude-sonnet-5-5": [["2.30", "11.50", "2.875", "4.60", "0.115"]],
    "claude-haiku-5-5": [
      ["0.115", "0.575", "0.14375", "0.23", "0.0115"],
      ["0.575", "2.875", "0.71875", "1.15", "0.0575"],
    ],
    "claude-fable-5-1": [["11.50", "57.50", "14.375", "23.00", "0.2875"]],
  };
  for (const m of CLAUDE_MODELS) {
    it(m.id, () => {
      const got = m.tiers.map(({ prices: p }) =>
        [p.input, p.output, p.cacheWrite5m, p.cacheWrite1h, p.cacheRead].map((x) => creditsPerMillion(x)),
      );
      expect(got).toEqual(rows[m.id]);
    });
  }
});

describe("Haiku 5.5 tiers", () => {
  it("prompt of exactly 100 000 stays in the first tier; 100 001 moves the whole request", () => {
    expect(tierFor(haiku, 100_000).maxPromptTokens).toBe(100_000);
    expect(tierFor(haiku, 100_001).maxPromptTokens).toBeNull();
    const at = usage({ inputTokens: 99_000, cacheReadInputTokens: 1_000, outputTokens: 10 });
    const over = usage({
      inputTokens: 99_000,
      cacheReadInputTokens: 1_000,
      cacheCreationInputTokens: 1,
      outputTokens: 10,
    });
    // 99 000 × 100 000 + 1 000 × 10 000 + 10 × 500 000
    expect(costPusd(haiku, at)).toBe(9_915_000_000n);
    // second tier for every token type
    expect(costPusd(haiku, over)).toBe(
      99_000n * 500_000n + 1_000n * 50_000n + 1n * 625_000n + 10n * 2_500_000n,
    );
  });

  it("reservation switches to the >100k tier above a 70 000 estimate", () => {
    expect(reserveTierFor(haiku, 70_000).maxPromptTokens).toBe(100_000);
    expect(reserveTierFor(haiku, 70_001).maxPromptTokens).toBeNull();
  });
});

describe("rounding and minimum charge", () => {
  it("rounds up to 1 μcr", () => {
    expect(applyMarkup(1n)).toBe(1n);
    expect(applyMarkup(0n)).toBe(0n);
    expect(applyMarkup(1_000_000n, 0)).toBe(1n);
    expect(applyMarkup(1_000_001n, 0)).toBe(2n);
  });

  it("charges at least MIN_CHARGE (0.001 credit)", () => {
    expect(chargeUcr(haiku, usage({ inputTokens: 1 }))).toBe(1_000n);
    expect(chargeUcr(haiku, usage({}), { minChargeUcr: 0n })).toBe(0n);
  });

  it("never settles above the reservation", () => {
    expect(settleAmount(5_000n, 4_000n)).toBe(4_000n);
    expect(settleAmount(3_000n, 4_000n)).toBe(3_000n);
  });
});

describe("cache writes and web search", () => {
  it("prices 1h writes at the 1h rate and any unbroken remainder at 5m", () => {
    const u = usage({ cacheCreationInputTokens: 300, cacheCreation1hInputTokens: 100 });
    expect(costPusd(sonnet, u)).toBe(200n * 2_500_000n + 100n * 4_000_000n);
  });

  it("rejects a breakdown larger than the total", () => {
    expect(() =>
      costPusd(sonnet, usage({ cacheCreationInputTokens: 1, cacheCreation5mInputTokens: 2 })),
    ).toThrow();
  });

  it("charges $0.01 per search", () => {
    expect(costPusd(sonnet, usage({ webSearchRequests: 3 }))).toBe(30_000_000_000n);
  });
});

describe("reservation", () => {
  it("input at the cache-write rate when cache_control is present", () => {
    const base = { inputTokens: 1_000, maxTokens: 100 };
    const none = reservationUcr(sonnet, { ...base, cacheWrite: "none" });
    const w5m = reservationUcr(sonnet, { ...base, cacheWrite: "5m" });
    const w1h = reservationUcr(sonnet, { ...base, cacheWrite: "1h" });
    expect(none).toBe(applyMarkup(1_000n * 2_000_000n + 100n * 10_000_000n));
    expect(w5m).toBe(applyMarkup(1_000n * 2_500_000n + 100n * 10_000_000n));
    expect(w1h).toBe(applyMarkup(1_000n * 4_000_000n + 100n * 10_000_000n));
  });

  it("holds 5 searches by default and max_uses when set", () => {
    const r = { inputTokens: 0, maxTokens: 0, cacheWrite: "none" as const };
    const perSearch = 10_000_000_000n + 20_000n * 4_000_000n; // search + 20k tokens at the top input rate (1h write)
    expect(reservationUcr(sonnet, { ...r, webSearch: {} })).toBe(applyMarkup(5n * perSearch));
    expect(reservationUcr(sonnet, { ...r, webSearch: { maxUses: 2 } })).toBe(applyMarkup(2n * perSearch));
  });

  it("estimates input as ceil(bytes / 3), capped by the context window", () => {
    expect(estimateInputTokens(10, 1_000_000)).toBe(4);
    expect(estimateInputTokens(9_000_000, 1_000_000)).toBe(1_000_000);
  });

  it("estimates cut output as ceil(chars / 3.5)", () => {
    expect(estimateOutputTokens(7)).toBe(2);
    expect(estimateOutputTokens(8)).toBe(3);
  });
});

// Property test (brief 13): the reservation is never below the actual cost when usage stays within the request's bounds.
describe("reservation ≥ actual cost", () => {
  let seed = 42;
  const rnd = (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed % (n + 1);
  };
  for (const m of CLAUDE_MODELS) {
    it(m.id, () => {
      for (let i = 0; i < 2_000; i++) {
        const input = rnd(300_000);
        const maxTokens = 1 + rnd(128_000);
        const ttl = (["none", "5m", "1h"] as const)[rnd(2)]!;
        const searchCap = rnd(3) === 0 ? rnd(8) : undefined;
        // actual usage: the prompt splits into uncached / cache read / cache write within the estimated input
        const read = rnd(input);
        const write = ttl === "none" ? 0 : rnd(input - read);
        const searches = searchCap === undefined ? 0 : rnd(searchCap);
        const u = usage({
          inputTokens: input - read - write,
          cacheReadInputTokens: read,
          cacheCreationInputTokens: write + searches * 20_000,
          cacheCreation1hInputTokens: ttl === "1h" ? write : 0,
          outputTokens: rnd(maxTokens),
          webSearchRequests: searches,
        });
        const reserved = reservationUcr(m, {
          inputTokens: input,
          maxTokens,
          cacheWrite: ttl,
          ...(searchCap === undefined ? {} : { webSearch: { maxUses: searchCap } }),
        });
        expect(chargeUcr(m, u)).toBeLessThanOrEqual(reserved);
      }
    });
  }
});
