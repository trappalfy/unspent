// Deterministic hashes and value noise, verbatim from brand/hero/hero-prototype.html (ASCII_HERO.md §6).
// The grid layout depends on these exact functions: do not "improve" them.

export function hash2(x: number, y: number, s: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    xf = x - xi,
    yf = y - yi,
    u = xf * xf * (3 - 2 * xf),
    w = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s),
    b = hash2(xi + 1, yi, s),
    c = hash2(xi, yi + 1, s),
    d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
}

export function fbm(x: number, y: number, s: number): number {
  let v = 0,
    a = 0.5,
    f = 1;
  for (let i = 0; i < 4; i++) {
    v += a * vnoise(x * f, y * f, s + i * 17);
    f *= 2;
    a *= 0.5;
  }
  return v / 0.9375;
}
