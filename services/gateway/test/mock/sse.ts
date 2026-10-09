/** One server-sent event as the mock writes it. */
export interface SseEvent {
  event: string;
  data: unknown;
  /** Exact `data:` payload when it must differ from `JSON.stringify(data)` (the API's ping has a space). */
  raw?: string;
  /** Delay before this event; overrides the scenario's `chunkDelayMs`. */
  delayMs?: number;
}

/** `event: <type>\ndata: <json>\n\n` — the Messages API wire format. */
export function encodeSse(e: SseEvent): string {
  return `event: ${e.event}\ndata: ${e.raw ?? JSON.stringify(e.data)}\n\n`;
}

/**
 * Parses complete SSE events (terminated by a blank line). An unterminated trailing block is ignored,
 * so this is safe on a stream cut mid-event.
 */
// biome-ignore lint/suspicious/noExplicitAny: test helper, callers index into arbitrary event payloads
export function parseSse(text: string): { event: string; data: any }[] {
  const blocks = text.replace(/\r\n?/g, "\n").split("\n\n");
  blocks.pop();
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const events: { event: string; data: any }[] = [];
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0) events.push({ event, data: JSON.parse(data.join("\n")) });
  }
  return events;
}
