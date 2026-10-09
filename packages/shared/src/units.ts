// Units (brief 5.1). All amounts are bigint:
//   μcr  — micro-credit, the credit's base unit (decimals 6). 1 μcr = 1 USDC base unit = $0.000001.
//   pUSD — pico-dollar, used for provider prices and pre-rounding costs. 1 μcr = 10^6 pUSD.

export const CREDIT_DECIMALS = 6;
export const UCR_PER_CREDIT = 1_000_000n;
export const PUSD_PER_UCR = 1_000_000n;
export const BPS_DENOMINATOR = 10_000n;

/** ceil(a / b) for a ≥ 0, b > 0. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError("ceilDiv: divisor must be positive");
  if (a < 0n) throw new RangeError("ceilDiv: dividend must be non-negative");
  return (a + b - 1n) / b;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

const DECIMAL_RE = /^(\d+)(?:\.(\d{0,6}))?$/;

/** Parses a decimal credit amount ("12", "0.5", "1.000001") into μcr. Throws on invalid input or >6 decimals. */
export function creditsToUcr(input: string): bigint {
  const m = DECIMAL_RE.exec(input.trim());
  if (!m) throw new RangeError(`Invalid credit amount: ${input}`);
  const whole = BigInt(m[1]!);
  const frac = (m[2] ?? "").padEnd(CREDIT_DECIMALS, "0");
  return whole * UCR_PER_CREDIT + BigInt(frac);
}

/** Exact decimal string of a μcr amount, trailing zeros trimmed: 10350n → "0.01035". */
export function ucrToCredits(ucr: bigint): string {
  const neg = ucr < 0n;
  const abs = neg ? -ucr : ucr;
  const whole = abs / UCR_PER_CREDIT;
  const frac = (abs % UCR_PER_CREDIT).toString().padStart(CREDIT_DECIMALS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export type Rounding = "floor" | "ceil";

/**
 * Display formatting (brief 10.2): 4 digits in tables, 2 in large figures; the exact value goes to a tooltip.
 * Balances round down so the UI never shows more than is available; costs may round up.
 */
export function formatCredits(ucr: bigint, digits: 2 | 4, rounding: Rounding = "floor"): string {
  if (ucr < 0n) return `-${formatCredits(-ucr, digits, rounding === "floor" ? "ceil" : "floor")}`;
  const step = 10n ** BigInt(CREDIT_DECIMALS - digits);
  const units = rounding === "floor" ? ucr / step : ceilDiv(ucr, step);
  const scale = 10n ** BigInt(digits);
  const whole = (units / scale).toLocaleString("en-US");
  return `${whole}.${(units % scale).toString().padStart(digits, "0")}`;
}

/** Exact decimal string of n / 10^scale with at least `minDigits` fraction digits: (46_000_000_000n, 10) → "4.60". */
export function decimalString(n: bigint, scale: number, minDigits = 2): string {
  const d = 10n ** BigInt(scale);
  const whole = n / d;
  let frac = (n % d).toString().padStart(scale, "0").replace(/0+$/, "");
  if (frac.length < minDigits) frac = frac.padEnd(minDigits, "0");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
