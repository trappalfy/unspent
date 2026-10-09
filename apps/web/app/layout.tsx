import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { publicEnv } from "@/lib/env";
import { jetbrains, onest } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(publicEnv.siteUrl),
  title: { default: "Unspent — AI credits that stay yours", template: "%s · Unspent" },
  description: "Tokenize your LLM credits into onchain assets.",
  openGraph: { siteName: "Unspent", type: "website" },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${jetbrains.variable} ${onest.variable}`}>
      <body className="flex min-h-svh flex-col">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <Nav />
        <main id="main" tabIndex={-1} className="flex-1 outline-none">
          {children}
        </main>
        <Footer />
      </body>
    </html>
  );
}
