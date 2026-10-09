import type { CSSProperties } from "react";
import { USAGE_LOG_LINES } from "@/lib/logs";

// Background logs for the problem section (brief 11.4): --dim lines move up one line every 1.5 s; on some lines the
// "expires" field gets struck through and fades. Pure CSS; reduced motion leaves it static.

const EXPIRES = /("expires":"[^"]*")/g;
const LINES = [...USAGE_LOG_LINES, ...USAGE_LOG_LINES.slice(0, 40)];

export function LogsBackdrop() {
  return (
    <div className="logs" aria-hidden="true" style={{ "--n": USAGE_LOG_LINES.length } as CSSProperties}>
      <div className="logs-track">
        {LINES.map((line, i) => (
          <div key={i} className="logs-line">
            {line.split(EXPIRES).map((part, j) =>
              part.startsWith('"expires"') && (i * 7 + j) % 5 === 0 ? (
                <span key={j} className="logs-exp" style={{ animationDelay: `${(i % 40) * 1.5 + 1}s` }}>
                  {part}
                </span>
              ) : (
                part
              ),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
