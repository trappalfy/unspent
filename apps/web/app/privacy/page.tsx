import type { Metadata } from "next";
import Content from "@/content/legal/privacy.mdx";
import { publicEnv } from "@/lib/env";
import { assertLegalComplete, LEGAL_UPDATED } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What data Unspent processes, why, and for how long.",
};

export default function Page() {
  assertLegalComplete(publicEnv.prelaunch);
  return (
    <article className="docs mx-auto w-full max-w-[800px] px-4 py-16 md:px-8">
      <h1>Privacy Policy</h1>
      <p className="docs-lead">Last updated: {LEGAL_UPDATED}</p>
      <Content />
    </article>
  );
}
