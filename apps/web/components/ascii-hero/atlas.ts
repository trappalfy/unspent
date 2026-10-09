// Glyph atlas, verbatim from the prototype (ASCII_HERO.md §5): density-sorted ramp, one slot per glyph (gs + 2 px,
// 1 px gutter) plus a final solid square for blocks, streaks and lime cells.
import type { HeroSettings } from "./settings";

export type AtlasMeta = { gs: number; slot: number; w: number; h: number; n: number };

export function drawGlyph(
  x: CanvasRenderingContext2D,
  P: HeroSettings,
  font: string,
  ch: string,
  ox: number,
  oy: number,
  S: number,
) {
  x.save();
  x.translate(ox, oy);
  x.beginPath();
  x.rect(0, 0, S, S);
  x.clip();
  x.fillStyle = "#fff";
  x.font = `800 ${S * P.glyphH}px ${font}`;
  x.textAlign = "center";
  x.textBaseline = "alphabetic";
  const w = x.measureText("M").width || S * 0.6;
  x.translate(S / 2, S * (0.5 + 0.36 * P.glyphH));
  x.scale((S * P.glyphW) / w, 1);
  x.fillText(ch, 0, 0);
  if (P.weight > 0) {
    x.strokeStyle = "#fff";
    x.lineJoin = "round";
    x.lineWidth = S * P.weight;
    x.strokeText(ch, 0, 0);
  }
  x.restore();
}

/** Ramp characters sorted by drawn coverage: index 0 is the emptiest glyph, the last the densest. */
export function sortRamp(P: HeroSettings, font: string): string[] {
  const chars = [...new Set(String(P.ramp).replace(/\s/g, ""))];
  if (!chars.length) chars.push("#");
  const S = 48,
    c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  const cov = chars.map((ch): [string, number] => {
    x.clearRect(0, 0, S, S);
    drawGlyph(x, P, font, ch, 0, 0, S);
    const d = x.getImageData(0, 0, S, S).data;
    let s = 0;
    for (let i = 3; i < d.length; i += 4) s += d[i]!;
    return [ch, s];
  });
  cov.sort((a, b) => a[1] - b[1]);
  return cov.map((a) => a[0]);
}

/** Draws the atlas for a cell of `cellPx` scene pixels; the caller uploads the canvas as a texture. */
export function drawAtlas(
  P: HeroSettings,
  font: string,
  sortedRamp: string[],
  cellPx: number,
): { canvas: HTMLCanvasElement; meta: AtlasMeta } {
  const gs = Math.max(4, Math.round(cellPx)),
    slot = gs + 2,
    n = sortedRamp.length;
  const c = document.createElement("canvas");
  c.width = slot * (n + 1);
  c.height = slot;
  const x = c.getContext("2d")!;
  sortedRamp.forEach((ch, i) => {
    drawGlyph(x, P, font, ch, i * slot + 1, 1, gs);
  });
  const m = Math.max(1, Math.round(gs * 0.1));
  x.fillStyle = "#fff";
  x.fillRect(n * slot + 1 + m, 1 + m, gs - 2 * m, gs - 2 * m);
  return { canvas: c, meta: { gs, slot, w: c.width, h: c.height, n } };
}
