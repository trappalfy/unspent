// WebGL2 engine of the hero, ported 1:1 from brand/hero/hero-prototype.html (ASCII_HERO.md §4, §8–10): instanced
// glyph cells → scene FBO (fbScale) → quarter-size bloom (down, blur X, blur Y) → composite with horizontal smear,
// scanlines and exposure. All motion is in the vertex shader; the CPU only feeds uniforms each frame.
import { drawAtlas, sortRamp } from "./atlas";
import { buildInstances, computeLayout, type Layout, sampleSource } from "./build";
import type { HeroSettings } from "./settings";
import { BLUR_FS, CELL_FS, CELL_VS, COMP_FS, DOWN_FS, FS_VS } from "./shaders";

export type EngineOptions = {
  /** The art box: layout, cursor coordinates, scroll progress and visibility are measured on it. */
  hero: HTMLElement;
  /** Receives pointer events (the hero section, so text over the art doesn't block the cursor effect). */
  pointerTarget: HTMLElement;
  canvas: HTMLCanvasElement;
  img: HTMLImageElement;
  P: HeroSettings;
  /** Glyph font stack; with next/font this is the generated family name. */
  font: string;
  /** Non-production acceptance: a fixed frame (time, intro time) with animation paused (ASCII_HERO.md §13). */
  freezeAt?: { time: number; intro: number };
};

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
type Target = { t: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number };

