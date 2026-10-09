# AsciiHero — как устроена шапка Unspent и как перенести её один в один

> Для Claude Code. Это подробная инструкция к модулю шапки из раздела 11.3 `UNSPENT_BRIEF.md`.
> Эталон — `brand/hero/hero-prototype.html` (рабочий файл, который утвердил владелец). Настройки — `brand/hero/hero-settings.json`. Источник — `brand/hero/hero-source-1600.webp`.
> Правило одно: **визуально ничего не менять.** Все числа, формулы, хэши и порядок проходов ниже взяты из прототипа дословно. Если что-то здесь расходится с прототипом, прав прототип — сообщи о расхождении владельцу.

---

## 1. Что получается и из чего

Картинка-источник превращается в сетку квадратных клеток. В каждой клетке рисуется ASCII-символ, плотность которого соответствует яркости. Каждая клетка — отдельный инстанс в WebGL2, поэтому её можно двигать: так сделаны вход, поток, курсор, сбои и разлёт при скролле.

Кадр рисуется в три прохода:

```
источник ──► сетка клеток (CPU, один раз на размер/настройки)
                │  яркость → тон → дизеринг → символ, распад, акценты
                ▼
1. СЦЕНА      инстансы-квадраты с символами из атласа → текстура tScene (внутреннее разрешение fbScale)
2. СВЕЧЕНИЕ   tScene → уменьшение до 1/4 → размытие по X → по Y → текстура tA
3. КОМПОЗИТ   tScene (горизонтальный смаз) + tA × bloom → строки развёртки → × exposure → экран
```

Без внешних библиотек: чистый WebGL2, Canvas 2D (атлас и сэмплирование) и немного JS.

## 2. Структура модуля в Next.js

```
apps/web/components/ascii-hero/
├─ AsciiHero.tsx     # клиентский компонент: canvas, жизненный цикл, заглушка
├─ engine.ts         # WebGL: программы, буферы, FBO, draw(), frame()
├─ build.ts          # sampleSource(), тон, дизеринг, фигура, распад, инстансы
├─ atlas.ts          # drawGlyph(), sortRamp(), buildAtlas()
├─ shaders.ts        # пять шейдеров дословно (раздел 8)
├─ noise.ts          # hash2(), vnoise(), fbm() дословно (раздел 6)
└─ settings.ts       # тип HeroSettings + import hero-settings.json
```

Компонент:

```tsx
<AsciiHero
  src="/hero/hero-source-1600.webp"
  fallbackSrc="/hero/hero-static-desktop.png"
  settings={heroSettings}          // из brand/hero/hero-settings.json, без изменений
/>
```

Что из прототипа **не переносится**: панель настроек (только при `?tune=1` вне продакшена), пресет «Свой бюст», загрузка картинки перетаскиванием, наложение «сравнить с референсом», тестовый хук `window.__hero` (в продакшене не нужен; для тестов — см. раздел 13).

## 3. Параметры (`hero-settings.json`)

Колонка «Когда применять»: **сетка** — пересобрать инстансы (`rebuild`), **атлас** — пересобрать атлас символов, **размер** — пересчитать раскладку целиком (`layout`), **кадр** — только uniform, применяется в следующем кадре.

