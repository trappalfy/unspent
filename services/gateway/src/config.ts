import { MARKUP_BPS, parseNetwork } from "@unspent/shared";

export type GatewayConfig = {
  port: number;
  network: ReturnType<typeof parseNetwork>;
  markupBps: number;
  providerMode: "mock" | "live";
  openrouterEnabled: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const providerMode = env.PROVIDER_MODE ?? "mock";
  if (providerMode !== "mock" && providerMode !== "live") throw new Error(`PROVIDER_MODE: ${providerMode}`);
  return {
    port: Number(env.GATEWAY_PORT ?? 8787),
    network: parseNetwork(env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet"),
    markupBps: Number(env.MARKUP_BPS ?? MARKUP_BPS),
    providerMode,
    openrouterEnabled: env.OPENROUTER_ENABLED === "true",
  };
}
