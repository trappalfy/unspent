import type { SolanaSignInInput } from "@solana/wallet-standard-features";
import { verifySignIn } from "@solana/wallet-standard-util";
import { fromBase64, type SiwsInput, type SiwsProof } from "./siws";

/** Checks a wallet's sign-in proof against the input the server issued: every field, address ↔ key, ed25519 signature, expiry. */
export function verifySiwsProof(issued: SiwsInput, proof: SiwsProof, now = Date.now()): boolean {
  if (Date.parse(issued.expirationTime) < now) return false;
  const input: SolanaSignInInput = { ...issued, address: proof.address };
  try {
    return verifySignIn(input, {
      account: { address: proof.address, publicKey: fromBase64(proof.publicKey), chains: [], features: [] },
      signedMessage: fromBase64(proof.signedMessage),
      signature: fromBase64(proof.signature),
    });
  } catch {
    return false;
  }
}