| Ключ | Значение | Что делает | Когда применять |
|---|---|---|---|
| `cols` | 223 | клеток по ширине на десктопе | сетка |
| `minCell` | 4 | минимальный размер клетки в CSS px (телефон) | сетка |
| `ditherMode` | `bayer` | тип дизеринга: `bayer` (4×4) или `diffusion` (Флойд–Стейнберг) | сетка |
| `dither` | 0.85 | сила дизеринга: смешивание исходной яркости с квантованной | сетка |
| `levels` | 4 | уровней яркости при квантовании | сетка |
| `glyphJitter` | 0.3 | случайный сдвиг индекса символа, чтобы символы не повторялись | кадр |
| `black` | 0.06 | точка чёрного | сетка |
| `white` | 0.66 | точка белого | сетка |
| `gamma` | 1.25 | гамма яркости | сетка |
| `cutoff` | 0.09 | клетки темнее — пустые | сетка |
| `tailCut` | 0.2 | добавка к порогу пустоты в зоне распада (× `d`) | сетка |
| `grayLo` | 0.32 | яркость самого тёмного символа | кадр |
| `toneGamma` | 0.8 | контраст цвета символа | кадр |
| `weight` | 0.04 | обводка символа (жирность) в долях клетки | атлас |
| `glyphH` | 1.25 | высота шрифта в долях клетки | атлас |
| `glyphW` | 1.0 | ширина символа в долях клетки | атлас |
| `ramp` | `.,:;'-~=+*x/\|<>?%XV#&8@$WMB` | набор символов; порядок задаётся сортировкой по плотности | атлас |
| `fit` | `cover` | вписывание источника: `cover` или `contain` | сетка |
| `zoom` | 1 | масштаб источника | сетка |
| `posX`, `posY` | 1, 0.5 | привязка источника (1 = вправо, 0.5 = по центру) | сетка |
| `edge` | 0.62 | граница зоны распада в долях ширины фигуры | сетка |
| `edgeWidth` | 0.25 | мягкость границы | сетка |
| `noise` | 0.35 | рваность границы | сетка |
| `noiseScale` | 0.045 | масштаб шума рваности | сетка |
| `scatter`, `vspread`, `tilt`, `dropout`, `blocks`, `streaks`, `trails`, `smear`, `accentRand` | 0 | процедурный распад для «чистого» бюста. В утверждённых настройках **все нули**: распад уже нарисован в источнике. Код оставить, он нужен, если источник сменится | сетка |
| `detectAccent` | true | лаймовые пиксели источника становятся лаймовыми клетками | сетка |
| `lime` | `#DBF150` | цвет акцента | кадр |
| `stream` | 0.26 | доля клеток зоны распада, у которых есть «призрак», улетающий влево | сетка |
| `seed` | 7 | вариант раскладки случайностей | сетка |
| `drift` | 60 | длина полёта призрака, клеток | кадр |
| `driftSpeed` | 0.09 | скорость цикла призрака | кадр |
| `shimmer` | 0.03 | вероятность смены символа на соседний по плотности (7 раз в секунду) | кадр |
| `glitchOn`, `glitchRate`, `glitchShift` | true, 0.5, 12 | сбои строк: в среднем 0.5 в секунду, сдвиг до 12 клеток | кадр |
| `cursorOn`, `repelR`, `repelK` | true, 140, 26 | реакция на курсор: радиус и сила в CSS px | кадр |
| `introOn`, `introDur` | true, 2.6 | вход при загрузке и его длительность, с | кадр |
| `scrollOn` | true | разлёт при скролле | кадр |
| `exposure` | 1.2 | общая яркость | кадр |
| `fbScale` | 0.55 | внутреннее разрешение сцены (мягкость) | размер |
| `bloom`, `bloomSpread` | 0.3, 1.2 | сила и радиус свечения | кадр |
| `hblur` | 1.0 | горизонтальный смаз, CSS px | кадр |
| `scan`, `scanPitch` | 0.18, 3 | глубина и шаг строк развёртки (CSS px) | кадр |

## 4. Раскладка и размеры

```js
let L = {};
function fitRect(iw, ih, f) {
  const W = L.cssW,
    H = L.cssH;
  let s = f.fit === "cover" ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih);
  s *= f.zoom;
  const dw = iw * s,
    dh = ih * s;
  return { dx: (W - dw) * f.posX, dy: (H - dh) * f.posY, dw, dh };
}
function layout() {
  const r = hero.getBoundingClientRect();
  const cssW = Math.max(1, r.width),
    cssH = Math.max(1, r.height);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const fbW = Math.max(64, Math.round(canvas.width * P.fbScale)),
    fbH = Math.max(64, Math.round(canvas.height * P.fbScale));
  const cellCss = Math.max(cssW / P.cols, P.minCell);
  const cols = Math.ceil(cssW / cellCss),
    rows = Math.ceil(cssH / cellCss);
  L = {
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
  freeTarget(tScene);
  freeTarget(tA);
  freeTarget(tB);
  tScene = makeTarget(fbW, fbH);
  const bw = Math.max(16, Math.round(fbW / 4)),
    bh = Math.max(16, Math.round(fbH / 4));
  tA = makeTarget(bw, bh);
  tB = makeTarget(bw, bh);
  buildAtlas(L.cell);
  rebuild();
  dirty = true;
}
```

- Холст занимает весь блок шапки; размер холста в пикселях устройства, DPR ограничен 2.
- Сцена рисуется во внутреннее разрешение `fbW × fbH = холст × fbScale` и потом растягивается на экран с линейной фильтрацией — отсюда мягкость, как у референса.
- Размер клетки в CSS px: `max(ширина / cols, minCell)`. На десктопе это 223 клетки по ширине, на телефоне клетка не меньше 4 px.
- `L.cell` — размер клетки в пикселях сцены, `L.k` — перевод CSS px → пиксели сцены.
- Текстура свечения — 1/4 сцены.
- `layout()` вызывается при монтировании и через `ResizeObserver` с задержкой 120 мс.

## 5. Атлас символов

