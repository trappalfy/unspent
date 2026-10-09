import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not available in your region", robots: { index: false } };

export default function Unavailable() {
  return (
    <section className="mx-auto flex max-w-[1280px] flex-col items-start gap-4 px-4 py-24 md:px-8">
      <h1 className="text-xl">Not available in your region</h1>
      <p className="max-w-[60ch] font-sans text-fg/80">
        Unspent is available only in the countries and regions where its model provider&apos;s services are
        available.
      </p>
      <Link href="/docs" className="underline underline-offset-4">
        Read the docs
      </Link>
    </section>
  );
}
