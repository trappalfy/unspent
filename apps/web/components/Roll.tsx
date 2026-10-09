"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// A figure that "rolls" into place character by character the first time it appears (brief 11.4). Server HTML has
// the final value; reduced motion keeps it static. Later value changes (auto-refresh) show directly.

const useIso = typeof window === "undefined" ? useEffect : useLayoutEffect;
const DURATION_MS = 700;

function scramble(text: string, revealed: number): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    out += i < revealed || !/\d/.test(ch) ? ch : String(Math.floor(Math.random() * 10));
  }
  return out;
}

export function Roll({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const done = useRef(false);
  const [shown, setShown] = useState(text);

  useIso(() => {
    if (done.current) {
      setShown(text);
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      done.current = true;
      return;
    }
    setShown(scramble(text, 0));
    let raf = 0;
    const io = new IntersectionObserver((es) => {
      if (!es[0]?.isIntersecting) return;
      io.disconnect();
      const start = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - start) / DURATION_MS);
        setShown(scramble(text, Math.floor(k * text.length)));
        if (k < 1) raf = requestAnimationFrame(step);
        else {
          done.current = true;
          setShown(text);
        }
      };
      raf = requestAnimationFrame(step);
    });
    if (ref.current) io.observe(ref.current);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
      if (!done.current) setShown(text);
    };
  }, [text]);

  return (
    <span ref={ref} className="tabular-nums">
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{shown}</span>
    </span>
  );
}
