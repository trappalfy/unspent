import { formatCredits, ucrToCredits } from "@unspent/shared";

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** SOL with up to 6 decimals, rounded up (fees). */
export function formatSol(lamports: bigint): string {
  const micro = (lamports + 999n) / 1_000n;
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} SOL`;
}

/** Token amount in base units → decimal string, trimmed. */
export function formatUnits(amount: bigint, decimals: number, maxDigits = decimals): string {
  const d = 10n ** BigInt(decimals);
  const whole = amount / d;
  const frac = (amount % d).toString().padStart(decimals, "0").slice(0, maxDigits).replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

/** Parses "1.5" into base units; null when invalid or too many decimals. */
export function parseUnits(input: string, decimals: number): bigint | null {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(input.trim());
  if (!m || (!m[1] && !m[2])) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  return BigInt(m[1] || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export const credits = (ucr: bigint, digits: 2 | 4 = 2) => formatCredits(ucr, digits);
export const exactCredits = (ucr: bigint) => `${ucrToCredits(ucr)} credits`;

export function shortSig(sig: string): string {
  return `${sig.slice(0, 6)}…${sig.slice(-6)}`;
}
