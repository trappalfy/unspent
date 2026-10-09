# Unspent brand kit

Read UNSPENT_BRIEF.md sections 2.2, 11.3 and 11.4 for how each file is used.

- logo/unspent-logo-white-1376.png — ASCII ghost, white on black (favicon, avatar, loader)
- logo/unspent-ghost.txt — the ghost as text; render in <pre>, never as an image on the site
- wordmark/unspent-wordmark.txt — ASCII wordmark UNSPENT; render in <pre>
- wordmark/unspent-wordmark-preview.png — preview only
- banner/unspent-x-banner-1500x500.png — X banner; style reference and OG source
- logs/usage-log-sample.txt — JSON usage log lines for the scrolling background
- hero/hero-source.png — header source image, 2392x1240, made for the owner (rights cleared)
- hero/hero-source-1600.webp — the same image for production
- hero/hero-settings.json — approved header settings; do not change
- hero/hero-prototype.html — working WebGL2 prototype; reference implementation for the AsciiHero module (open in a browser; the tuning panel is visible there)
- hero/hero-static-desktop.png — still frame for no-WebGL2 and reduced-motion fallback, and OG

Fonts: JetBrains Mono (400, 500, 800) and Onest (400, 500, 600) from Google Fonts via next/font/google.
Colors: #000000 background, #F5F5F5 text, #6B6B6B secondary. Lime #DBF150 appears only inside the header art.
