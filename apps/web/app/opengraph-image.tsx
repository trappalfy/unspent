import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

// OG image 1200×630 (brief 11.8): the hero frame on the right, the brand line over its empty left side.

export const alt = "Unspent: AI credits that stay yours.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// hero-static-desktop.png is 2390×1240; scaled to the image height it spans the full width.
const ART_W = Math.round((630 * 2390) / 1240);

export default async function OpengraphImage() {
  const [art, mono400, mono800] = await Promise.all([
    readFile(join(process.cwd(), "public/hero/hero-static-desktop.png")),
    readFile(join(process.cwd(), "assets/jetbrains-mono-latin-400-normal.woff")),
    readFile(join(process.cwd(), "assets/jetbrains-mono-latin-800-normal.woff")),
  ]);
  return new ImageResponse(
    <div style={{ display: "flex", width: "100%", height: "100%", background: "#000", position: "relative" }}>
      {/* biome-ignore lint/performance/noImgElement: rendered by ImageResponse, not the browser */}
      <img
        alt=""
        src={`data:image/png;base64,${art.toString("base64")}`}
        width={ART_W}
        height={630}
        style={{ position: "absolute", top: 0, right: 0 }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 1200,
          height: 630,
          display: "flex",
          backgroundImage: "linear-gradient(to right, #000 0%, #000 42%, rgba(0,0,0,0) 62%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 64,
          top: 0,
          bottom: 0,
          width: 500,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 28,
          fontFamily: "JetBrains Mono",
          color: "#f5f5f5",
        }}
      >
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "0.02em" }}>UNSPENT</div>
        <div style={{ fontSize: 58, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.08 }}>
          AI credits that stay yours.
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: 20,
            color: "#777777",
            lineHeight: 1.4,
          }}
        >
          <span>1 credit = $1 of inference</span>
          <span>no expiry · settled onchain</span>
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "JetBrains Mono", data: mono400, weight: 400, style: "normal" },
        { name: "JetBrains Mono", data: mono800, weight: 800, style: "normal" },
      ],
    },
  );
}
