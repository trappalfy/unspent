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
export async function openPostgres(
  url: string,
  opts: { max?: number; migrate?: boolean } = {},
): Promise<{ db: Db; close: () => Promise<void> }> {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const postgres = (await import("postgres")).default;
  const client = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  if (opts.migrate !== false) await migrate(db, { migrationsFolder: migrationsFolder() });
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
