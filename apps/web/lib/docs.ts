// Docs pages (brief 11.7) in reading order. Content: content/docs/<slug>.mdx.

export type DocPage = { slug: string; title: string; description: string };
export type DocGroup = { title: string; pages: DocPage[] };

export const DOC_GROUPS: DocGroup[] = [
  {
    title: "Get started",
    pages: [
      {
        slug: "quickstart",
        title: "Quickstart",
        description: "Buy credits, deposit them, create a key and send your first request.",
      },
      {
        slug: "authentication",
        title: "Authentication",
        description: "API keys, the wallet they belong to, and how to send them.",
      },
    ],
  },
  {
    title: "API",
    pages: [
      {
        slug: "messages",
        title: "Messages API",
        description: "POST /v1/messages in the Anthropic format: streaming, tools, caching, thinking.",
      },
      {
        slug: "chat-completions",
        title: "Chat Completions",
        description: "POST /v1/chat/completions in the OpenAI format: what is supported and what is ignored.",
      },
      {
        slug: "models",
        title: "Models & pricing",
        description: "Model list, prices per 1M tokens, how a request is priced and what it holds.",
      },
      {
        slug: "claude-code",
        title: "Claude Code",
        description: "Run Claude Code on Unspent credits with two environment variables.",
      },
      {
        slug: "errors",
        title: "Errors",
        description: "Every error the API returns, and whether you were charged.",
      },
      {
        slug: "rate-limits",
        title: "Rate limits",
        description: "Requests per minute, concurrency, key limits and per-request caps.",
      },
    ],
  },
  {
    title: "Credits",
    pages: [
      {
        slug: "credits",
        title: "Credits & balance",
        description: "Buying, depositing, withdrawing, holds and their expiry, redemption after a shutdown.",
      },
      {
        slug: "onchain",
        title: "Onchain",
        description: "Addresses, instructions and events, and how to check the reserve and any request.",
      },
      {
        slug: "privacy",
        title: "Privacy",
        description: "What is kept for billing, what is never stored, and what is public onchain.",
      },
    ],
  },
];

export const DOCS: DocPage[] = DOC_GROUPS.flatMap((g) => g.pages);

export function findDoc(slug: string): DocPage | undefined {
  return DOCS.find((d) => d.slug === slug);
}
