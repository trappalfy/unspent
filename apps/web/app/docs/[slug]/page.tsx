import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ComponentType } from "react";
import { DOCS, findDoc } from "@/lib/docs";

// Docs pages are static; live numbers (program limits, addresses) refresh every 5 minutes.
export const revalidate = 300;
export const dynamicParams = false;

const CONTENT: Record<string, () => Promise<{ default: ComponentType }>> = {
  quickstart: () => import("@/content/docs/quickstart.mdx"),
  authentication: () => import("@/content/docs/authentication.mdx"),
  messages: () => import("@/content/docs/messages.mdx"),
  "chat-completions": () => import("@/content/docs/chat-completions.mdx"),
  models: () => import("@/content/docs/models.mdx"),
  "claude-code": () => import("@/content/docs/claude-code.mdx"),
  errors: () => import("@/content/docs/errors.mdx"),
  "rate-limits": () => import("@/content/docs/rate-limits.mdx"),
  credits: () => import("@/content/docs/credits.mdx"),
  onchain: () => import("@/content/docs/onchain.mdx"),
  privacy: () => import("@/content/docs/privacy.mdx"),
};

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return DOCS.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = findDoc((await params).slug);
  return doc ? { title: doc.title, description: doc.description } : {};
}

export default async function DocPage({ params }: Props) {
  const { slug } = await params;
  const doc = findDoc(slug);
  const load = CONTENT[slug];
  if (!doc || !load) notFound();
  const { default: Content } = await load();
  const i = DOCS.indexOf(doc);
  const prev = DOCS[i - 1];
  const next = DOCS[i + 1];

  return (
    <article className="docs">
      <h1>{doc.title}</h1>
      <p className="docs-lead">{doc.description}</p>
      <Content />
      <nav aria-label="Previous and next page" className="docs-pager">
        {prev ? (
          <Link href={`/docs/${prev.slug}`} rel="prev">
            <span className="text-xs text-mute">Previous</span>
            <span>← {prev.title}</span>
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link href={`/docs/${next.slug}`} rel="next" className="text-right">
            <span className="text-xs text-mute">Next</span>
            <span>{next.title} →</span>
          </Link>
        )}
      </nav>
    </article>
  );
}
