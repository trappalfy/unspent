import { publicEnv } from "@/lib/env";
import { legal } from "@/lib/legal";

// Owner-provided values in the Terms and Privacy MDX; a visible [placeholder] until set.

export function LegalEntity() {
  return <>{legal.entity || "[legal entity]"}</>;
}

export function ContactEmail() {
  return legal.email ? <a href={`mailto:${legal.email}`}>{legal.email}</a> : <>[contact email]</>;
}

export function GoverningLaw() {
  return <>{legal.law || "[governing law]"}</>;
}

export function SiteUrl() {
  return <a href={publicEnv.siteUrl}>{publicEnv.siteUrl.replace(/^https?:\/\//, "")}</a>;
}
