import { WORDMARK } from "@/lib/ascii";

export default function NotFound() {
  return (
    <section className="mx-auto flex max-w-[1280px] flex-col gap-8 overflow-hidden px-4 py-24 md:px-8">
      <pre className="ascii text-[5px] sm:text-[8px]" aria-hidden="true">
        {WORDMARK}
      </pre>
      <h1 className="text-lg font-medium">{`{"credits_left": 0, "page": null}`}</h1>
    </section>
  );
}
