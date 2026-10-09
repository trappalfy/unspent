"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function AppNav({ links }: { links: [string, string][] }) {
  const path = usePathname();
  return (
    <nav className="-mx-4 flex gap-5 overflow-x-auto px-4 text-sm md:mx-0 md:px-0" aria-label="App">
      {links.map(([href, label]) => {
        const active = href === "/app" ? path === "/app" : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`whitespace-nowrap py-1 ${active ? "text-fg underline underline-offset-4" : "text-mute hover:text-fg"}`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
