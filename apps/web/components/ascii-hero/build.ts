// Source → cell grid → instances, verbatim from the prototype (ASCII_HERO.md §6–7). Runs on the CPU once per size
// or settings change. The rr(k) hash slots are fixed: changing them changes the approved layout.
import { fbm, hash2 } from "./noise";
import type { HeroSettings } from "./settings";

export type Layout = {
  cssW: number;
  cssH: number;
  dpr: number;
  fbW: number;
  fbH: number;
  cellCss: number;
  cols: number;
  rows: number;
  /** Cell size in scene pixels. */
  cell: number;
  /** CSS px → scene px. */
  k: number;
};

export function computeLayout(cssW: number, cssH: number, devicePixelRatio: number, P: HeroSettings) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const width = Math.round(cssW * dpr),
    height = Math.round(cssH * dpr);
  const fbW = Math.max(64, Math.round(width * P.fbScale)),
    fbH = Math.max(64, Math.round(height * P.fbScale));
  const cellCss = Math.max(cssW / P.cols, P.minCell);
  const cols = Math.ceil(cssW / cellCss),
    rows = Math.ceil(cssH / cellCss);
  const L: Layout = {
    cssW,
    cssH,
    dpr,
    fbW,
    fbH,
    cellCss,
    cols,
    rows,
    cell: (cellCss * fbW) / cssW,
    k: fbW / cssW,
  };
  return { L, width, height };
}

function fitRect(L: Layout, iw: number, ih: number, f: HeroSettings) {
  const W = L.cssW,
    H = L.cssH;
  let s = f.fit === "cover" ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih);
  s *= f.zoom;
  const dw = iw * s,
    dh = ih * s;
  return { dx: (W - dw) * f.posX, dy: (H - dh) * f.posY, dw, dh };
}

/** Two-step downsample (4×4 px per cell, then 1 px per cell) for an honest per-cell average without moiré. */
export function sampleSource(L: Layout, img: HTMLImageElement, P: HeroSettings): Uint8ClampedArray {
  const { cols, rows, cellCss } = L;
  const R = fitRect(L, img.naturalWidth, img.naturalHeight, P);
  const s4 = document.createElement("canvas");
  s4.width = cols * 4;
  s4.height = rows * 4;
  const x4 = s4.getContext("2d")!;
  x4.fillStyle = "#000";
  x4.fillRect(0, 0, s4.width, s4.height);
  x4.imageSmoothingEnabled = true;
  x4.imageSmoothingQuality = "high";
  const k = 4 / cellCss;
  x4.drawImage(img, R.dx * k, R.dy * k, R.dw * k, R.dh * k);
  const s1 = document.createElement("canvas");
  s1.width = cols;
  s1.height = rows;
  const x1 = s1.getContext("2d", { willReadFrequently: true })!;
  x1.imageSmoothingEnabled = true;
  x1.imageSmoothingQuality = "high";
  x1.drawImage(s4, 0, 0, cols, rows);
  return x1.getImageData(0, 0, cols, rows).data;
}

