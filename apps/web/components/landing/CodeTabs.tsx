"use client";

import { useState } from "react";
import { CopyButton } from "@/components/CopyButton";

// Code samples (brief 11.5). Anthropic format for curl, Python and Claude Code; the OpenAI SDK for TypeScript.

export function CodeTabs({ apiBase }: { apiBase: string }) {
  const tabs: [string, string][] = [
    [
      "curl",
      `curl ${apiBase}/v1/messages \\
  -H "x-api-key: $UNSPENT_API_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{"model":"claude-sonnet-5-5","max_tokens":512,
       "messages":[{"role":"user","content":"Hello"}]}'`,
    ],
    [
      "Python",
      `from anthropic import Anthropic
client = Anthropic(base_url="${apiBase}", api_key=UNSPENT_API_KEY)`,
    ],
    [
      "TypeScript",
      `import OpenAI from "openai";
const client = new OpenAI({ baseURL: "${apiBase}/v1", apiKey: process.env.UNSPENT_API_KEY });`,
    ],
    [
      "Claude Code",
      `export ANTHROPIC_BASE_URL=${apiBase}
export ANTHROPIC_AUTH_TOKEN=$UNSPENT_API_KEY
claude`,
    ],
  ];
  const [active, setActive] = useState(0);
  const code = tabs[active]![1];
  return (
    <div className="border border-line">
      <div className="flex items-center border-b border-line">
        <div role="tablist" aria-label="Code samples" className="flex min-w-0 flex-1 overflow-x-auto">
          {tabs.map(([name], i) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`code-tab-${i}`}
              aria-selected={i === active}
              aria-controls="code-panel"
              className={`whitespace-nowrap px-4 py-3 text-sm ${i === active ? "bg-fg text-bg" : "text-mute hover:text-fg"}`}
              onClick={() => setActive(i)}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="shrink-0 px-2">
          <CopyButton value={code} />
        </div>
      </div>
      <div role="tabpanel" id="code-panel" aria-labelledby={`code-tab-${active}`}>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: long lines scroll; the scroll needs keyboard access */}
        <pre tabIndex={0} className="overflow-x-auto p-4 text-xs leading-relaxed md:p-6 md:text-sm">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}
