import "server-only";

// Best-effort per-IP limiter for the public proxies (in-memory, per server instance).
const buckets = new Map<string, { count: number; reset: number }>();

export function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.reset) {
    if (buckets.size > 10_000) buckets.clear();
    buckets.set(key, { count: 1, reset: now + windowMs });
    return false;
  }
  b.count++;
  return b.count > max;
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}
