import { publicEnv } from "@/lib/env";

// Links used in the Terms and Privacy MDX.

export function SiteUrl() {
  return <a href={publicEnv.siteUrl}>{publicEnv.siteUrl.replace(/^https?:\/\//, "")}</a>;
}

/** Contact goes through the project's X account. */
export function ContactLink() {
  return publicEnv.xUrl ? <a href={publicEnv.xUrl}>X</a> : <>X</>;
}
