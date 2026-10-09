/** ModelInfo per docs api/models/list. `created_at` values are made up for the mock. */
export interface MockModel {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
  max_input_tokens: number;
  max_tokens: number;
  lifecycle: "active";
  line: "opus" | "sonnet" | "haiku" | "fable";
  deprecated_at: null;
  retires_at: null;
  capabilities: null;
}

const model = (id: string, display_name: string, line: MockModel["line"], created_at: string): MockModel => ({
  type: "model",
  id,
  display_name,
  created_at,
  max_input_tokens: 1_000_000,
  max_tokens: 128_000,
  lifecycle: "active",
  line,
  deprecated_at: null,
  retires_at: null,
  capabilities: null,
});

export const MOCK_MODELS: readonly MockModel[] = [
  model("claude-opus-5-5", "Claude Opus 5.5", "opus", "2026-09-24T00:00:00Z"),
  model("claude-sonnet-5-5", "Claude Sonnet 5.5", "sonnet", "2026-09-24T00:00:00Z"),
  model("claude-haiku-5-5", "Claude Haiku 5.5", "haiku", "2026-09-24T00:00:00Z"),
  model("claude-fable-5-1", "Claude Fable 5.1", "fable", "2026-08-27T00:00:00Z"),
];

export const getModel = (id: string): MockModel | undefined => MOCK_MODELS.find((m) => m.id === id);

/** GET /v1/models with `limit` (default 20), `after_id`, `before_id`. */
export function listModels(params: URLSearchParams) {
  const limit = Math.min(1000, Math.max(1, Number(params.get("limit") ?? 20) || 20));
  const index = (id: string | null) => (id === null ? -1 : MOCK_MODELS.findIndex((m) => m.id === id));
  const before = index(params.get("before_id"));
  let start: number;
  let end: number;
  if (before >= 0) {
    end = before;
    start = Math.max(0, end - limit);
  } else {
    start = index(params.get("after_id")) + 1;
    end = Math.min(MOCK_MODELS.length, start + limit);
  }
  const data = MOCK_MODELS.slice(start, end);
  return {
    data,
    has_more: before >= 0 ? start > 0 : end < MOCK_MODELS.length,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  };
}
