import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
serve({ fetch: createApp(config).fetch, port: config.port }, (info) => {
  console.log(`gateway listening on :${info.port} (${config.network}, provider ${config.providerMode})`);
});
