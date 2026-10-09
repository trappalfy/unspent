import { CLAUDE_MODELS, formatCredits } from "@unspent/shared";

// 30-day spend by day and model as stacked bars. Monochrome: models differ by shade, not hue (brief 11.2).
const SHADES = ["var(--fg)", "#9a9a9a", "#4a4a4a", "#2a2a2a"];

export function SpendChart({
  data,
  days = 30,
  now = new Date(),
}: {
  data: { day: string; model: string; ucr: bigint }[];
  days?: number;
  now?: Date;
}) {
  const dayKeys = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1 - i)));
    return d.toISOString().slice(0, 10);
  });
  const models = [...new Set(data.map((d) => d.model))].sort();
  const byDay = new Map<string, Map<string, bigint>>();
  for (const d of data) {
    const m = byDay.get(d.day) ?? new Map<string, bigint>();
    m.set(d.model, (m.get(d.model) ?? 0n) + d.ucr);
    byDay.set(d.day, m);
  }
  const totals = dayKeys.map((k) => [...(byDay.get(k)?.values() ?? [])].reduce((a, b) => a + b, 0n));
  const max = totals.reduce((a, b) => (b > a ? b : a), 0n);
  const W = 600;
  const H = 140;
  const bw = W / days;
  const name = (id: string) => CLAUDE_MODELS.find((m) => m.id === id)?.displayName ?? id;
  const total = totals.reduce((a, b) => a + b, 0n);

  return (
    <figure className="flex flex-col gap-3">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-40 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Spend over the last ${days} days: ${formatCredits(total, 2)} credits`}
      >
        <line x1={0} x2={W} y1={H} y2={H} stroke="var(--line)" />
        {max > 0n &&
          dayKeys.map((k, i) => {
            let y = H;
            return models.map((m, j) => {
              const v = byDay.get(k)?.get(m) ?? 0n;
              if (v === 0n) return null;
              const h = Math.max(1, Number((v * BigInt(H - 4)) / max));
              y -= h;
              return (
                <rect
                  key={`${k}-${m}`}
                  x={i * bw + 2}
                  y={y}
                  width={bw - 4}
                  height={h}
                  fill={SHADES[j % SHADES.length]}
                >
                  <title>{`${k} · ${name(m)}: ${formatCredits(v, 4)} credits`}</title>
                </rect>
              );
            });
          })}
      </svg>
      <div className="flex justify-between text-xs text-mute">
        <span>{dayKeys[0]}</span>
        <span>{dayKeys.at(-1)}</span>
      </div>
      {models.length > 0 && (
        <figcaption className="flex flex-wrap gap-4 text-xs text-mute">
          {models.map((m, j) => (
            <span key={m} className="flex items-center gap-2">
              <span className="inline-block h-2 w-3" style={{ background: SHADES[j % SHADES.length] }} />
              {name(m)}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}
