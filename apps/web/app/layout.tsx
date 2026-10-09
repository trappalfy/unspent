import type { Metadata } from "next";
import { JetBrains_Mono, Onest } from "next/font/google";
import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { publicEnv } from "@/lib/env";
import "./globals.css";

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "800"],
  variable: "--font-jetbrains",
  display: "swap",
});
const onest = Onest({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-onest",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(publicEnv.siteUrl),
  title: { default: "Unspent — AI credits that stay yours", template: "%s · Unspent" },
  description: "Tokenize your LLM credits into onchain assets.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${jetbrains.variable} ${onest.variable}`}>
      <body className="flex min-h-svh flex-col">
        <Nav />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