/** Instances: 8 float32 each, aA = (x, y, v, seed), aB = (d, sx, sy, flags); flags 1 accent, 2 ghost, 4 solid. */
export function buildInstances(
  data: Uint8ClampedArray,
  cols: number,
  rows: number,
  P: HeroSettings,
): { buf: Float32Array; count: number } {
  const S = P.seed | 0;
  const out: number[] = [];
  let n = 0;
  const push = (
    x: number,
    y: number,
    v: number,
    seed: number,
    d: number,
    sx: number,
    sy: number,
    fl: number,
  ) => {
    out.push(x, y, v, seed, d, sx, sy, fl);
    n++;
  };
  const span = Math.max(1e-3, P.white - P.black);
  const V = new Float32Array(cols * rows);
  for (let j = 0; j < cols * rows; j++) {
    const lum = (0.2126 * data[j * 4]! + 0.7152 * data[j * 4 + 1]! + 0.0722 * data[j * 4 + 2]!) / 255;
    V[j] = Math.min(1, Math.max(0, (lum - P.black) / span)) ** P.gamma;
  }
  const Q = V.slice();
  const lv = Math.max(2, P.levels | 0) - 1;
  if (P.dither > 0 && P.ditherMode === "bayer") {
    const M = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const j = r * cols + c;
        Q[j] = Math.min(1, Math.floor(V[j]! * lv + (M[(r & 3) * 4 + (c & 3)]! + 0.5) / 16) / lv);
      }
  } else if (P.dither > 0) {
    const E = V.slice();
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const j = r * cols + c;
        const o = E[j]!;
        const q = Math.min(1, Math.max(0, Math.round(o * lv) / lv));
        Q[j] = q;
        const e = o - q;
        if (c + 1 < cols) E[j + 1]! += (e * 7) / 16;
        if (r + 1 < rows) {
          if (c > 0) E[j + cols - 1]! += (e * 3) / 16;
          E[j + cols]! += (e * 5) / 16;
          if (c + 1 < cols) E[j + cols + 1]! += e / 16;
        }
      }
  }
  let figL = cols,
    figR = 0;
  for (let c = 0; c < cols; c++) {
    let k = 0;
    for (let r = 0; r < rows; r++) if (V[r * cols + c]! >= P.cutoff) k++;
    if (k >= 2) {
      if (c < figL) figL = c;
      figR = c;
    }
  }
  if (figR <= figL) {
    figL = 0;
    figR = cols;
  }
  const figW = Math.max(1, figR - figL);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 4,
        R = data[i]! / 255,
        G = data[i + 1]! / 255,
        B = data[i + 2]! / 255;
      const j = r * cols + c;
      let v = V[j]! + (Q[j]! - V[j]!) * P.dither;
      const lime = P.detectAccent && G - B > 0.16 && R - B > 0.1 && G > 0.22;
      const xN = (c - figL) / figW;
      let d = (P.edge - xN) / P.edgeWidth + (fbm(c * P.noiseScale, r * P.noiseScale, S) - 0.5) * P.noise * 2;
      d = Math.min(1, Math.max(0, d));
      if (v < P.cutoff + P.tailCut * d && !lime) continue;
      const rr = (k: number) => hash2(c, r, S * 131 + k);
      let x = c,
        y = r,
        sx = 1,
        sy = 1,
        fl = lime ? 5 : 0;
      if (d > 0) {
        if (rr(1) < P.dropout * d) continue;
        const q = rr(2);
        const sc = d ** 2 * P.scatter * (0.03 + 0.97 * q * q * q);
        x -= sc;
        y += (rr(3) - 0.5) * d * P.vspread + sc * P.tilt;
        if (sc > 3 && rr(14) < P.trails) {
          const tl = Math.min(14, 2 + sc * (0.1 + 0.3 * rr(15)));
          push(x + 1, y, v * 0.4, rr(16), d, tl, 0.5, 4);
        }
        const rb = rr(4);
        if (rb < P.blocks * d && v > 0.35) {
          const s = 2 + Math.floor(rr(5) * 2.4);
          sx = sy = s;
          fl |= 4;
        } else if (rb < (P.blocks + P.streaks) * d) {
          sx = 3 + Math.floor(rr(6) * 9);
          sy = 0.22;
          fl |= 4;
          v *= 0.85;
        }
        if (!lime && rr(7) < P.accentRand * 4 * d) {
          fl |= 5;
        }
      }
      if (!(fl & 4) && rr(8) < P.smear) {
        sx = 2 + Math.floor(rr(9) * 5);
        sy = 0.3;
        fl |= 4;
        v *= 0.8;
      }
      if (!lime && !(fl & 1) && d === 0 && rr(10) < P.accentRand * 0.3 && v > 0.3) {
        fl |= 5;
      }
      push(x, y, v, rr(11), d, sx, sy, fl);
      if (d > 0.02 && rr(12) < P.stream * (0.25 + d)) push(x, y, v, rr(13), d, 1, 1, fl & 1 ? 7 : 2);
    }
  return { buf: new Float32Array(out), count: n };
}
