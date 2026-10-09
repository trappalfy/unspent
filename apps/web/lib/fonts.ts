import { JetBrains_Mono, Onest } from "next/font/google";

// Fonts (brief 11.2). The hero's glyph atlas needs JetBrains Mono 800 by its generated family name.
export const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "800"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const onest = Onest({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-onest",
  display: "swap",
});
