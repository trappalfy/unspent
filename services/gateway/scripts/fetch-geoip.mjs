// Fetches DB-IP's free IP-to-country database (CC BY 4.0, https://db-ip.com) for the gateway's regional check.
// Run at image build time: node services/gateway/scripts/fetch-geoip.mjs /app/geo/country.mmdb
// A month's file appears in its first days, so the previous month is the fallback.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";

const out = process.argv[2] ?? "geo/country.mmdb";
const now = new Date();
for (const back of [0, 1]) {
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
    .toISOString()
    .slice(0, 7);
  const res = await fetch(`https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz`);
  if (!res.ok) continue;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, gunzipSync(Buffer.from(await res.arrayBuffer())));
  console.log(`DB-IP country lite ${month} → ${out}`);
  process.exit(0);
}
console.error("Could not download the DB-IP country database");
process.exit(1);