```js
const GLYPH_FONT = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
function drawGlyph(x, ch, ox, oy, S) {
  x.save();
  x.translate(ox, oy);
  x.beginPath();
  x.rect(0, 0, S, S);
  x.clip();
  x.fillStyle = "#fff";
  x.font = `800 ${S * P.glyphH}px ${GLYPH_FONT}`;
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
let sortedRamp = [];
function sortRamp() {
  const chars = [...new Set(String(P.ramp).replace(/\s/g, ""))];
  if (!chars.length) chars.push("#");
  const S = 48,
    c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d", { willReadFrequently: true });
  const cov = chars.map((ch) => {
    x.clearRect(0, 0, S, S);
    drawGlyph(x, ch, 0, 0, S);
    const d = x.getImageData(0, 0, S, S).data;
    let s = 0;
    for (let i = 3; i < d.length; i += 4) s += d[i];
    return [ch, s];
  });
  cov.sort((a, b) => a[1] - b[1]);
  sortedRamp = cov.map((a) => a[0]);
}
function buildAtlas(cellPx) {
  const gs = Math.max(4, Math.round(cellPx)),
    slot = gs + 2,
    n = sortedRamp.length;
  const c = document.createElement("canvas");
  c.width = slot * (n + 1);
  c.height = slot;
  const x = c.getContext("2d");
  sortedRamp.forEach((ch, i) => drawGlyph(x, ch, i * slot + 1, 1, gs));
  const m = Math.max(1, Math.round(gs * 0.1));
  x.fillStyle = "#fff";
  x.fillRect(n * slot + 1 + m, 1 + m, gs - 2 * m, gs - 2 * m);
  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  ATL = { gs, slot, w: c.width, h: c.height, n };
}
```

- Шрифт — **JetBrains Mono 800**. Атлас строится только после загрузки шрифта (`document.fonts.load('800 48px <семейство>')`, не дольше 2.5 с ожидания, потом — что есть). В Next.js с `next/font` имя семейства генерируется: бери его из `jetbrains.style.fontFamily`, а не строкой `"JetBrains Mono"`.
- Символ растягивается по ширине на всю клетку (`glyphW`), высота шрифта — `glyphH` клетки, базовая линия на `0.5 + 0.36 × glyphH` высоты. Обводка толщиной `weight` клетки делает символы плотнее.
- `sortRamp()` один раз рисует каждый символ в 48×48 и сортирует набор по сумме альфы (плотности). Индекс 0 — самый «пустой» символ, последний — самый плотный.
- Атлас — полоса слотов по `gs + 2` px (`gs` = размер клетки в пикселях сцены, не меньше 4), по 1 px отступа, чтобы соседние символы не протекали при линейной фильтрации. Последний слот — сплошной квадрат с отступом 10% (для блоков и штрихов).
- Атлас пересобирается при каждом `layout()`: размер слота должен совпадать с размером клетки.

## 6. Источник, шум и хэши

```js
function sampleSource() {
  const { cols, rows, cellCss } = L;
  const R = fitRect(srcImg.naturalWidth, srcImg.naturalHeight, P);
  const s4 = document.createElement("canvas");
  s4.width = cols * 4;
  s4.height = rows * 4;
  const x4 = s4.getContext("2d");
  x4.fillStyle = "#000";
  x4.fillRect(0, 0, s4.width, s4.height);
  x4.imageSmoothingEnabled = true;
  x4.imageSmoothingQuality = "high";
  const k = 4 / cellCss;
  x4.drawImage(srcImg, R.dx * k, R.dy * k, R.dw * k, R.dh * k);
  const s1 = document.createElement("canvas");
  s1.width = cols;
  s1.height = rows;
  const x1 = s1.getContext("2d", { willReadFrequently: true });
  x1.imageSmoothingEnabled = true;
  x1.imageSmoothingQuality = "high";
  x1.drawImage(s4, 0, 0, cols, rows);
  return x1.getImageData(0, 0, cols, rows).data;
}
```

```js
function hash2(x, y, s) {
  let h =
    (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
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
function fbm(x, y, s) {
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
```

- Источник вписывается так же, как `object-fit` (`cover`/`contain`, `zoom`, `posX`, `posY`).
- Уменьшение в два шага: сначала до 4×4 пикселей на клетку, потом до 1 пикселя на клетку, оба раза с `imageSmoothingQuality = 'high'`. Это даёт честное усреднение по клетке; одношаговое уменьшение даёт муар.
- `hash2` и `fbm` — детерминированные. Раскладка при одинаковом `seed` всегда одна и та же: от этого зависит, что шапка совпадёт с утверждённым кадром.

## 7. Сборка сетки (`rebuild`)

