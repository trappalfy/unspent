import { formatCredits } from "@unspent/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import { AsciiHero } from "@/components/ascii-hero/AsciiHero";
import { CodeTabs } from "@/components/landing/CodeTabs";
import { Faq } from "@/components/landing/Faq";
import { LogsBackdrop } from "@/components/landing/LogsBackdrop";
import { PricingTable } from "@/components/landing/PricingTable";
import { Roll } from "@/components/Roll";
import { apiBase, explorerTx, publicEnv } from "@/lib/env";
import { jetbrains } from "@/lib/fonts";
import { landingStats, ttlWords } from "@/lib/server/landing";

// Landing (brief 11.5). Texts are final; numbers come from the program and the indexer, refreshed every 30 s.
export const revalidate = 30;

function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[1280px] px-4 md:px-8 ${className}`}>{children}</div>;
}

function H2({ children }: { children: ReactNode }) {
  return <h2 className="text-xl font-extrabold tracking-tight md:text-2xl">{children}</h2>;
}

function Cta() {
  return publicEnv.prelaunch ? (
    <>
      <span className="btn btn-primary" aria-disabled="true">
        Launching soon
      </span>
      {publicEnv.xUrl && (
        <a className="btn" href={publicEnv.xUrl}>
          Follow on X
        </a>
      )}
    </>
  ) : (
    <Link href="/app/buy" className="btn btn-primary">
      Get credits
    </Link>
  );
}

function coverage(reserve: bigint, supply: bigint): string {
  if (supply === 0n) return "—";
  const bp = (reserve * 10_000n) / supply;
  return `${bp / 100n}.${String(bp % 100n).padStart(2, "0")}%`;
}

function Figure({ label, value, children }: { label: string; value?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border border-line p-4">
      <span className="text-xs text-mute">{label}</span>
      <span className="text-lg font-medium">{value !== undefined ? <Roll text={value} /> : children}</span>
    </div>
  );
}

export default async function Home() {
  const stats = await landingStats();
  const ttl = stats ? ttlWords(stats.program.reservationTtl) : "an hour";

  return (
    <>
      <AsciiHero
        src="/hero/hero-source-1600.webp"
        fallbackSrc="/hero/hero-static-desktop.png"
        fontFamily={jetbrains.style.fontFamily}
      >
        <Container>
          <div className="hero-copy-inner flex flex-col gap-5 py-10 min-[900px]:py-0">
            <p className="text-sm text-mute">
              $ Tokenize your LLM credits into onchain assets.<span className="caret">█</span>
            </p>
            <h1 className="text-xl min-[900px]:text-2xl min-[1440px]:text-3xl">
              AI credits that stay yours.
            </h1>
            <p className="max-w-[46ch] font-sans text-base text-fg/80 md:text-lg">
              Buy Claude inference as a token on Solana. One credit is $1 of inference. Spend it through our
              API, hold it as long as you like, or sell what you don&apos;t use.
            </p>
            <div className="flex flex-wrap gap-3">
              <Cta />
              <Link href="/docs/quickstart" className="btn">
                Read the docs
              </Link>
            </div>
            <p className="text-xs text-mute">1 credit = $1 of inference · no expiry · settled onchain</p>
          </div>
        </Container>
      </AsciiHero>

      <section className="relative overflow-hidden border-t border-line py-24 md:py-32">
        <LogsBackdrop />
        <Container className="relative">
          <div className="flex max-w-2xl flex-col gap-5 bg-bg/70 py-2">
            <H2>Prepaid credits are stuck where you bought them.</H2>
            <p className="font-sans text-lg text-fg/80">
              API credits live on one account. You can&apos;t move them to a teammate, you can&apos;t take
              them to another project, and you can&apos;t sell the part you won&apos;t use. Some providers let
              them expire.
            </p>
          </div>
        </Container>
      </section>

      <section className="border-t border-line py-20" aria-labelledby="how">
        <Container className="flex flex-col gap-10">
          <h2 id="how" className="text-xl font-extrabold tracking-tight md:text-2xl">
            How it works
          </h2>
          <ol className="grid grid-cols-1 gap-px border border-line bg-line md:grid-cols-3">
            {(
              [
                [
                  "Buy.",
                  "Pay 1 USDC, receive 1 credit. Or pay with any token in your wallet: it's swapped to USDC in the same transaction. The USDC stays in an onchain reserve until that credit is spent.",
                ],
                [
                  "Spend.",
                  "Deposit credits to your API balance, create a key, and point the Anthropic or OpenAI SDK at Unspent. Every request reserves its worst-case cost onchain, then burns only what it actually used.",
                ],
                [
                  "Keep, send, or sell.",
                  "Withdraw what you didn't use. It's a standard SPL token: hold it, send it to someone, or sell it on a DEX.",
                ],
              ] as const
            ).map(([title, text], i) => (
              <li key={title} className="flex flex-col gap-3 bg-bg p-6">
                <span className="text-xs text-mute">0{i + 1}</span>
                <h3 className="text-lg font-medium">{title}</h3>
                <p className="font-sans text-base text-fg/80">{text}</p>
              </li>
            ))}
          </ol>
        </Container>
      </section>

      <section className="border-t border-line py-20" aria-label="Code">
        <Container className="flex flex-col gap-4">
          <CodeTabs apiBase={apiBase} />
          <p className="text-sm text-mute">
            Same SDKs, one base URL. Your requests and responses are not stored.
          </p>
        </Container>
      </section>

      <section id="pricing" className="scroll-mt-20 border-t border-line py-20">
        <Container className="flex flex-col gap-6">
          <H2>Pricing</H2>
          <p className="text-sm text-mute">Credits per 1M tokens.</p>
          <PricingTable />
          <p className="text-sm text-mute">
            1 credit = $1. Prices include our margin and follow the provider&apos;s list prices.
          </p>
        </Container>
      </section>

      <section className="border-t border-line py-20">
        <Container className="flex flex-col gap-8">
          <div className="flex max-w-2xl flex-col gap-4">
            <H2>Every credit is backed by 1 USDC.</H2>
            <p className="font-sans text-lg text-fg/80">
              The USDC from every purchase sits in the program&apos;s reserve. It leaves the reserve when a
              credit is burned for inference. Every request is settled onchain, and anyone can check it on
              Solana.
            </p>
          </div>
          {stats && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
              <Figure label="credits in circulation" value={formatCredits(stats.program.supply, 2)} />
              <Figure label="USDC in reserve" value={formatCredits(stats.reserveUsdc, 2)} />
              <Figure label="coverage" value={coverage(stats.reserveUsdc, stats.program.supply)} />
              <Figure label="credits spent" value={formatCredits(stats.program.totalBurned, 2)} />
              <Figure label="last settlement">
                {stats.last ? (
                  <a
                    className="underline"
                    href={explorerTx(stats.last.signature)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {stats.last.blockTime
                      ? `${stats.last.blockTime.toISOString().slice(11, 16)} UTC`
                      : "view"}
                  </a>
                ) : (
                  "—"
                )}
              </Figure>
              <Figure
                label="requests settled in the last 24h"
                value={stats.settled24h === null ? "—" : stats.settled24h.toLocaleString("en-US")}
              />
            </div>
          )}
          <Link href="/reserve" className="self-start underline underline-offset-4">
            View the reserve →
          </Link>
        </Container>
      </section>

      <section className="border-t border-line py-20">
        <Container className="flex max-w-2xl flex-col gap-4 md:max-w-[1280px]">
          <H2>Withdraw any time.</H2>
          <p className="max-w-2xl font-sans text-lg text-fg/80">
            Your API balance sits in a program vault, not in our wallet. Anything not held for a running
            request is yours to withdraw instantly, no approval needed. If a request stalls, its hold can be
            released by anyone after {ttl}. If Unspent ever shuts down, every credit can be redeemed for 1
            USDC from the reserve.
          </p>
        </Container>
      </section>

      <section className="border-t border-line py-20" aria-labelledby="faq">
        <Container className="flex flex-col gap-8">
          <h2 id="faq" className="text-xl font-extrabold tracking-tight md:text-2xl">
            FAQ
          </h2>
          <Faq />
          <div className="flex flex-wrap gap-3">
            <Cta />
            <Link href="/docs/quickstart" className="btn">
              Read the docs
            </Link>
          </div>
        </Container>
      </section>
    </>
  );
}
