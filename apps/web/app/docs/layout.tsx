import type { ReactNode } from "react";
import { DocsNav } from "@/components/docs/DocsNav";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-8 px-4 py-8 md:flex-row md:gap-14 md:px-8 md:py-16">
      <DocsNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
