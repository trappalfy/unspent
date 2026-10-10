// Shared helpers for operational scripts (launch, local cycle). Keys live in keys/ (gitignored).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getAddressEncoder,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

import { getCreateMetadataV3Instruction } from "@unspent/program";

export {
  BPF_UPGRADEABLE_LOADER,
  decodeMetadata,
  decodeUpgradeAuthority,
  findMetadataAddress as metadataAddress,
  findProgramDataAddress as programDataAddress,
  METADATA_PROGRAM,
} from "@unspent/program";

export const ROOT = resolve(import.meta.dirname, "..");
export const USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const SYSVAR_RENT = address("SysvarRent111111111111111111111111111111111");
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing env ${name}`);
  return v;
}

export function connect(rpcUrl: string, wsUrl: string) {
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  async function send(feePayer: KeyPairSigner, ixs: Instruction[]): Promise<string> {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const tx = await signTransactionMessageWithSigners(msg);
    await sendAndConfirm(tx as Parameters<typeof sendAndConfirm>[0], { commitment: "confirmed" });
    return getSignatureFromTransaction(tx);
  }
  return { rpc, send };
}

/** Loads a Solana CLI JSON keypair. */
export async function loadKeypair(path: string): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(resolve(ROOT, path), "utf8"))));
}

/** Loads a keypair, creating and saving a new one if the file doesn't exist. */
export async function loadOrCreateKeypair(path: string): Promise<KeyPairSigner> {
  const full = resolve(ROOT, path);
  if (existsSync(full)) return loadKeypair(path);
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const bytes = [...seed, ...getAddressEncoder().encode(signer.address)];
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(bytes), { mode: 0o600 });
  return signer;
}

/** CreateMetadataAccountV3 for the credit mint (see @unspent/program metadata.ts). */
export const createMetadataV3Instruction = getCreateMetadataV3Instruction;

export function writeJson(path: string, value: unknown) {
  const full = resolve(ROOT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, path), "utf8")) as T;
}
