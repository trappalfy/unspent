// What the gateway lets through to the provider (brief 8.5, owner decision D2). Allowlist: anything that changes the
// price or runs something we don't meter is rejected; everything else is forwarded byte for byte.

export type FilterError = { status: 400; message: string };

const CLIENT_TOOL = /^(bash|text_editor|memory|computer|computer_toolset|browser_toolset)_\d{8}$/;
const TOOL_SEARCH = /^tool_search_tool_(regex|bm25)(_\d{8})?$/;
const WEB_SEARCH = /^web_search_\d{8}$/;

/** Shown in the provider's wording so Claude Code recognizes an unsupported tool and retries without it. */
const EXPECTED_TAGS = [
  "bash_20250124",
  "custom",
  "memory_20250818",
  "text_editor_20250124",
  "text_editor_20250429",
  "text_editor_20250728",
  "tool_search_tool_bm25",
  "tool_search_tool_bm25_20251119",
  "tool_search_tool_regex",
  "tool_search_tool_regex_20251119",
  "web_search_20250305",
  "web_search_20260209",
  "web_search_20260318",
]
  .map((t) => `'${t}'`)
  .join(", ");

export function isAllowedToolType(type: unknown): boolean {
  if (type === undefined || type === null || type === "custom") return true;
  if (typeof type !== "string") return false;
  return CLIENT_TOOL.test(type) || TOOL_SEARCH.test(type) || WEB_SEARCH.test(type);
}

export function isWebSearchTool(type: unknown): boolean {
  return typeof type === "string" && WEB_SEARCH.test(type);
}

const err = (message: string): FilterError => ({ status: 400, message });

/** Returns null when the body may be forwarded, or the invalid_request_error to return. */
export function filterMessagesBody(body: Record<string, unknown>): FilterError | null {
  if (typeof body.model !== "string") return err("model: Field required");
  if (!Number.isSafeInteger(body.max_tokens) || (body.max_tokens as number) < 1)
    return err("max_tokens: Field required");

  const tools = body.tools;
  if (tools !== undefined) {
    if (!Array.isArray(tools)) return err("tools: Input should be a valid list");
    for (const [i, t] of tools.entries()) {
      const type = (t as { type?: unknown } | null)?.type;
      if (!isAllowedToolType(type)) {
        return err(
          `tools.${i}: Input tag '${String(type)}' found using 'type' does not match any of the expected tags: ${EXPECTED_TAGS}`,
        );
      }
    }
  }

  if (body.speed !== undefined && body.speed !== "standard")
    return err("speed: fast mode is not available on Unspent.");
  if (
    body.service_tier !== undefined &&
    body.service_tier !== "auto" &&
    body.service_tier !== "standard_only"
  )
    return err("service_tier: only the standard tier is available on Unspent.");
  if (body.inference_geo !== undefined && body.inference_geo !== "global")
    return err("inference_geo: only global inference is available on Unspent.");
  for (const field of ["mcp_servers", "container", "fallbacks", "fallback_credit_token", "compaction"]) {
    if (body[field] !== undefined) return err(`${field}: not available on Unspent.`);
  }
  const edits = (body.context_management as { edits?: { type?: unknown }[] } | undefined)?.edits;
  if (
    Array.isArray(edits) &&
    edits.some((e) => typeof e?.type === "string" && e.type.startsWith("compact"))
  ) {
    return err("context_management: compaction is not available on Unspent.");
  }
  return null;
}
