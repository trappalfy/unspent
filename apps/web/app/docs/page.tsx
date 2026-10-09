import type { Metadata } from "next";
import Link from "next/link";
import { DOC_GROUPS } from "@/lib/docs";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "Use Unspent credits with the Anthropic and OpenAI SDKs and Claude Code, and check everything onchain.",
};

export default function DocsIndex() {
  return (
    <div className="flex max-w-[800px] flex-col gap-10">
      <div className="flex flex-col gap-3">
        <h1 className="text-xl">Docs</h1>
        <p className="font-sans text-lg text-fg/80">
          Same SDKs, one base URL. Start with the quickstart, or go straight to what you need.
        </p>
      </div>
      {DOC_GROUPS.map((g) => (
        <section key={g.title} className="flex flex-col gap-3" aria-label={g.title}>
          <h2 className="text-xs text-mute">{g.title}</h2>
          <ul className="grid grid-cols-1 gap-px border border-line bg-line sm:grid-cols-2">
            {g.pages.map((d) => (
              <li key={d.slug} className="bg-bg">
                <Link href={`/docs/${d.slug}`} className="flex h-full flex-col gap-1 p-4 hover:bg-fg/5">
                  <span className="font-medium">{d.title}</span>
                  <span className="font-sans text-sm text-fg/70">{d.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