```js
function rebuild() {
  const data = sampleSource();
  const { cols, rows } = L;
  const S = P.seed | 0;
  const out = [];
  let n = 0;
  const push = (x, y, v, seed, d, sx, sy, fl) => {
    out.push(x, y, v, seed, d, sx, sy, fl);
    n++;
  };
  const span = Math.max(1e-3, P.white - P.black);
  const V = new Float32Array(cols * rows);
  for (let j = 0; j < cols * rows; j++) {
    const lum = (0.2126 * data[j * 4] + 0.7152 * data[j * 4 + 1] + 0.0722 * data[j * 4 + 2]) / 255;
    V[j] = Math.pow(Math.min(1, Math.max(0, (lum - P.black) / span)), P.gamma);
  }
  const Q = V.slice();
  const lv = Math.max(2, P.levels | 0) - 1;
  if (P.dither > 0 && P.ditherMode === "bayer") {
    const M = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const j = r * cols + c;
        Q[j] = Math.min(1, Math.floor(V[j] * lv + (M[(r & 3) * 4 + (c & 3)] + 0.5) / 16) / lv);
      }
  } else if (P.dither > 0) {
    const E = V.slice();
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const j = r * cols + c;
        const o = E[j];
        const q = Math.min(1, Math.max(0, Math.round(o * lv) / lv));
        Q[j] = q;
        const e = o - q;
        if (c + 1 < cols) E[j + 1] += (e * 7) / 16;
        if (r + 1 < rows) {
          if (c > 0) E[j + cols - 1] += (e * 3) / 16;
          E[j + cols] += (e * 5) / 16;
          if (c + 1 < cols) E[j + cols + 1] += e / 16;
        }
      }
  }
  let figL = cols,
    figR = 0;
  for (let c = 0; c < cols; c++) {
    let k = 0;
    for (let r = 0; r < rows; r++) if (V[r * cols + c] >= P.cutoff) k++;
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
        R = data[i] / 255,
        G = data[i + 1] / 255,
        B = data[i + 2] / 255;
      const j = r * cols + c;
      let v = V[j] + (Q[j] - V[j]) * P.dither;
      const lime = P.detectAccent && G - B > 0.16 && R - B > 0.1 && G > 0.22;
      const xN = (c - figL) / figW;
      let d =
        (P.edge - xN) / P.edgeWidth +
        (fbm(c * P.noiseScale, r * P.noiseScale, S) - 0.5) * P.noise * 2;
      d = Math.min(1, Math.max(0, d));
      if (v < P.cutoff + P.tailCut * d && !lime) continue;
      const rr = (k) => hash2(c, r, S * 131 + k);
      let x = c,
        y = r,
        sx = 1,
        sy = 1,
        fl = lime ? 5 : 0;
      if (d > 0) {
        if (rr(1) < P.dropout * d) continue;
        const q = rr(2);
        const sc = Math.pow(d, 2) * P.scatter * (0.03 + 0.97 * q * q * q);
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
      if (d > 0.02 && rr(12) < P.stream * (0.25 + d))
        push(x, y, v, rr(13), d, 1, 1, fl & 1 ? 7 : 2);
    }
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.STATIC_DRAW);
  instCount = n;
  dirty = true;
}
```

По шагам:
1. **Яркость** клетки — Rec. 709: `0.2126 R + 0.7152 G + 0.0722 B`. Тон: `v = ((lum − black) / (white − black))^gamma`, обрезано в 0…1.
2. **Квантование** до `levels` уровней. Bayer: порог из матрицы 4×4 `[0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5]`, по `(row & 3, col & 3)`. Diffusion: ошибка разносится 7/16, 3/16, 5/16, 1/16.
3. **Смешивание:** `v = V + (Q − V) × dither`.
4. **Фигура:** крайние слева и справа столбцы, где не меньше двух клеток ярче `cutoff`. `xN` — положение клетки внутри фигуры, 0…1.
5. **Поле распада:** `d = clamp((edge − xN) / edgeWidth + (fbm(c·noiseScale, r·noiseScale, seed) − 0.5) × noise × 2, 0, 1)`. Справа (лицо) `d = 0`, к затылку растёт до 1.
6. **Пустые клетки:** если `v < cutoff + tailCut × d` и клетка не лаймовая — пропуск.
7. **Лайм:** клетка лаймовая, если `G − B > 0.16`, `R − B > 0.1` и `G > 0.22` (в долях 0…1).
8. **Случайности клетки** — `rr(k) = hash2(col, row, seed × 131 + k)`. Номера `k` зафиксированы (1 — прореживание, 2 — разброс, 3 — вертикаль, 4 — блоки/штрихи, 5 — размер блока, 6 — длина штриха, 7 — случайный акцент, 8 — смаз, 9 — длина смаза, 10 — акцент вне распада, 11 — сид инстанса, 12 — наличие призрака, 13 — сид призрака, 14–16 — шлейфы). Не меняй номера, иначе раскладка поменяется.
9. **Призрак:** если `d > 0.02` и `rr(12) < stream × (0.25 + d)`, у клетки появляется второй инстанс с флагом «призрак» — он циклично улетает влево (раздел 9).
10. **Инстанс** — 8 чисел float32: `aA = (x, y, v, seed)`, `aB = (d, sx, sy, flags)`. `x, y` — в клетках, `sx, sy` — размер в клетках (у обычной клетки 1×1), `flags` — биты: 1 — акцент (лайм), 2 — призрак, 4 — сплошной (блок, штрих, смаз, лаймовая клетка). Буфер инстансов — `STATIC_DRAW`, пересобирается только в `rebuild`.

## 8. Шейдеры (дословно)

Хэши, общие для шейдеров:

```glsl
float h1(float x){x=fract(x*.1031);x*=x+33.33;x*=x+x;return fract(x);}
float h2(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
```

Вершинный шейдер клеток — вся анимация живёт здесь:

