// Token metadata instructions (owner, 2026-10-10: tested as "Test Credit", renamed on launch day by the admin wallet).

import { address, createNoopSigner, getAddressEncoder } from "@solana/kit";
import { decodeMetadata, getUpdateMetadataInstruction, METADATA_PROGRAM } from "@unspent/program";
import { describe, expect, it } from "vitest";

const MINT = address("ErAUpP3cpWDm9mnyAE2xCJjFjC7voTn55VjFmhKeMt3i");
const ADMIN = address("68gb89fuKhfwpNppJYVQYUpcBqtGUZypR9pWTgSGbqzg");
const str = (s: string, pad = 0) => {
  const b = new TextEncoder().encode(s.padEnd(pad, "\0"));
  return [...new Uint8Array(new Uint32Array([b.length]).buffer), ...b];
};

describe("token metadata", () => {
  it("UpdateMetadataAccountV2 carries Some(DataV2) and leaves authority and mutability alone", async () => {
    const ix = await getUpdateMetadataInstruction({
      mint: MINT,
      updateAuthority: createNoopSigner(ADMIN),
      name: "Unspent Credit",
      symbol: "UCRED",
      uri: "https://example.com/token.json",
    });
    expect(ix.programAddress).toBe(METADATA_PROGRAM);
    expect(ix.accounts?.[1]?.address).toBe(ADMIN);
    expect([...(ix.data ?? [])]).toEqual([
      15,
      1,
      ...str("Unspent Credit"),
      ...str("UCRED"),
      ...str("https://example.com/token.json"),
      0,
      0, // seller fee
      0,
      0,
      0, // creators, collection, uses
      0,
      0,
      0, // new update authority, primary sale, is_mutable: unchanged
    ]);
  });

  it("refuses values over Metaplex limits", async () => {
    await expect(
      getUpdateMetadataInstruction({
        mint: MINT,
        updateAuthority: createNoopSigner(ADMIN),
        name: "x".repeat(33),
        symbol: "A",
        uri: "",
      }),
    ).rejects.toThrow(/name is longer than 32/);
  });

  it("decodes a metadata account with 0-padded strings", () => {
    const enc = getAddressEncoder();
    const bytes = Uint8Array.from([
      4,
      ...enc.encode(ADMIN),
      ...enc.encode(MINT),
      ...str("Test Credit", 32),
      ...str("TST", 10),
      ...str("", 200),
      0,
      0,
    ]);
    expect(decodeMetadata(bytes)).toEqual({
      updateAuthority: ADMIN,
      mint: MINT,
      name: "Test Credit",
      symbol: "TST",
      uri: "",
    });
  });
});
