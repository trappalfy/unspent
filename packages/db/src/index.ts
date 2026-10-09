import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

// One drizzle-orm instance for the whole monorepo: services import operators from here.
export {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  sum,
} from "drizzle-orm";
export * from "./schema";
export { schema };

/** Works with both postgres-js (production) and PGlite (tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Source-tree path of the SQL migrations. Built from parts so bundlers don't treat it as an asset import. */
export function migrationsFolder(): string {
  const rel = ["..", "drizzle"].join("/");
  return new URL(rel, import.meta.url).pathname;
}

/** `migrate: false` for read/write clients that don't own the schema (the web app); services migrate on start. */
/** Any constant; serializes migrations when the gateway and the indexer start together. */
const MIGRATION_LOCK = 72_707_369;

/**
 * `prepare: false` behind a transaction-mode pooler (Neon's pooled URL, used by the site on serverless); services on
 * long-lived servers use the direct URL with prepared statements.
 */
export async function openPostgres(
  url: string,
  opts: { max?: number; migrate?: boolean; prepare?: boolean } = {},
): Promise<{ db: Db; close: () => Promise<void> }> {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const postgres = (await import("postgres")).default;
  const client = postgres(url, { max: opts.max ?? 10, prepare: opts.prepare ?? true, onnotice: () => {} });
  const db = drizzle(client, { schema });
  if (opts.migrate !== false) {
    // The advisory lock is per session, so it is taken and released on one reserved connection.
    const lock = await client.reserve();
    try {
      await lock`select pg_advisory_lock(${MIGRATION_LOCK})`;
      await migrate(db, { migrationsFolder: migrationsFolder() });
    } finally {
      await lock`select pg_advisory_unlock(${MIGRATION_LOCK})`.catch(() => {});
      lock.release();
    }
  }
  return { db: db as unknown as Db, close: () => client.end() };
}

/** In-process Postgres for tests (no Docker). */
export async function openPglite(): Promise<{ db: Db; close: () => Promise<void> }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrationsFolder() });
  return { db: db as unknown as Db, close: () => client.close() };
}

/**
 * Database for tests: PGlite by default. With TEST_DATABASE_URL, a fresh database on that real Postgres server (dropped
 * on close): PGlite and postgres-js differ in how they bind parameters, so CI and pre-launch runs use both.
 */
export async function openTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return openPglite();
  const postgres = (await import("postgres")).default;
  const name = `unspent_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(base, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const { db, close } = await openPostgres(url.toString(), { max: 4 });
  return {
    db,
    close: async () => {
      await close();
      await admin.unsafe(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}