```glsl
#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aA;
layout(location=2) in vec4 aB;
uniform vec2 uRes; uniform float uCell; uniform vec2 uGrid; uniform float uTime;
uniform float uIntroT, uIntroDur, uIntroOn;
uniform vec2 uMouse; uniform float uMouseAmt, uRepelR, uRepelK;
uniform vec4 uGlitch[4];
uniform float uScroll, uDrift, uDriftSpeed, uShimmer, uN, uJit;
out vec2 vUV; out float vVal; out float vAlpha; flat out float vGlyph; flat out float vAccent;
float h1(float x){x=fract(x*.1031);x*=x+33.33;x*=x+x;return fract(x);}
float h2(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
void main(){
  float v=aA.z, seed=aA.w, d=aB.x; vec2 sz=aB.yz; float fl=aB.w;
  float accent=mod(fl,2.), ghost=mod(floor(fl/2.),2.), solid=mod(floor(fl/4.),2.);
  vec2 p=aA.xy; float alpha=1., scr=0.;
  float xN=clamp(p.x/uGrid.x,0.,1.);
  if(ghost>.5){
    float ph=fract(uTime*uDriftSpeed*(.35+.9*h1(seed*91.7))+seed*7.31);
    p.x-=pow(ph,1.25)*uDrift*(.35+d);
    p.y+=(h1(seed*13.1)-.5)*ph*uDrift*.14+sin(ph*6.2831+seed*40.)*.4;
    alpha*=smoothstep(0.,.06,ph)*(1.-ph)*.95;
    scr=ph*.6;
  }
  for(int i=0;i<4;i++){vec4 g=uGlitch[i];if(g.w>.5&&aA.y>=g.x&&aA.y<g.y)p.x+=g.z;}
  vec2 px=p*uCell;
  if(uIntroOn>.5){
    float delay=(1.-xN)*.55+h1(seed*3.7)*.45;
    float k=clamp((uIntroT/uIntroDur-delay*.5)/.5,0.,1.);
    float e=1.-pow(1.-k,3.);
    vec2 off=vec2(-(25.+95.*h1(seed*5.1))*(.6+d),(h1(seed*8.3)-.5)*30.)*uCell;
    px+=off*(1.-e);
    alpha*=smoothstep(0.,.25,k);
    scr=max(scr,1.-smoothstep(.55,1.,k));
  }
  if(uMouseAmt>.001){
    vec2 dv=px+.5*uCell-uMouse; float dist=length(dv);
    float f=uMouseAmt*(1.-smoothstep(0.,uRepelR,dist));
    px+=dv/(dist+1e-3)*f*f*uRepelK+vec2(-f*uRepelK*.35,0.);
    scr=max(scr,f*.9);
  }
  if(uScroll>0.){
    float w=clamp(uScroll*2.2-xN*1.1+(h1(seed*17.3)-.5)*.35,0.,1.);
    float w2=w*w;
    px.x-=w2*uRes.x*(.2+.6*h1(seed*23.9));
    px.y+=(h1(seed*29.3)-.5)*w*uRes.y*.25;
    alpha*=1.-w2; scr=max(scr,w);
  }
  float gi=floor(v*(uN-1.)+.5);
  gi=clamp(gi+floor((h1(seed*61.3)-.5)*uJit*uN*.25+.5),0.,uN-1.);
  float tk=floor(uTime*7.+seed*50.);
  if(h2(vec2(seed*101.,tk))<uShimmer) gi=clamp(gi+(h2(vec2(seed*7.,tk))<.5?-1.:1.),0.,uN-1.);
  float tk2=floor(uTime*18.);
  if(h2(vec2(seed*33.,tk2))<scr) gi=floor(h2(vec2(seed*5.,tk2))*(uN-.01));
  if(solid>.5) gi=uN;
  if(accent>.5) alpha*=.6+.4*step(.12,h2(vec2(seed*3.,floor(uTime*2.5))));
  vec2 pos=px+(aCorner*sz+vec2(0.,(1.-sz.y)*.5))*uCell;
  vec2 c=pos/uRes*2.-1.; c.y=-c.y;
  gl_Position=vec4(c,0.,1.);
  vUV=aCorner; vVal=v; vAlpha=alpha; vGlyph=gi; vAccent=accent;
}
```

Фрагментный шейдер клеток:

```glsl
#version 300 es
precision highp float;
in vec2 vUV; in float vVal; in float vAlpha; flat in float vGlyph; flat in float vAccent;
uniform sampler2D uAtlas; uniform vec4 uAtl; uniform vec3 uLime; uniform float uGrayLo, uToneGamma;
out vec4 o;
void main(){
  vec2 uv=vec2((vGlyph*uAtl.y+1.+vUV.x*uAtl.x)/uAtl.z,(1.+vUV.y*uAtl.x)/uAtl.w);
  float a=texture(uAtlas,uv).a*vAlpha;
  vec3 c=vAccent>.5?uLime:vec3(mix(uGrayLo,1.,pow(vVal,uToneGamma)));
  o=vec4(c*a,a);
}
```

Полноэкранный треугольник, уменьшение, размытие и композит:

```glsl
#version 300 es
out vec2 vUV;
void main(){vec2 p=vec2(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.);vUV=p*.5+.5;gl_Position=vec4(p,0.,1.);}
```

