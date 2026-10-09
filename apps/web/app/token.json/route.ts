import { publicEnv } from "@/lib/env";

// Off-chain JSON of the credit mint's Metaplex metadata (TOKEN_URI in ops/launch.ts). Name and symbol must match the
// onchain metadata, so the symbol comes from the same TOKEN_SYMBOL the launch used.
export const dynamic = "force-static";

export function GET() {
  return Response.json({
    name: "Unspent Credit",
    symbol: process.env.TOKEN_SYMBOL ?? "",
    description:
      "1 credit = $1 of AI inference through the Unspent API. Each credit in circulation is backed by 1 USDC in the program's reserve.",
    image: `${publicEnv.siteUrl}/token.png`,
    external_url: publicEnv.siteUrl,
  });
}
