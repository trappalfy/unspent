// Sign-In With Solana input shared by the server (issues and verifies) and the client (asks the wallet to sign).

export const SIWS_STATEMENT = "Sign in to Unspent. This does not send a transaction or cost any fees.";

export type SiwsInput = {
  domain: string;
  statement: string;
  uri: string;
  version: "1";
  chainId: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
};

/** Wire format of the wallet's sign-in output, base64-encoded for JSON. */
export type SiwsProof = {
  address: string;
  publicKey: string;
  signedMessage: string;
  signature: string;
};

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
