import type { ReactNode } from "react";

/** A table box that scrolls sideways on phones. Focusable so the scroll is reachable by keyboard (WCAG 2.1.1). */
export function TableWrap({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access
    <section className="table-wrap" tabIndex={0} aria-label={label}>
      {children}
    </section>
  );
}
