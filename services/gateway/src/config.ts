import { MARKUP_BPS, type Network, parseNetwork } from "@unspent/shared";

export type GatewayConfig = {
  port: number;
  network: Network;
  markupBps: number;
  providerMode: "mock" | "live";
  openrouterEnabled: boolean;
  anthropicBaseUrl: string;
  anthropicKeys: string[];
  databaseUrl: string;
  rpcUrl: string;
  gatewayKeypairPath: string;
  siteUrl: string;
  /** Reserve confirmation timeout (brief 5.5 step 3). */
  reserveTimeoutMs: number;
  /** Background reconciliation period and staleness threshold (brief 8.12). */
  reconcileIntervalMs: number;
  staleAfterMs: number;
  /** settle_many batch flush period. */
  settleFlushMs: number;
  progressIntervalMs: number;
  maxPriorityFeeMicroLamports: bigint;
  alertWebhookUrl: string | null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const providerMode = env.PROVIDER_MODE ?? "mock";
  if (providerMode !== "mock" && providerMode !== "live") throw new Error(`PROVIDER_MODE: ${providerMode}`);
  const anthropicBaseUrl =
    env.ANTHROPIC_BASE_URL ??
    (providerMode === "live" ? "https://api.anthropic.com" : "http://127.0.0.1:8788");
  if (providerMode === "mock" && anthropicBaseUrl.includes("anthropic.com")) {
    throw new Error("PROVIDER_MODE=mock must not point at the real Anthropic API (brief rule 0.3)");
  }
  return {
    port: Number(env.GATEWAY_PORT ?? 8787),
    network: parseNetwork(env.NEXT_PUBLIC_SOLANA_NETWORK ?? "mainnet"),
    markupBps: Number(env.MARKUP_BPS ?? MARKUP_BPS),
    providerMode,
    openrouterEnabled: env.OPENROUTER_ENABLED === "true",
    anthropicBaseUrl,
    anthropicKeys: (env.ANTHROPIC_API_KEYS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    databaseUrl: env.DATABASE_URL ?? "",
    rpcUrl: env.RPC_URL ?? "http://127.0.0.1:8899",
    // GATEWAY_KEYPAIR holds the key itself (JSON array, as a secret); GATEWAY_KEYPAIR_PATH points to a file.
    gatewayKeypairPath: env.GATEWAY_KEYPAIR || env.GATEWAY_KEYPAIR_PATH || "",
    siteUrl: env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
    reserveTimeoutMs: Number(env.RESERVE_TIMEOUT_MS ?? 20_000),
    reconcileIntervalMs: Number(env.RECONCILE_INTERVAL_MS ?? 120_000),
    staleAfterMs: Number(env.STALE_AFTER_MS ?? 120_000),
    settleFlushMs: Number(env.SETTLE_FLUSH_MS ?? 2_000),
    progressIntervalMs: Number(env.PROGRESS_INTERVAL_MS ?? 30_000),
    maxPriorityFeeMicroLamports: BigInt(env.MAX_PRIORITY_FEE_MICROLAMPORTS ?? 200_000),
    alertWebhookUrl: env.ALERT_WEBHOOK_URL || null,
  };
}
