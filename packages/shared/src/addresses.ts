// Public addresses per network (brief 7). Program-derived addresses are filled in after deployment (stage 3 / 9).

export type Network = "localnet" | "devnet" | "mainnet";

export type NetworkAddresses = {
  /** Solana chain id for Wallet Standard / SIWS. */
  chain: `solana:${string}`;
  usdcMint: string | null;
  program: string | null;
  creditMint: string | null;
  config: string | null;
  reserve: string | null;
  vault: string | null;
  treasury: string | null;
};

const EMPTY = { program: null, creditMint: null, config: null, reserve: null, vault: null, treasury: null };

export const ADDRESSES: Record<Network, NetworkAddresses> = {
  // Local tests use a mock USDC mint created per test run.
  localnet: { chain: "solana:localnet", usdcMint: null, ...EMPTY },
  // Devnet runs on Unspent's own mock USDC (decimals 6); Circle devnet USDC is 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU.
  devnet: { chain: "solana:devnet", usdcMint: null, ...EMPTY },
  mainnet: { chain: "solana:mainnet", usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", ...EMPTY },
};

export function parseNetwork(value: string | undefined): Network {
  if (value === "localnet" || value === "devnet" || value === "mainnet") return value;
  throw new Error(`Unknown Solana network: ${value}`);
}
