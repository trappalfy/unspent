// Local Postgres for development without Docker: real Postgres binaries from `embedded-postgres`, data on disk, so the
// web app, gateway and indexer share one database with production semantics (row locks, prepared statements).
//
//   pnpm --filter @unspent/db devdb        # postgres://postgres:postgres@127.0.0.1:5432/unspent

import { existsSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";
import { openPostgres } from "../src/index";

const dir = process.env.DEVDB_DIR ?? new URL("../../../.data/postgres", import.meta.url).pathname;
const port = Number(process.env.DEVDB_PORT ?? 5432);
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  port,
  user: "postgres",
  password: "postgres",
  persistent: true,
  onLog: () => {},
});
if (!existsSync(`${dir}/PG_VERSION`)) await pg.initialise();
await pg.start();
await pg.createDatabase("unspent").catch(() => {});
const url = `postgres://postgres:postgres@127.0.0.1:${port}/unspent`;
const { close } = await openPostgres(url, { max: 1 });
await close();
console.log(`devdb: ${url} (data: ${dir})`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
