"use client";

export default function SiteError({ reset }: { error: Error; reset: () => void }) {
  return (
    <section className="mx-auto flex max-w-[1280px] flex-col items-start gap-4 px-4 py-24 md:px-8">
      <h1 className="text-xl">Couldn&apos;t load this page</h1>
      <p className="text-sm text-mute">
        The network or our servers didn&apos;t answer. Try again in a moment.
      </p>
      <button type="button" className="btn" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
