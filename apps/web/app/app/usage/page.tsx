import { CLAUDE_MODELS } from "@unspent/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { Credits, Empty, PageTitle } from "@/components/app/ui";
import { TableWrap } from "@/components/TableWrap";
import { explorerTx, network } from "@/lib/env";
import { listKeys } from "@/lib/keys";
import { getDb } from "@/lib/server/db";
import { getSession } from "@/lib/session";
import { PAGE_SIZE, STATUS_LABEL, usageRows } from "@/lib/usage";
import { parseCursor, parseUsageFilter } from "@/lib/usage-filter";

export const metadata: Metadata = { title: "Usage" };

type SP = Promise<Record<string, string | string[] | undefined>>;

const n = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-US"));
const time = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

function TxLink({ sig, label }: { sig: string | null; label: string }) {
  return sig ? (
    <a className="underline" href={explorerTx(sig)} target="_blank" rel="noreferrer" title={sig}>
      {label}
    </a>
  ) : (
    <span className="text-mute">—</span>
  );
}

export default async function UsagePage({ searchParams }: { searchParams: SP }) {
  const session = await getSession();
  if (!session) return null;
  const q = await searchParams;
  const filter = parseUsageFilter(q);
  const db = await getDb();
  const [keys, rows] = await Promise.all([
    listKeys(db, session.address, network),
    usageRows(db, session.address, network, filter, {
      before: parseCursor(typeof q.before === "string" ? q.before : undefined),
    }),
  ]);
  const params = new URLSearchParams(
    Object.entries(q).filter((e): e is [string, string] => typeof e[1] === "string" && e[0] !== "before"),
  );
  const last = rows.at(-1);
  const next = rows.length === PAGE_SIZE && last ? `${last.createdAt.getTime()}_${last.id}` : null;
  const one = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : "");

  return (
    <>
      <PageTitle sub="Every request is reserved and settled onchain; links open both transactions. Times are UTC.">
        Usage
      </PageTitle>
      <form
        className="mb-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-[1fr_1fr_auto_auto_auto_auto]"
        method="get"
      >
        <select className="input" name="key" defaultValue={one("key")} aria-label="Key">
          <option value="">All keys</option>
          {keys.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name} …{k.last4}
            </option>
          ))}
        </select>
        <select className="input" name="model" defaultValue={one("model")} aria-label="Model">
          <option value="">All models</option>
          {CLAUDE_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
        <input className="input" type="date" name="from" defaultValue={one("from")} aria-label="From" />
        <input className="input" type="date" name="to" defaultValue={one("to")} aria-label="To" />
        <button type="submit" className="btn">
          Filter
        </button>
        <a className="btn" href={`/app/usage/export?${params}`}>
          Export CSV
        </a>
      </form>
      {rows.length === 0 ? (
        <Empty>
          {keys.length === 0 ? (
            <>
              No requests yet.{" "}
              <Link className="underline" href="/app/keys">
                Create a key
              </Link>{" "}
              and make your first call.
            </>
          ) : (
            "No requests match these filters."
          )}
        </Empty>
      ) : (
        <TableWrap label="Requests">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Key</th>
                <th>Model</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Cache read</th>
                <th className="num">Cache write</th>
                <th className="num">Searches</th>
                <th className="num">Cost</th>
                <th>Status</th>
                <th>Session</th>
                <th>Reserve</th>
                <th>Settle</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{time(r.createdAt)}</td>
                  <td className="whitespace-nowrap">
                    {r.keyName} …{r.keyLast4}
                  </td>
                  <td className="whitespace-nowrap">{r.model}</td>
                  <td className="num">{n(r.inputTokens)}</td>
                  <td className="num">{n(r.outputTokens)}</td>
                  <td className="num">{n(r.cacheReadTokens)}</td>
                  <td className="num">{n(r.cacheWriteTokens)}</td>
                  <td className="num">{n(r.webSearches)}</td>
                  <td className="num">
                    {r.chargedUcr === null ? (
                      <span className="text-mute">
                        held <Credits ucr={r.reservedUcr} digits={4} />
                      </span>
                    ) : (
                      <>
                        <Credits ucr={r.chargedUcr} digits={4} />
                        {r.estimated && (
                          <span title="Provider stream ended early; output was estimated"> *</span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="whitespace-nowrap">{STATUS_LABEL[r.status] ?? r.status}</td>
                  <td title={r.ccSessionId ?? undefined}>
                    {r.ccSessionId ? `${r.ccSessionId.slice(0, 8)}…` : "—"}
                  </td>
                  <td>
                    <TxLink sig={r.reserveSig} label="tx" />
                  </td>
                  <td>
                    <TxLink sig={r.settleSig} label="tx" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <div className="mt-4 flex gap-4 text-sm">
        {q.before && (
          <Link className="underline" href={`/app/usage?${params}`}>
            ← Newest
          </Link>
        )}
        {next && (
          <Link className="underline" href={`/app/usage?${params}&before=${next}`}>
            Older →
          </Link>
        )}
      </div>
    </>
  );
}
