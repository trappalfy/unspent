import type { NextRequest } from "next/server";
import { network } from "@/lib/env";
import { getDb } from "@/lib/server/db";
import { getSession } from "@/lib/session";
import { CSV_HEADER, toCsvLine, usageRows } from "@/lib/usage";
import { parseUsageFilter } from "@/lib/usage-filter";

const MAX_ROWS = 100_000;

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return new Response("Sign in first.", { status: 401 });
  const filter = parseUsageFilter(Object.fromEntries(req.nextUrl.searchParams));
  const db = await getDb();
  const lines = [CSV_HEADER.join(",")];
  let before: { createdAt: Date; id: string } | undefined;
  for (let n = 0; n < MAX_ROWS; ) {
    const rows = await usageRows(db, session.address, network, filter, { limit: 1000, before });
    for (const r of rows) lines.push(toCsvLine(r));
    n += rows.length;
    const last = rows.at(-1);
    if (rows.length < 1000 || !last) break;
    before = { createdAt: last.createdAt, id: last.id };
  }
  return new Response(`${lines.join("\n")}\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="unspent-usage-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
