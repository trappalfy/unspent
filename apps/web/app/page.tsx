import Link from "next/link";
import { publicEnv } from "@/lib/env";

// Landing placeholder; the full page with the AsciiHero arrives in stage 7 (brief 11.5).
export default function Home() {
  return (
    <section className="mx-auto flex max-w-[1280px] flex-col gap-6 px-4 py-24 md:px-8">
      <p className="text-sm text-mute">$ Tokenize your LLM credits into onchain assets.</p>
      <h1 className="text-2xl md:text-3xl">AI credits that stay yours.</h1>
      <p className="max-w-[60ch] font-sans text-lg text-mute">
        Buy Claude inference as a token on Solana. One credit is $1 of inference. Spend it through our API,
        hold it as long as you like, or sell what you don&apos;t use.
      </p>
      <div className="flex flex-wrap gap-3">
        {publicEnv.prelaunch ? (
          <span className="btn btn-primary" aria-disabled="true">
            Launching soon
          </span>
        ) : (
          <Link href="/app/buy" className="btn btn-primary">
            Get credits
          </Link>
        )}
        <Link href="/docs/quickstart" className="btn">
          Read the docs
        </Link>
      </div>
      <p className="text-xs text-mute">1 credit = $1 of inference · no expiry · settled onchain</p>
    </section>
  );
}