function hexRGB(h: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(h) || [0, "dbf150"];
  const n = parseInt(m[1] as string, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Starts the hero; null when WebGL2 is unavailable (the caller shows the static frame). */
export function startHero(o: EngineOptions): { destroy: () => void } | null {
  const { hero, canvas, img, P, font } = o;
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: false,
    premultipliedAlpha: false,
    powerPreference: "high-performance",
  });
  if (!gl) return null;

  function shader(type: number, src: string) {
    const s = gl!.createShader(type)!;
    gl!.shaderSource(s, src);
    gl!.compileShader(s);
    if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(s) ?? "shader");
    return s;
  }
  function program(vs: string, fs: string): Prog {
    const p = gl!.createProgram()!;
    gl!.attachShader(p, shader(gl!.VERTEX_SHADER, vs));
    gl!.attachShader(p, shader(gl!.FRAGMENT_SHADER, fs));
    gl!.linkProgram(p);
    if (!gl!.getProgramParameter(p, gl!.LINK_STATUS)) throw new Error(gl!.getProgramInfoLog(p) ?? "link");
    const u: Prog["u"] = {};
    const n = gl!.getProgramParameter(p, gl!.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl!.getActiveUniform(p, i)!;
      u[info.name.replace(/\[0\]$/, "")] = gl!.getUniformLocation(p, info.name);
    }
    return { p, u };
  }
  function makeTarget(w: number, h: number): Target {
    const t = gl!.createTexture()!;
    gl!.bindTexture(gl!.TEXTURE_2D, t);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA8, w, h, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, null);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    const fb = gl!.createFramebuffer()!;
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fb);
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, t, 0);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    return { t, fb, w, h };
  }
  function freeTarget(x: Target | null) {
    if (!x) return;
    gl!.deleteTexture(x.t);
    gl!.deleteFramebuffer(x.fb);
  }

  // ---- GPU resources (recreated after a lost context) ----
  let progCell: Prog, progDown: Prog, progBlur: Prog, progComp: Prog;
  let emptyVao: WebGLVertexArrayObject, vao: WebGLVertexArrayObject, instBuf: WebGLBuffer;
  let atlasTex: WebGLTexture;
  let tScene: Target | null = null,
    tA: Target | null = null,
    tB: Target | null = null;
  let instCount = 0;
  let ATL = { gs: 8, slot: 10, w: 10, h: 10, n: 1 };
  let L: Layout = computeLayout(1, 1, 1, P).L;
  const sortedRamp = sortRamp(P, font);

  function initGpu() {
    progCell = program(CELL_VS, CELL_FS);
    progDown = program(FS_VS, DOWN_FS);
    progBlur = program(FS_VS, BLUR_FS);
    progComp = program(FS_VS, COMP_FS);
    emptyVao = gl!.createVertexArray()!;
    vao = gl!.createVertexArray()!;
    gl!.bindVertexArray(vao);
    const quadBuf = gl!.createBuffer();
    gl!.bindBuffer(gl!.ARRAY_BUFFER, quadBuf);
    gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl!.STATIC_DRAW);
    gl!.enableVertexAttribArray(0);
    gl!.vertexAttribPointer(0, 2, gl!.FLOAT, false, 0, 0);
    instBuf = gl!.createBuffer()!;
    gl!.bindBuffer(gl!.ARRAY_BUFFER, instBuf);
    gl!.enableVertexAttribArray(1);
    gl!.vertexAttribPointer(1, 4, gl!.FLOAT, false, 32, 0);
    gl!.vertexAttribDivisor(1, 1);
    gl!.enableVertexAttribArray(2);
    gl!.vertexAttribPointer(2, 4, gl!.FLOAT, false, 32, 16);
    gl!.vertexAttribDivisor(2, 1);
    gl!.bindVertexArray(null);
    atlasTex = gl!.createTexture()!;
    tScene = tA = tB = null;
  }

  function buildAtlas(cellPx: number) {
    const { canvas: c, meta } = drawAtlas(P, font, sortedRamp, cellPx);
    gl!.bindTexture(gl!.TEXTURE_2D, atlasTex);
    gl!.pixelStorei(gl!.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, c);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    ATL = meta;
  }

  function rebuild() {
    const data = sampleSource(L, img, P);
    const { buf, count } = buildInstances(data, L.cols, L.rows, P);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, instBuf);
    gl!.bufferData(gl!.ARRAY_BUFFER, buf, gl!.STATIC_DRAW);
    instCount = count;
    dirty = true;
  }

  function layout() {
    const r = hero.getBoundingClientRect();
    const {
      L: next,
      width,
      height,
    } = computeLayout(Math.max(1, r.width), Math.max(1, r.height), window.devicePixelRatio, P);
    L = next;
    canvas.width = width;
    canvas.height = height;
    freeTarget(tScene);
    freeTarget(tA);
    freeTarget(tB);
    tScene = makeTarget(L.fbW, L.fbH);
    const bw = Math.max(16, Math.round(L.fbW / 4)),
      bh = Math.max(16, Math.round(L.fbH / 4));
    tA = makeTarget(bw, bh);
    tB = makeTarget(bw, bh);
    buildAtlas(L.cell);
    rebuild();
    dirty = true;
  }

  // ---- interaction and time ----
  let dirty = true,
    playing = !o.freezeAt,
    time = o.freezeAt?.time ?? 0,
    introT = o.freezeAt?.intro ?? 0,
    last = performance.now();
  const mouse = { x: 0, y: 0, tx: 0, ty: 0, amt: 0, on: false };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const r = hero.getBoundingClientRect();
    mouse.tx = e.clientX - r.left;
    mouse.ty = e.clientY - r.top;
    if (!mouse.on) {
      mouse.x = mouse.tx;
      mouse.y = mouse.ty;
    }
    mouse.on = true;
  };
  const onLeave = () => {
    mouse.on = false;
  };
  o.pointerTarget.addEventListener("pointermove", onMove);
  o.pointerTarget.addEventListener("pointerleave", onLeave);

  const bands: { y0: number; h: number; shift: number; life: number }[] = [];
  const G = new Float32Array(16);
  function stepGlitch(dt: number) {
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
      if (playing) bands[i]!.life -= dt;
      if (bands[i]!.life <= 0) bands.splice(i, 1);
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
  const io = new IntersectionObserver((es) => {
    visible = !!es[0]?.isIntersecting;
  });
  io.observe(hero);
  function scrollProgress() {
    if (!P.scrollOn) return 0;
    const r = hero.getBoundingClientRect();
    return Math.min(1, Math.max(0, -r.top / (r.height * 0.85)));
  }
  let lastScroll = -1;
  const lime = hexRGB(P.lime);

  function draw() {
    const sp = scrollProgress();
    const g = gl!;
    // scene
    g.bindFramebuffer(g.FRAMEBUFFER, tScene!.fb);
    g.viewport(0, 0, L.fbW, L.fbH);
    g.clearColor(0, 0, 0, 1);
    g.clear(g.COLOR_BUFFER_BIT);
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    const U = progCell.u;
    g.useProgram(progCell.p);
    g.uniform2f(U.uRes!, L.fbW, L.fbH);
    g.uniform1f(U.uCell!, L.cell);
    g.uniform2f(U.uGrid!, L.cols, L.rows);
    g.uniform1f(U.uTime!, time);
    g.uniform1f(U.uIntroT!, introT);
    g.uniform1f(U.uIntroDur!, P.introDur);
    g.uniform1f(U.uIntroOn!, P.introOn && introT < P.introDur * 1.05 ? 1 : 0);
    g.uniform2f(U.uMouse!, mouse.x * L.k, mouse.y * L.k);
    g.uniform1f(U.uMouseAmt!, P.cursorOn ? mouse.amt : 0);
    g.uniform1f(U.uRepelR!, P.repelR * L.k);
    g.uniform1f(U.uRepelK!, P.repelK * L.k);
    g.uniform4fv(U.uGlitch!, G);
    g.uniform1f(U.uScroll!, sp);
    g.uniform1f(U.uDrift!, P.drift);
    g.uniform1f(U.uDriftSpeed!, P.driftSpeed);
    g.uniform1f(U.uShimmer!, playing ? P.shimmer : 0);
    g.uniform1f(U.uN!, ATL.n);
    g.uniform1f(U.uJit!, P.glyphJitter);
    g.uniform4f(U.uAtl!, ATL.gs, ATL.slot, ATL.w, ATL.h);
    g.uniform3f(U.uLime!, lime[0], lime[1], lime[2]);
    g.uniform1f(U.uGrayLo!, P.grayLo);
    g.uniform1f(U.uToneGamma!, P.toneGamma);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, atlasTex);
    g.uniform1i(U.uAtlas!, 0);
    g.bindVertexArray(vao);
    g.drawArraysInstanced(g.TRIANGLES, 0, 6, instCount);
    g.disable(g.BLEND);
    g.bindVertexArray(emptyVao);
    // bloom
    g.useProgram(progDown.p);
    g.bindFramebuffer(g.FRAMEBUFFER, tA!.fb);
    g.viewport(0, 0, tA!.w, tA!.h);
    g.bindTexture(g.TEXTURE_2D, tScene!.t);
    g.uniform1i(progDown.u.uTex!, 0);
    g.uniform2f(progDown.u.uTexel!, 1 / L.fbW, 1 / L.fbH);
    g.drawArrays(g.TRIANGLES, 0, 3);
    g.useProgram(progBlur.p);
    g.uniform1i(progBlur.u.uTex!, 0);
    g.bindFramebuffer(g.FRAMEBUFFER, tB!.fb);
    g.bindTexture(g.TEXTURE_2D, tA!.t);
    g.uniform2f(progBlur.u.uDir!, P.bloomSpread / tA!.w, 0);
    g.drawArrays(g.TRIANGLES, 0, 3);
    g.bindFramebuffer(g.FRAMEBUFFER, tA!.fb);
    g.bindTexture(g.TEXTURE_2D, tB!.t);
    g.uniform2f(progBlur.u.uDir!, 0, P.bloomSpread / tA!.h);
    g.drawArrays(g.TRIANGLES, 0, 3);
    // composite
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.viewport(0, 0, canvas.width, canvas.height);
    g.useProgram(progComp.p);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, tScene!.t);
    g.uniform1i(progComp.u.uScene!, 0);
    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_2D, tA!.t);
    g.uniform1i(progComp.u.uBloom!, 1);
    g.activeTexture(g.TEXTURE0);
    g.uniform2f(progComp.u.uTexel!, 1 / L.fbW, 1 / L.fbH);
    g.uniform1f(progComp.u.uBloomK!, P.bloom);
    g.uniform1f(progComp.u.uHBlur!, P.hblur * L.k);
    g.uniform1f(progComp.u.uScan!, P.scan);
    g.uniform1f(progComp.u.uExp!, P.exposure);
    g.uniform1f(progComp.u.uScanPitch!, P.scanPitch * L.dpr);
    g.drawArrays(g.TRIANGLES, 0, 3);
  }

  let raf = 0;
  let lost = false;
  function frame(now: number) {
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
      dirty || playing || Math.abs(pa - mouse.amt) > 1e-4 || (mouse.on && P.cursorOn) || sp !== lastScroll;
    if (!lost && visible && !document.hidden && changed) {
      draw();
      dirty = false;
      lastScroll = sp;
    }
    raf = requestAnimationFrame(frame);
  }

  let rsT: ReturnType<typeof setTimeout> | undefined;
  const ro = new ResizeObserver(() => {
    clearTimeout(rsT);
    rsT = setTimeout(() => !lost && layout(), 120);
  });

  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
  };
  const onRestored = () => {
    initGpu();
    layout();
    lost = false;
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  initGpu();
  layout();
  ro.observe(hero);
  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      clearTimeout(rsT);
      ro.disconnect();
      io.disconnect();
      o.pointerTarget.removeEventListener("pointermove", onMove);
      o.pointerTarget.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