```glsl
#version 300 es
precision highp float; in vec2 vUV; uniform sampler2D uTex; uniform vec2 uTexel; out vec4 o;
void main(){vec2 t=uTexel;o=(texture(uTex,vUV+vec2(-t.x,-t.y))+texture(uTex,vUV+vec2(t.x,-t.y))+texture(uTex,vUV+vec2(-t.x,t.y))+texture(uTex,vUV+vec2(t.x,t.y)))*.25;}
```

```glsl
#version 300 es
precision highp float; in vec2 vUV; uniform sampler2D uTex; uniform vec2 uDir; out vec4 o;
void main(){float w[5]=float[5](.227027,.1945946,.1216216,.054054,.016216);vec4 c=texture(uTex,vUV)*w[0];
for(int i=1;i<5;i++){c+=texture(uTex,vUV+uDir*float(i))*w[i];c+=texture(uTex,vUV-uDir*float(i))*w[i];}o=c;}
```

```glsl
#version 300 es
precision highp float; in vec2 vUV; uniform sampler2D uScene; uniform sampler2D uBloom; uniform vec2 uTexel;
uniform float uBloomK,uHBlur,uScan,uScanPitch,uExp; out vec4 o;
void main(){vec2 h=vec2(uHBlur*uTexel.x,0.);
vec3 c=texture(uScene,vUV).rgb*.5+texture(uScene,vUV+h).rgb*.25+texture(uScene,vUV-h).rgb*.25;
c+=texture(uBloom,vUV).rgb*uBloomK;
float s=.5+.5*cos(gl_FragCoord.y*6.2831853/uScanPitch);
c*=uExp*(1.-uScan*s); o=vec4(c,1.);}
```

Геометрия: один буфер углов квадрата `[0,0, 1,0, 0,1, 0,1, 1,0, 1,1]` (атрибут 0), буфер инстансов с шагом 32 байта (атрибуты 1 и 2, `vertexAttribDivisor = 1`), отрисовка `drawArraysInstanced(TRIANGLES, 0, 6, count)`. Полноэкранные проходы — `drawArrays(TRIANGLES, 0, 3)` с пустым VAO. Текстуры FBO — `RGBA8`, `LINEAR`, `CLAMP_TO_EDGE`.

## 9. Анимации

Все анимации — в вершинном шейдере, по uniform-ам из JS. Ничего не пересобирается в кадре.

| Анимация | Что происходит | Где |
|---|---|---|
| **Вход** | Каждая клетка стартует левее своего места на `(25 + 95 × h) × (0.6 + d)` клеток и ±15 клеток по вертикали, летит на место с ease-out cubic и проявляется. Задержка клетки: `(1 − xN) × 0.55 + h × 0.45` — лицо (справа) прилетает первым, хвост последним. Пока клетка в пути, символ перебирается случайно («расшифровка»). Длительность — `introDur`; после `introDur × 1.05` вход выключается | блок `uIntroOn` |
| **Поток** | Призраки циклично летят влево на `drift × (0.35 + d)` клеток с лёгкой волной, проявляются за первые 6% цикла и гаснут к концу. Скорость цикла — `driftSpeed × (0.35 + 0.9 h)` | блок `ghost` |
| **Мерцание** | 7 раз в секунду клетка с вероятностью `shimmer` сдвигает символ на соседний по плотности | `tk`, `uShimmer` |
| **Сбои** | JS с вероятностью `glitchRate × dt` в кадр заводит полосу: строка `y0`, высота 1–5 строк, сдвиг ±(2…2 + glitchShift) клеток, жизнь 0.06–0.22 с. Одновременно не больше 4 полос (`uGlitch[4]`) | `stepGlitch`, `uGlitch` |
| **Курсор** | Клетки в радиусе `repelR` расталкиваются от курсора с силой `repelK × f²` плюс снос влево `0.35 × f × repelK`, символы перебираются. Позиция курсора сглаживается (`0.18` за кадр), сила включается и гаснет плавно (`0.08` за кадр). Только мышь и перо, не касание | блок `uMouseAmt` |
| **Скролл** | `progress = clamp(−top / (0.85 × высота шапки), 0, 1)`. Волна `w = clamp(progress × 2.2 − xN × 1.1 ± 0.175, 0, 1)` сносит клетки влево на `w² × ширина × (0.2…0.8)` и гасит их — хвост улетает первым, лицо последним. При возврате наверх всё собирается обратно | блок `uScroll` |
| **Акценты** | Лаймовые клетки мигают 2.5 раза в секунду с вероятностью 12% (яркость падает до 60%) | строка `accent` |

