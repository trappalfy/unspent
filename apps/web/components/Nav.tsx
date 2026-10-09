import Link from "next/link";
import { publicEnv } from "@/lib/env";
import { Wordmark } from "./Wordmark";

export function Nav() {
  return (
    <header className="border-b border-line">
      <nav className="mx-auto flex max-w-[1280px] items-center justify-between gap-6 px-4 py-3 md:px-8">
        <Link href="/" className="flex shrink-0 items-center py-1">
          <Wordmark className="text-[2.3px] sm:text-[3.4px] lg:text-[5px]" />
        </Link>
        <div className="flex items-center gap-5 text-sm">
          <Link href="/#pricing" className="hidden sm:inline">
            Pricing
          </Link>
          <Link href="/docs">Docs</Link>
          <Link href="/reserve" className="hidden sm:inline">
            Reserve
          </Link>
          {publicEnv.prelaunch ? (
            <span className="btn btn-primary min-h-9" aria-disabled="true">
              Launching soon
            </span>
          ) : (
            <Link href="/app/buy" className="btn btn-primary min-h-9">
              Get credits
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}
