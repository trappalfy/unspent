import { GHOST } from "@/lib/ascii";

/** The ASCII ghost logo as text (brief 11.4): aria-hidden pre + hidden "Unspent". */
export function Ghost({ size = 3 }: { size?: number }) {
  return (
    <span className="inline-flex">
      <pre className="ascii" aria-hidden="true" style={{ fontSize: `${size}px` }}>
        {GHOST}
      </pre>
      <span className="sr-only">Unspent</span>
    </span>
  );
}
