import "server-only";
import { type Db, openPostgres } from "@unspent/db";

// One pool per server process (kept on globalThis so dev reloads don't leak connections).
const g = globalThis as unknown as { __unspentDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  g.__unspentDb ??= openPostgres(url, { max: 5, migrate: false }).then((r) => r.db);
  return g.__unspentDb;
}
