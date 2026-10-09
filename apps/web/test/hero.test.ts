// The hero port must match the approved prototype verbatim (brief 11.3, ASCII_HERO.md): settings, shaders, hashes
// and noise are compared against brand/hero/hero-prototype.html itself.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import raw from "../components/ascii-hero/hero-settings.json";
import { fbm, hash2, vnoise } from "../components/ascii-hero/noise";
import { BLUR_FS, CELL_FS, CELL_VS, COMP_FS, DOWN_FS, FS_VS } from "../components/ascii-hero/shaders";

const ROOT = new URL("../../../", import.meta.url).pathname;
const proto = readFileSync(`${ROOT}brand/hero/hero-prototype.html`, "utf8");

function template(name: string): string {
  const m = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`).exec(proto);
  if (!m) throw new Error(`${name} not found in the prototype`);
  return m[1]!;
}

describe("AsciiHero matches the prototype", () => {
  it("uses the approved settings unchanged", () => {
    expect(raw).toEqual(JSON.parse(readFileSync(`${ROOT}brand/hero/hero-settings.json`, "utf8")));
  });

  it("has the five shaders verbatim", () => {
    const hash = template("HASH");
    const ours = { CELL_VS, CELL_FS, FS_VS, DOWN_FS, BLUR_FS, COMP_FS };
    for (const [name, src] of Object.entries(ours)) {
      expect(src, name).toBe(template(name).replace(`$${"{HASH}"}`, hash));
    }
  });

  it("has the same hashes and noise", () => {
    const src = /function hash2[\s\S]*?function fbm[^\n]*\n/.exec(proto)![0];
    const ref = new Function(`${src}; return { hash2, vnoise, fbm };`)() as {
      hash2: typeof hash2;
      vnoise: typeof vnoise;
      fbm: typeof fbm;
    };
    for (let i = 0; i < 2000; i++) {
      const x = (i * 37) % 223,
        y = (i * 11) % 120,
        s = 7 * 131 + (i % 17);
      expect(hash2(x, y, s)).toBe(ref.hash2(x, y, s));
      expect(vnoise(x * 0.045, y * 0.045, 7)).toBe(ref.vnoise(x * 0.045, y * 0.045, 7));
      expect(fbm(x * 0.045, y * 0.045, 7)).toBe(ref.fbm(x * 0.045, y * 0.045, 7));
    }
  });

  it("keeps the build and atlas formulas", () => {
    // Spot-check distinctive constants of rebuild()/buildAtlas() so an accidental edit shows up.
    const build = readFileSync(new URL("../components/ascii-hero/build.ts", import.meta.url), "utf8");
    const atlas = readFileSync(new URL("../components/ascii-hero/atlas.ts", import.meta.url), "utf8");
    for (const s of [
      "0.2126 * data[j * 4]! + 0.7152 * data[j * 4 + 1]! + 0.0722 * data[j * 4 + 2]!",
      "[0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]",
      "G - B > 0.16 && R - B > 0.1 && G > 0.22",
      "hash2(c, r, S * 131 + k)",
      "P.stream * (0.25 + d)",
    ])
      expect(build).toContain(s);
    for (const s of ["S * (0.5 + 0.36 * P.glyphH)", "Math.round(gs * 0.1)", "slot = gs + 2"])
      expect(atlas).toContain(s);
  });
});
