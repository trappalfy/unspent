// Structured logs with billing metadata only. Request and response bodies are never passed here (brief 0.9, 8.11).

export type LogFields = Record<string, string | number | bigint | boolean | null | undefined>;

export type Logger = {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Something the owner must look at: disabled provider key, settle failures, reconciliation mismatch. */
  alert(kind: string, fields?: LogFields): void;
};

function line(level: string, msg: string, fields?: LogFields): string {
  return JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

export function createLogger(
  opts: { webhookUrl?: string | null; sink?: (line: string) => void } = {},
): Logger {
  const sink = opts.sink ?? ((l: string) => process.stdout.write(`${l}\n`));
  return {
    info: (m, f) => sink(line("info", m, f)),
    warn: (m, f) => sink(line("warn", m, f)),
    error: (m, f) => sink(line("error", m, f)),
    alert: (kind, f) => {
      const l = line("alert", kind, f);
      sink(l);
      if (opts.webhookUrl) {
        fetch(opts.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: l,
        }).catch(() => {});
      }
    },
  };
}