```js
const mouse = { x: 0, y: 0, tx: 0, ty: 0, amt: 0, on: false };
hero.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch") return;
  const r = hero.getBoundingClientRect();
  mouse.tx = e.clientX - r.left;
  mouse.ty = e.clientY - r.top;
  if (!mouse.on) {
    mouse.x = mouse.tx;
    mouse.y = mouse.ty;
  }
  mouse.on = true;
});
hero.addEventListener("pointerleave", () => {
  mouse.on = false;
});
const bands = [];
const G = new Float32Array(16);
function stepGlitch(dt) {
  if (playing && P.glitchOn && Math.random() < P.glitchRate * dt) {
    bands.push({
      y0: Math.floor(Math.random() * L.rows),
      h: 1 + Math.floor(Math.random() * 5),
      shift: Math.round((Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * P.glitchShift)),
      life: 0.06 + Math.random() * 0.16,
    });
    if (bands.length > 4) bands.shift();
  }
  for (let i = bands.length - 1; i >= 0; i--) {
    if (playing) bands[i].life -= dt;
    if (bands[i].life <= 0) bands.splice(i, 1);
  }
  G.fill(0);
  bands.forEach((b, i) => {
    G[i * 4] = b.y0;
    G[i * 4 + 1] = b.y0 + b.h;
    G[i * 4 + 2] = b.shift;
    G[i * 4 + 3] = 1;
  });
}
let visible = true;
new IntersectionObserver((es) => {
  visible = es[0].isIntersecting;
}).observe(hero);
function scrollProgress() {
  if (!P.scrollOn) return 0;
  const r = hero.getBoundingClientRect();
  return Math.min(1, Math.max(0, -r.top / (r.height * 0.85)));
}
let lastScroll = -1;
```

## 10. Постобработка и кадр

```js
function hexRGB(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h) || [0, "dbf150"];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function draw() {
  const sp = scrollProgress();
  // scene
  gl.bindFramebuffer(gl.FRAMEBUFFER, tScene.fb);
  gl.viewport(0, 0, L.fbW, L.fbH);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  const U = progCell.u;
  gl.useProgram(progCell.p);
  gl.uniform2f(U.uRes, L.fbW, L.fbH);
  gl.uniform1f(U.uCell, L.cell);
  gl.uniform2f(U.uGrid, L.cols, L.rows);
  gl.uniform1f(U.uTime, time);
  gl.uniform1f(U.uIntroT, introT);
  gl.uniform1f(U.uIntroDur, P.introDur);
  gl.uniform1f(U.uIntroOn, P.introOn && introT < P.introDur * 1.05 ? 1 : 0);
  gl.uniform2f(U.uMouse, mouse.x * L.k, mouse.y * L.k);
  gl.uniform1f(U.uMouseAmt, P.cursorOn ? mouse.amt : 0);
  gl.uniform1f(U.uRepelR, P.repelR * L.k);
  gl.uniform1f(U.uRepelK, P.repelK * L.k);
  gl.uniform4fv(U.uGlitch, G);
  gl.uniform1f(U.uScroll, sp);
  gl.uniform1f(U.uDrift, P.drift);
  gl.uniform1f(U.uDriftSpeed, P.driftSpeed);
  gl.uniform1f(U.uShimmer, playing ? P.shimmer : 0);
  gl.uniform1f(U.uN, ATL.n);
  gl.uniform1f(U.uJit, P.glyphJitter);
  gl.uniform4f(U.uAtl, ATL.gs, ATL.slot, ATL.w, ATL.h);
  const lc = hexRGB(P.lime);
  gl.uniform3f(U.uLime, lc[0], lc[1], lc[2]);
  gl.uniform1f(U.uGrayLo, P.grayLo);
  gl.uniform1f(U.uToneGamma, P.toneGamma);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.uniform1i(U.uAtlas, 0);
  gl.bindVertexArray(vao);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instCount);
  gl.disable(gl.BLEND);
  gl.bindVertexArray(emptyVao);
  // bloom
  gl.useProgram(progDown.p);
  gl.bindFramebuffer(gl.FRAMEBUFFER, tA.fb);
  gl.viewport(0, 0, tA.w, tA.h);
  gl.bindTexture(gl.TEXTURE_2D, tScene.t);
  gl.uniform1i(progDown.u.uTex, 0);
  gl.uniform2f(progDown.u.uTexel, 1 / L.fbW, 1 / L.fbH);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.useProgram(progBlur.p);
  gl.uniform1i(progBlur.u.uTex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, tB.fb);
  gl.bindTexture(gl.TEXTURE_2D, tA.t);
  gl.uniform2f(progBlur.u.uDir, P.bloomSpread / tA.w, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindFramebuffer(gl.FRAMEBUFFER, tA.fb);
  gl.bindTexture(gl.TEXTURE_2D, tB.t);
  gl.uniform2f(progBlur.u.uDir, 0, P.bloomSpread / tA.h);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // composite
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(progComp.p);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tScene.t);
  gl.uniform1i(progComp.u.uScene, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, tA.t);
  gl.uniform1i(progComp.u.uBloom, 1);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform2f(progComp.u.uTexel, 1 / L.fbW, 1 / L.fbH);
  gl.uniform1f(progComp.u.uBloomK, P.bloom);
  gl.uniform1f(progComp.u.uHBlur, P.hblur * L.k);
  gl.uniform1f(progComp.u.uScan, P.scan);
  gl.uniform1f(progComp.u.uExp, P.exposure);
  gl.uniform1f(progComp.u.uScanPitch, P.scanPitch * L.dpr);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
```

