// Regional check (Q13): requests from a known country where Anthropic's services aren't available get 403. Country by
// IP from DB-IP's free IP-to-country database (CC BY 4.0, https://db-ip.com), fetched into the image at build time
// (scripts/fetch-geoip.mjs). Without GEOIP_DB_PATH (local development) the check is off.

import { readFileSync } from "node:fs";
import { type CountryResponse, Reader } from "mmdb-lib";

export type CountryLookup = (ip: string) => string | null;

/** Loads the database; a configured path that can't be read stops the gateway rather than silently serving everyone. */
export function loadGeo(path: string): CountryLookup | null {
  if (!path) return null;
  const reader = new Reader<CountryResponse>(readFileSync(path));
  return (ip) => {
    try {
      return reader.get(ip)?.country?.iso_code ?? null;
    } catch {
      return null;
    }
  };
}

/** The client's address as Fly.io's proxy reports it; elsewhere the first X-Forwarded-For hop. */
export function clientIp(headers: Headers): string | null {
  const fly = headers.get("fly-client-ip");
  if (fly) return fly.trim();
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}
