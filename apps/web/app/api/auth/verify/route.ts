import { NextResponse } from "next/server";
import { startSession, takeSiwsCookie, verifyToken } from "@/lib/session";
import type { SiwsInput, SiwsProof } from "@/lib/siws";
import { verifySiwsProof } from "@/lib/siws-verify";

export async function POST(req: Request) {
  const issued = await verifyToken<{ input: SiwsInput }>(await takeSiwsCookie(), "siws");
  if (!issued) return NextResponse.json({ error: "Sign-in expired. Try again." }, { status: 401 });

  let proof: SiwsProof;
  try {
    proof = (await req.json()) as SiwsProof;
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  if (!verifySiwsProof(issued.input, proof)) {
    return NextResponse.json({ error: "Signature check failed. Try again." }, { status: 401 });
  }

  await startSession(proof.address);
  return NextResponse.json({ address: proof.address });
}
