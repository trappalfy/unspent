"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { startHero } from "./engine";
import { heroSettings } from "./settings";

// The live ASCII hero (brief 11.3, ASCII_HERO.md). The copy is server-rendered children laid over the left 40% of the
// art on desktop and below it on phones; the canvas is decoration only (aria-hidden). Without WebGL2 or with reduced
// motion the approved static frame is shown instead.

type Mode = "loading" | "gl" | "static";

const GLYPH_FALLBACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Non-production acceptance hook (ASCII_HERO.md §13): `?freeze=12` renders one fixed frame with the intro finished;
 * `&intro=1.2` freezes a moment of the intro instead.
 */
function freezeFromUrl(): { time: number; intro: number } | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  const q = new URLSearchParams(window.location.search);
  const t = Number(q.get("freeze") ?? Number.NaN);
  const i = Number(q.get("intro") ?? 999);
  return Number.isFinite(t) && Number.isFinite(i) ? { time: t, intro: i } : undefined;
}

export function AsciiHero({
  src,
  fallbackSrc,
  fontFamily,
  children,
}: {
  src: string;
  fallbackSrc: string;
  /** next/font family name of JetBrains Mono (the 800 weight draws the glyph atlas). */
  fontFamily: string;
  children: ReactNode;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("loading");

  useEffect(() => {
    const section = sectionRef.current;
    const art = artRef.current;
    if (!section || !art) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setMode("static");
      return;
    }
    let cancelled = false;
    let engine: { destroy: () => void } | null = null;
    // A fresh canvas per mount: a context lost on unmount can't be reused (React strict mode mounts twice).
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    (async () => {
      const img = new Image();
      img.decoding = "async";
      img.src = src;
      await img.decode();
      try {
        await Promise.race([document.fonts.load(`800 48px ${fontFamily}`), sleep(2500)]);
      } catch {}
      if (cancelled) return;
      art.appendChild(canvas);
      engine = startHero({
        hero: art,
        pointerTarget: section,
        canvas,
        img,
        P: heroSettings,
        font: `${fontFamily}, ${GLYPH_FALLBACK}`,
        freezeAt: freezeFromUrl(),
      });
      if (!engine) {
        canvas.remove();
        setMode("static");
      } else setMode("gl");
    })().catch(() => {
      canvas.remove();
      if (!cancelled) setMode("static");
    });
    return () => {
      cancelled = true;
      engine?.destroy();
      canvas.remove();
    };
  }, [src, fontFamily]);

  return (
    <section ref={sectionRef} className="hero" aria-label="Unspent">
      <div ref={artRef} className="hero-art" data-mode={mode}>
        {/* biome-ignore lint/performance/noImgElement: the static frame must be a plain <img> fallback (brief 11.3) */}
        <img src={fallbackSrc} alt="" aria-hidden="true" loading="lazy" decoding="async" />
      </div>
      <div className="hero-copy">{children}</div>
    </section>
  );
}
