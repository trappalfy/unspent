// Shared helpers for operational scripts (launch, local cycle). Keys live in keys/ (gitignored).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getAddressEncoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

export const ROOT = resolve(import.meta.dirname, "..");
export const USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const METADATA_PROGRAM = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
export const BPF_UPGRADEABLE_LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
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

export async function programDataAddress(program: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: BPF_UPGRADEABLE_LOADER,
    seeds: [getAddressEncoder().encode(program)],
  });
  return pda;
}

export async function metadataAddress(mint: Address): Promise<Address> {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: METADATA_PROGRAM,
    seeds: [new TextEncoder().encode("metadata"), enc.encode(METADATA_PROGRAM), enc.encode(mint)],
  });
  return pda;
}

function borshString(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + b.length);
  new DataView(out.buffer).setUint32(0, b.length, true);
  out.set(b, 4);
  return out;
}

/**
 * Metaplex Token Metadata CreateMetadataAccountV3 (discriminator 33) for a fungible SPL token:
 * no creators, collection or uses; mutable so the update authority (admin multisig) can fix the URI later.
 */
export async function createMetadataV3Instruction(p: {
  mint: Address;
  mintAuthority: KeyPairSigner;
  payer: KeyPairSigner;
  updateAuthority: Address;
  name: string;
  symbol: string;
  uri: string;
}): Promise<Instruction> {
  const parts = [
    Uint8Array.of(33),
    borshString(p.name),
    borshString(p.symbol),
    borshString(p.uri),
    Uint8Array.of(0, 0), // seller_fee_basis_points: u16 = 0
    Uint8Array.of(0, 0, 0), // creators, collection, uses: None
    Uint8Array.of(1), // is_mutable
    Uint8Array.of(0), // collection_details: None
  ];
  const data = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    data.set(x, o);
    o += x.length;
  }
  return {
    programAddress: METADATA_PROGRAM,
    accounts: [
      { address: await metadataAddress(p.mint), role: AccountRole.WRITABLE },
      { address: p.mint, role: AccountRole.READONLY },
      { address: p.mintAuthority.address, role: AccountRole.READONLY_SIGNER, signer: p.mintAuthority },
      { address: p.payer.address, role: AccountRole.WRITABLE_SIGNER, signer: p.payer },
      { address: p.updateAuthority, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: SYSVAR_RENT, role: AccountRole.READONLY },
    ],
    data,
  } as Instruction;
}

export function writeJson(path: string, value: unknown) {
  const full = resolve(ROOT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, path), "utf8")) as T;
}
