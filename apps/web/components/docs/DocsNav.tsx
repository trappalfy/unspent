"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOC_GROUPS, DOCS } from "@/lib/docs";

function List({ path }: { path: string }) {
  return (
    <div className="flex flex-col gap-6">
      {DOC_GROUPS.map((g) => (
        <div key={g.title} className="flex flex-col gap-2">
          <p className="text-xs text-mute">{g.title}</p>
          <ul className="flex flex-col gap-1 text-sm">
            {g.pages.map((d) => {
              const href = `/docs/${d.slug}`;
              const current = path === href;
              return (
                <li key={d.slug}>
                  <Link
                    href={href}
                    aria-current={current ? "page" : undefined}
                    className={`block py-1 ${current ? "text-fg underline underline-offset-4" : "text-fg/70 hover:text-fg"}`}
                  >
                    {d.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Sidebar on desktop, a collapsible menu above the page on phones. */
export function DocsNav() {
  const path = usePathname();
  const current = DOCS.find((d) => path === `/docs/${d.slug}`);
  return (
    <>
      {/* Remounted per page so it closes after navigation. */}
      <details key={path} className="docs-menu border border-line md:hidden">
        <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 text-sm">
          <span>
            Docs<span className="text-mute">{current ? ` / ${current.title}` : ""}</span>
          </span>
        </summary>
        <nav aria-label="Docs" className="border-t border-line p-4">
          <List path={path} />
        </nav>
      </details>
      <aside className="hidden w-52 shrink-0 md:block">
        <nav aria-label="Docs" className="sticky top-8">
          <List path={path} />
        </nav>
      </aside>
    </>
  );
}
