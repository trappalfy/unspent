"use client";

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <section className="flex flex-col items-start gap-4 py-16">
      <h1 className="text-xl">Couldn&apos;t load this page</h1>
      <p className="text-sm text-mute">
        The network or our servers didn&apos;t answer. Your funds are not affected.
      </p>
      <button type="button" className="btn" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
