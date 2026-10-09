import Link from "next/link";
import { publicEnv } from "@/lib/env";
import { CopyButton } from "./CopyButton";
import { Ghost } from "./Ghost";

export function Footer() {
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-6 px-4 py-10 text-sm text-mute md:px-8">
        <Ghost size={4} />
        <nav className="flex flex-wrap gap-x-5 gap-y-2 text-fg">
          <Link href="/docs">Docs</Link>
          <Link href="/#pricing">Pricing</Link>
          <Link href="/reserve">Reserve</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          {publicEnv.xUrl && <a href={publicEnv.xUrl}>X</a>}
        </nav>
        <p>Unspent is not affiliated with Anthropic. Claude is a trademark of Anthropic, PBC.</p>
        {publicEnv.projectTokenCa && (
          <p className="flex flex-wrap items-center gap-3">
            <span className="break-all">CA: {publicEnv.projectTokenCa}</span>
            <CopyButton value={publicEnv.projectTokenCa} />
          </p>
        )}
      </div>
    </footer>
  );
}
