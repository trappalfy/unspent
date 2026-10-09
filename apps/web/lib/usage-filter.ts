import type { UsageFilter } from "./usage";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/;

/** Filters from the URL (?key=&model=&from=YYYY-MM-DD&to=YYYY-MM-DD); `to` is inclusive. */
export function parseUsageFilter(q: Record<string, string | string[] | undefined>): UsageFilter {
  const one = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : undefined);
  const f: UsageFilter = {};
  const key = one("key");
  if (key && UUID_RE.test(key)) f.keyId = key;
  const model = one("model");
  if (model && /^[\w.-]{1,64}$/.test(model)) f.model = model;
  const from = one("from");
  if (from && DAY_RE.test(from)) f.from = new Date(`${from}T00:00:00Z`);
  const to = one("to");
  if (to && DAY_RE.test(to)) f.to = new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000);
  return f;
}

export function parseCursor(v: string | undefined): { createdAt: Date; id: string } | undefined {
  if (!v) return undefined;
  const [t, id] = v.split("_");
  const d = new Date(Number(t));
  return id && UUID_RE.test(id) && !Number.isNaN(d.getTime()) ? { createdAt: d, id } : undefined;
}
