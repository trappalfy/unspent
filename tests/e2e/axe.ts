// axe-core in the page: WCAG 2.1 A/AA violations, including color contrast (brief 11.8).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "playwright-core";

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

export type AxeViolation = { id: string; impact: string | null; help: string; targets: string[] };

export async function axe(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ content: AXE });
  // A string, not a function: tsx would inject its __name helper into a serialized function.
  return page.evaluate(`(async () => {
    // The problem section's scrolling logs are decoration (aria-hidden), exempt from contrast under WCAG 1.4.3.
    const r = await window.axe.run({ exclude: [[".logs"]] }, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    }));
  })()`);
}

export function describe(v: AxeViolation[]): string {
  return v.map((x) => `${x.id} (${x.impact}): ${x.help} → ${x.targets.join(" | ")}`).join("\n    ");
}
