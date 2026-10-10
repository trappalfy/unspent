import type { Metadata } from "next";
import Content from "@/content/legal/terms.mdx";
import { LEGAL_UPDATED } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms for using Unspent, its API and its credits.",
};

export default function Page() {
  return (
    <article className="docs mx-auto w-full max-w-[800px] px-4 py-16 md:px-8">
      <h1>Terms of Service</h1>
      <p className="docs-lead">Last updated: {LEGAL_UPDATED}</p>
      <Content />
    </article>
  );
}
