// Synthetic transaction logs in the runtime's format, for parser and indexer tests.

import type { ReadonlyUint8Array } from "@solana/kit";
import { UNSPENT_PROGRAM_ADDRESS } from "@unspent/program";

export const PROGRAM = UNSPENT_PROGRAM_ADDRESS as string;
export const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
export const BOB = "Go2KWmQCEhcc6uoWE2GWQoY9RbkhJgg4LVz9zVcdnmBN";

export const data = (bytes: ReadonlyUint8Array) => `Program data: ${Buffer.from(bytes).toString("base64")}`;

/** One top-level instruction of `program` whose body lines are logged in between. */
export const invocation = (program: string, depth: number, body: string[], failed = false): string[] => [
  `Program ${program} invoke [${depth}]`,
  ...body,
  `Program ${program} consumed 1000 of 200000 compute units`,
  failed ? `Program ${program} failed: custom program error: 0x1771` : `Program ${program} success`,
];

/** Our program as a top-level instruction emitting the given events. */
export const ours = (...events: ReadonlyUint8Array[]) =>
  invocation(PROGRAM, 1, ["Program log: Instruction: Test", ...events.map(data)]);

export const requestId = (n: number) => {
  const id = new Uint8Array(32);
  id[0] = n;
  id[31] = 0xab;
  return id;
};
export const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
