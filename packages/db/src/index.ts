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

export const MIGRATIONS_FOLDER = new URL("../drizzle", import.meta.url).pathname;

export async function openPostgres(
  url: string,
  opts: { max?: number } = {},
): Promise<{ db: Db; close: () => Promise<void> }> {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const postgres = (await import("postgres")).default;
  const client = postgres(url, { max: opts.max ?? 10 });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db: db as unknown as Db, close: () => client.end() };
}

/** In-process Postgres for tests (no Docker). */
export async function openPglite(): Promise<{ db: Db; close: () => Promise<void> }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db: db as unknown as Db, close: () => client.close() };
}