```js
let dirty = true,
  playing = !reduceMotion,
  time = 0,
  introT = reduceMotion ? 999 : 0,
  last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (playing && !document.hidden) {
    time += dt;
    introT += dt;
  }
  mouse.x += (mouse.tx - mouse.x) * 0.18;
  mouse.y += (mouse.ty - mouse.y) * 0.18;
  const ta = mouse.on ? 1 : 0;
  const pa = mouse.amt;
  mouse.amt += (ta - mouse.amt) * 0.08;
  if (Math.abs(mouse.amt - ta) < 0.002) mouse.amt = ta;
  stepGlitch(dt);
  const sp = scrollProgress();
  const changed =
    dirty ||
    playing ||
    Math.abs(pa - mouse.amt) > 1e-4 ||
    (mouse.on && P.cursorOn) ||
    sp !== lastScroll;
  if (visible && !document.hidden && changed) {
    draw();
    dirty = false;
    lastScroll = sp;
  }
  requestAnimationFrame(frame);
}
```

- Сцена: очистка в чёрный, смешивание `ONE, ONE_MINUS_SRC_ALPHA` (premultiplied), все инстансы одним вызовом.
- Свечение: 4 выборки → 1/4 размера; гауссово размытие 9 выборок по X, затем по Y, шаг `bloomSpread` текселей.
- Композит: сцена с горизонтальным смазом (0.25 / 0.5 / 0.25 со сдвигом `hblur` CSS px), плюс `bloom × свечение`, строки развёртки `1 − scan × (0.5 + 0.5 cos(2π y / (scanPitch × DPR)))`, затем `× exposure`.
- Кадр рисуется, только если шапка видна (`IntersectionObserver`), вкладка активна и что-то изменилось (`dirty`, идёт анимация, курсор, скролл). Время копится только в активной вкладке, шаг ограничен 50 мс.

## 11. Состояния, телефон, доступность

- **Нет WebGL2** или **`prefers-reduced-motion: reduce`** — вместо холста `<img src="hero-static-desktop.png">` с `object-fit: cover; object-position: right center`. Никаких анимаций.
- **Телефон** (< 900 px): высота холста `max(420px, 62svh)`, источник `cover` с привязкой вправо (лицо в кадре), клетка не меньше 4 px, курсор выключен (касания игнорируются), скролл-разлёт работает. Текст hero — под холстом.
- **Десктоп** (≥ 900 px): пропорции 2392:1240, `min-height: 560px`, текст hero поверх левых 40%.
- Холст `aria-hidden="true"`. H1 и кнопки рендерятся сервером и не ждут WebGL.

## 12. Перенос в React: на что обратить внимание

1. Клиентский компонент, без SSR (`dynamic(..., { ssr: false })` или проверка в `useEffect`).
2. **Строгий режим React** монтирует эффект дважды: весь WebGL создавать в эффекте и полностью убирать в cleanup — `cancelAnimationFrame`, отписка от `ResizeObserver`, `IntersectionObserver`, событий мыши и скролла, `gl.getExtension('WEBGL_lose_context')?.loseContext()`.
3. Потеря контекста (`webglcontextlost`): остановить кадр, при `webglcontextrestored` — пересоздать программы, буферы и атлас.
4. Настройки — неизменяемый объект из JSON; панель `?tune=1` (если делаешь) правит копию.
5. Источник грузить через `new Image()` + `decode()`; до загрузки шрифта и источника кадр не рисовать (холст чёрный — это совпадает с началом входа).
6. Все случайности сетки — только через `hash2`/`fbm`/`h1`/`h2`. `Math.random()` допустим только в `stepGlitch` (сбои и так случайны во времени).

## 13. Приёмка: как проверить, что вышло один в один

1. **Статичный кадр.** Playwright, viewport `1211×900` (с полосой прокрутки ширина шапки ≈ 1196 CSS px), `deviceScaleFactor: 2`, шрифт JetBrains Mono загружен. Заморозить время: `time = 12`, вход завершён, анимация на паузе, курсор вне шапки, скролл 0. Снять скриншот шапки и сравнить с `hero-static-desktop.png` (2390×1240): средняя абсолютная разница по яркости после уменьшения обоих в 4 раза — не больше 3 из 255. Для этого в не-продакшен сборке компонент принимает проп `freezeAt={{ time: 12, intro: 999 }}`.
2. **Анимации** — сравнить на глаз с прототипом бок о бок: вход (кадры 0.5, 1.2, 1.9 с), поток, сбои, курсор, скролл.
3. **Телефон** — 390×844: лицо в кадре, нет горизонтальной прокрутки, клетки не мельче 4 px.
4. **Заглушка** — с `prefers-reduced-motion: reduce` и с отключённым WebGL2 показывается статичный кадр.
5. **Производительность** — на ноутбуке стабильные 60 кадров в секунду; когда шапка вне экрана, рендер стоит (проверить в Performance-панели).
