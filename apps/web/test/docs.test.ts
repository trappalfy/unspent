// Docs stay in step with the code they describe (brief 11.7) and with the copy rules (brief 12).

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IGNORED_FIELDS } from "../../../services/gateway/src/openai/translate";
import { DOCS } from "../lib/docs";

const ROOT = new URL("../", import.meta.url);
const GATEWAY = new URL("../../services/gateway/src/", ROOT);
const read = (rel: string) => readFileSync(new URL(rel, ROOT), "utf8");
const doc = (slug: string) => read(`content/docs/${slug}.mdx`);

describe("docs", () => {
  it("has a content file for every page and a page for every content file", () => {
    const files = readdirSync(new URL("content/docs/", ROOT)).map((f) => f.replace(/\.mdx$/, ""));
    expect(files.sort()).toEqual(DOCS.map((d) => d.slug).sort());
    const route = read("app/docs/[slug]/page.tsx");
    for (const d of DOCS) expect(route).toContain(`@/content/docs/${d.slug}.mdx`);
  });

  it("lists every field the OpenAI translation ignores", () => {
    const page = doc("chat-completions");
    for (const f of IGNORED_FIELDS) expect(page).toContain(`\`${f}\``);
  });

  it("lists every gateway error code", () => {
    const sources = readdirSync(GATEWAY, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(new URL(f, GATEWAY), "utf8"))
      .join("\n");
    const codes = new Set(
      [...sources.matchAll(/gwErr\(\s*\d+,\s*"[a-z_]+",\s*"([a-z_]+)"/g)].map((m) => m[1]!),
    );
    codes.delete("client_closed"); // the client is gone and never sees it
    expect(codes.size).toBeGreaterThan(10);
    const page = doc("errors");
    for (const c of codes) expect(page, c).toContain(`\`${c}\``);
  });

  it("uses none of the words the brief rules out", () => {
    const banned =
      /\b(audited|guaranteed?|yield|apy|investment|official|partner(ship)?|trustless|staking|cashback)\b/i;
    for (const d of DOCS) expect(doc(d.slug), d.slug).not.toMatch(banned);
    expect(read("app/page.tsx")).not.toMatch(banned);
  });
});
