// JSON-line logs with metadata only (signatures, slots, counts).

export type LogFields = Record<string, string | number | bigint | boolean | null | undefined>;

export type Logger = {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
};

function line(level: string, msg: string, fields?: LogFields): string {
  return JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

export function createLogger(sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Logger {
  return {
    info: (m, f) => sink(line("info", m, f)),
    warn: (m, f) => sink(line("warn", m, f)),
    error: (m, f) => sink(line("error", m, f)),
  };
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
