// Shared by the browser e2e scripts: polling, Surfpool cheatcodes, and the Wallet Standard test wallet.

import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(
  label: string,
  f: () => Promise<T | null | undefined | false>,
  ms = 60_000,
): Promise<T> {
  const t = Date.now();
  for (;;) {
    const v = await f().catch(() => null);
    if (v) return v;
    if (Date.now() - t > ms) throw new Error(`timed out: ${label}`);
    await sleep(500);
  }
}
export async function cheat(method: string, params: unknown[], rpc = "http://127.0.0.1:8899") {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const b = (await r.json()) as { error?: unknown };
  if (b.error) throw new Error(JSON.stringify(b.error));
}

// ---- the test wallet, injected into every page (Wallet Standard registration protocol) ----
export function installWallet(arg: { address: string; publicKey: number[]; pkcs8: number[]; chain: string }) {
  const pk = new Uint8Array(arg.publicKey);
  let keyP: Promise<CryptoKey> | null = null;
  const key = () => {
    keyP ??= crypto.subtle.importKey("pkcs8", new Uint8Array(arg.pkcs8), { name: "Ed25519" }, false, [
      "sign",
    ]);
    return keyP;
  };
  const sign = async (msg: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign("Ed25519", await key(), msg as Uint8Array<ArrayBuffer>));
  const account = {
    address: arg.address,
    publicKey: pk,
    chains: [arg.chain],
    features: ["solana:signTransaction", "solana:signMessage"],
    label: "Test",
  };
  const w = window as unknown as { __signed: number };
  w.__signed = 0;
  const wallet = {
    version: "1.0.0",
    name: "Test Wallet",
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
    chains: [arg.chain],
    accounts: [account],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => {} },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: async (...inputs: { message: Uint8Array }[]) =>
          Promise.all(
            inputs.map(async (i) => ({ signedMessage: i.message, signature: await sign(i.message) })),
          ),
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
          Promise.all(
            inputs.map(async (i) => {
              const tx = new Uint8Array(i.transaction);
              const n = tx[0]!;
              tx.set(await sign(tx.slice(1 + 64 * n)), 1);
              w.__signed++;
              return { signedTransaction: tx };
            }),
          ),
      },
    },
  };
  const register = (api: { register: (w: unknown) => void }) => api.register(wallet);
  window.addEventListener("wallet-standard:app-ready", (e) => register((e as CustomEvent).detail));
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
}

/** A Solana CLI keypair file as the test wallet's key material (PKCS#8 for WebCrypto Ed25519). */
export async function walletFromKeypairFile(path: string) {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  const signer = await createKeyPairSignerFromBytes(bytes);
  const pkcs8 = [...Buffer.from("302e020100300506032b657004220420", "hex"), ...bytes.subarray(0, 32)];
  return { address: signer.address, publicKey: [...bytes.subarray(32)], pkcs8 };
}
