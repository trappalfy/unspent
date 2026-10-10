// Metaplex Token Metadata for the credit mint: create it at launch, change name / symbol / URI later with the update
// authority (the admin wallet), and read it back. Owner, 2026-10-10: the token runs as "Test Credit" with an empty URI
// while the app is tested on mainnet, and gets its real name, symbol and URI on launch day.

import {
  AccountRole,
  type Address,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";

export const METADATA_PROGRAM = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const SYSVAR_RENT = address("SysvarRent111111111111111111111111111111111");
/** Metaplex limits, in bytes. */
export const METADATA_LIMITS = { name: 32, symbol: 10, uri: 200 } as const;

export type TokenMetadata = {
  updateAuthority: Address;
  mint: Address;
  name: string;
  symbol: string;
  uri: string;
};

export async function findMetadataAddress(mint: Address): Promise<Address> {
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

function concat(parts: Uint8Array[]): Uint8Array {
  const data = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    data.set(x, o);
    o += x.length;
  }
  return data;
}

/** DataV2 without creators, collection or uses, and no seller fee. */
function dataV2(p: { name: string; symbol: string; uri: string }): Uint8Array {
  for (const k of ["name", "symbol", "uri"] as const)
    if (new TextEncoder().encode(p[k]).length > METADATA_LIMITS[k])
      throw new Error(`Token ${k} is longer than ${METADATA_LIMITS[k]} bytes.`);
  return concat([
    borshString(p.name),
    borshString(p.symbol),
    borshString(p.uri),
    Uint8Array.of(0, 0), // seller_fee_basis_points: u16 = 0
    Uint8Array.of(0, 0, 0), // creators, collection, uses: None
  ]);
}

/** CreateMetadataAccountV3 (33) for a fungible SPL token, mutable so the update authority can change it later. */
export async function getCreateMetadataV3Instruction(p: {
  mint: Address;
  mintAuthority: TransactionSigner;
  payer: TransactionSigner;
  updateAuthority: Address;
  name: string;
  symbol: string;
  uri: string;
}): Promise<Instruction> {
  return {
    programAddress: METADATA_PROGRAM,
    accounts: [
      { address: await findMetadataAddress(p.mint), role: AccountRole.WRITABLE },
      { address: p.mint, role: AccountRole.READONLY },
      { address: p.mintAuthority.address, role: AccountRole.READONLY_SIGNER, signer: p.mintAuthority },
      { address: p.payer.address, role: AccountRole.WRITABLE_SIGNER, signer: p.payer },
      { address: p.updateAuthority, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: SYSVAR_RENT, role: AccountRole.READONLY },
    ],
    // is_mutable = true, collection_details = None
    data: concat([Uint8Array.of(33), dataV2(p), Uint8Array.of(1, 0)]),
  } as Instruction;
}

/** UpdateMetadataAccountV2 (15): new name, symbol and URI; the update authority and mutability stay as they are. */
export async function getUpdateMetadataInstruction(p: {
  mint: Address;
  updateAuthority: TransactionSigner;
  name: string;
  symbol: string;
  uri: string;
}): Promise<Instruction> {
  return {
    programAddress: METADATA_PROGRAM,
    accounts: [
      { address: await findMetadataAddress(p.mint), role: AccountRole.WRITABLE },
      { address: p.updateAuthority.address, role: AccountRole.READONLY_SIGNER, signer: p.updateAuthority },
    ],
    // Some(DataV2), new_update_authority None, primary_sale_happened None, is_mutable None
    data: concat([Uint8Array.of(15, 1), dataV2(p), Uint8Array.of(0, 0, 0)]),
  } as Instruction;
}

/** Reads key, update authority, mint, name, symbol and URI from a metadata account (strings are 0-padded). */
export function decodeMetadata(d: Uint8Array): TokenMetadata {
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const addr = getAddressDecoder();
  let o = 65;
  const str = () => {
    const n = view.getUint32(o, true);
    const s = new TextDecoder().decode(d.subarray(o + 4, o + 4 + n)).replace(/\0+$/, "");
    o += 4 + n;
    return s;
  };
  return {
    updateAuthority: addr.decode(d.subarray(1, 33)),
    mint: addr.decode(d.subarray(33, 65)),
    name: str(),
    symbol: str(),
    uri: str(),
  };
}
