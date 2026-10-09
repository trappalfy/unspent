import { describe, expect, it } from "vitest";
import { ceilDiv, creditsToUcr, formatCredits, ucrToCredits } from "../src";

describe("units", () => {
  it("parses credit amounts exactly", () => {
    expect(creditsToUcr("1")).toBe(1_000_000n);
    expect(creditsToUcr("0.000001")).toBe(1n);
    expect(creditsToUcr("12.5")).toBe(12_500_000n);
    for (const bad of ["", "-1", "1.0000001", "1e3", "abc", "1."]) {
      if (bad === "1.") expect(creditsToUcr(bad)).toBe(1_000_000n);
      else expect(() => creditsToUcr(bad)).toThrow();
    }
  });

  it("prints exact credits", () => {
    expect(ucrToCredits(10_350n)).toBe("0.01035");
    expect(ucrToCredits(71_300n)).toBe("0.0713");
    expect(ucrToCredits(5_000_000n)).toBe("5");
  });

  it("formats for display: balances floor, costs may ceil", () => {
    expect(formatCredits(999_999n, 2)).toBe("0.99");
    expect(formatCredits(10_350n, 4, "ceil")).toBe("0.0104");
    expect(formatCredits(1_234_567_000_000n, 2)).toBe("1,234,567.00");
  });

  it("ceilDiv", () => {
    expect(ceilDiv(0n, 3n)).toBe(0n);
    expect(ceilDiv(7n, 3n)).toBe(3n);
    expect(() => ceilDiv(1n, 0n)).toThrow();
  });
});
