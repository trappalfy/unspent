import { WORDMARK } from "@/lib/ascii";

/** The ASCII wordmark as text (brief 11.4 style): aria-hidden pre + hidden "Unspent". Size via a font-size class. */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className="inline-flex">
      <pre className={`ascii ${className}`} aria-hidden="true">
        {WORDMARK}
      </pre>
      <span className="sr-only">Unspent</span>
    </span>
  );
}
