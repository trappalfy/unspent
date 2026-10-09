import type { ReactNode } from "react";
import { credits, exactCredits } from "@/lib/format";

/** A credit amount: 2 digits in large figures, 4 in tables; the exact value in the tooltip (brief 10.2). */
export function Credits({ ucr, digits = 2, unit = false }: { ucr: bigint; digits?: 2 | 4; unit?: boolean }) {
  const tiny = ucr > 0n && ucr < (digits === 2 ? 10_000n : 100n);
  return (
    <span title={exactCredits(ucr)} className="tabular-nums">
      {tiny ? `<${digits === 2 ? "0.01" : "0.0001"}` : credits(ucr, digits)}
      {unit && " credits"}
    </span>
  );
}

export function Stat({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border border-line p-4">
      <span className="text-xs text-mute uppercase tracking-wide">{label}</span>
      <span className="text-lg font-medium md:text-xl">{children}</span>
      {hint && <span className="text-xs text-mute">{hint}</span>}
    </div>
  );
}

export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <header className="flex flex-col gap-2 pt-8 pb-6">
      <h1 className="text-xl">{children}</h1>
      {sub && <p className="max-w-2xl text-sm text-mute">{sub}</p>}
    </header>
  );
}

export function Panel({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="flex flex-col gap-4 border border-line p-4 md:p-6">
      <h2 className="text-base font-medium">{title}</h2>
      {children}
    </section>
  );
}

/** Inverted [!] / [ERROR] marker: warnings carry no color (brief 11.2). */
export function Notice({ kind = "!", children }: { kind?: "!" | "ERROR"; children: ReactNode }) {
  return (
    <p className="text-sm" role={kind === "ERROR" ? "alert" : undefined}>
      <span className="notice">[{kind}]</span> {children}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="border border-dashed border-line p-6 text-sm text-mute">{children}</p>;
}

/** What goes out, what comes in, network fee — shown before every signature (brief 10.2). */
export function Preview({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 border-l border-line pl-4 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-mute">{k}</dt>
          <dd className="text-right tabular-nums md:text-left">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
