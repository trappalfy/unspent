import { getAddressDecoder } from "@solana/kit";
import { createSignInMessageText } from "@solana/wallet-standard-util";
import { describe, expect, it } from "vitest";
import { SIWS_STATEMENT, type SiwsInput, type SiwsProof, toBase64 } from "../lib/siws";
import { verifySiwsProof } from "../lib/siws-verify";

async function wallet() {
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const address = getAddressDecoder().decode(publicKey);
  const sign = async (msg: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, msg as BufferSource));
  return { publicKey, address, sign };
}

const issued: SiwsInput = {
  domain: "unspent.test",
  statement: SIWS_STATEMENT,
  uri: "https://unspent.test",
  version: "1",
  chainId: "devnet",
  nonce: "abc123def456",
  issuedAt: "2026-10-09T12:00:00.000Z",
  expirationTime: "2026-10-09T12:10:00.000Z",
};
const NOW = Date.parse("2026-10-09T12:01:00.000Z");

async function proofFor(
  w: Awaited<ReturnType<typeof wallet>>,
  input: SiwsInput,
  address = w.address,
): Promise<SiwsProof> {
  const msg = new TextEncoder().encode(createSignInMessageText({ ...input, address }));
  return {
    address,
    publicKey: toBase64(w.publicKey),
    signedMessage: toBase64(msg),
    signature: toBase64(await w.sign(msg)),
  };
}

describe("SIWS proof verification", () => {
  it("accepts a valid proof", async () => {
    const w = await wallet();
    expect(verifySiwsProof(issued, await proofFor(w, issued), NOW)).toBe(true);
  });

  it("rejects a different nonce, domain or chain", async () => {
    const w = await wallet();
    for (const patch of [{ nonce: "other" }, { domain: "evil.test" }, { chainId: "mainnet" }]) {
      expect(verifySiwsProof(issued, await proofFor(w, { ...issued, ...patch }), NOW)).toBe(false);
    }
  });

  it("rejects an address that doesn't match the signing key", async () => {
    const w = await wallet();
    const other = await wallet();
    const p = await proofFor(w, issued, other.address);
    expect(verifySiwsProof(issued, p, NOW)).toBe(false);
  });

  it("rejects a tampered signature and an expired input", async () => {
    const w = await wallet();
    const p = await proofFor(w, issued);
    const sig = Uint8Array.from(atob(p.signature), (c) => c.charCodeAt(0));
    sig[0]! ^= 1;
    expect(verifySiwsProof(issued, { ...p, signature: toBase64(sig) }, NOW)).toBe(false);
    expect(verifySiwsProof(issued, p, Date.parse("2026-10-09T12:11:00.000Z"))).toBe(false);
  });
});
