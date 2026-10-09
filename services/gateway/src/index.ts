import { serve } from "@hono/node-server";
import { openPostgres } from "@unspent/db";
import { createApp } from "./app";
import { SolanaChain } from "./chain";
import { loadConfig } from "./config";
import { loadGeo } from "./geo";
import { createLogger } from "./log";
import { MemoryRateLimiter } from "./ratelimit";
import { Reconciler } from "./reconcile";
import { SettleWorker } from "./settle";
import { AnthropicUpstream } from "./upstream";

const config = loadConfig();
const log = createLogger({ webhookUrl: config.alertWebhookUrl });
const { db } = await openPostgres(config.databaseUrl);
const chain = await SolanaChain.create(
  config.rpcUrl,
  config.gatewayKeypairPath,
  config.maxPriorityFeeMicroLamports,
);
const upstream = new AnthropicUpstream(config.anthropicBaseUrl, config.anthropicKeys, log);
const geo = loadGeo(config.geoipDbPath);
if (!geo) log.warn("regional check off: GEOIP_DB_PATH is not set");
const deps = { config, db, chain, upstream, limiter: new MemoryRateLimiter(), log, geo };

const settle = new SettleWorker(db, chain, log, config.settleFlushMs);
settle.start();
// Runs once at startup too: recovers requests left open by a previous process.
new Reconciler(db, chain, log, {
  intervalMs: config.reconcileIntervalMs,
  staleAfterMs: config.staleAfterMs,
}).start();

serve({ fetch: createApp(deps).fetch, port: config.port }, (info) => {
  log.info("gateway listening", {
    port: info.port,
    network: config.network,
    provider: config.providerMode,
    gateway: chain.gatewayAddress,
  });
});
