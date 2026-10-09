// BPF upgradeable loader instructions for the program's upgrade authority (brief 6.2, Q12): hand it over, replace
// the code from a buffer, or freeze upgrades for good.

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
import { UNSPENT_PROGRAM_ADDRESS } from "./generated";

export const BPF_UPGRADEABLE_LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const SYSVAR_RENT = address("SysvarRent111111111111111111111111111111111");
const SYSVAR_CLOCK = address("SysvarC1ock11111111111111111111111111111111");

export async function findProgramDataAddress(program: Address = UNSPENT_PROGRAM_ADDRESS): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: BPF_UPGRADEABLE_LOADER,
    seeds: [getAddressEncoder().encode(program)],
  });
  return pda;
}

/** The upgrade authority stored in a ProgramData (or buffer) account; null once upgrades are frozen. */
export function decodeUpgradeAuthority(data: Uint8Array): Address | null {
  // ProgramData: u32 tag, u64 slot, Option<Pubkey>. Buffer: u32 tag, Option<Pubkey>.
  const at = data[0] === 1 ? 4 : 12;
  return data[at] === 1 ? getAddressDecoder().decode(data.subarray(at + 1, at + 33)) : null;
}

/** SetAuthority: moves the upgrade authority to `newAuthority`, or freezes upgrades for good when it is null. */
export async function getSetUpgradeAuthorityInstruction(p: {
  authority: TransactionSigner;
  newAuthority: Address | null;
  program?: Address;
}): Promise<Instruction> {
  return {
    programAddress: BPF_UPGRADEABLE_LOADER,
    accounts: [
      { address: await findProgramDataAddress(p.program), role: AccountRole.WRITABLE },
      { address: p.authority.address, role: AccountRole.READONLY_SIGNER, signer: p.authority },
      ...(p.newAuthority ? [{ address: p.newAuthority, role: AccountRole.READONLY }] : []),
    ],
    data: Uint8Array.of(4, 0, 0, 0),
  } as Instruction;
}

/** Upgrade: replaces the program's code with a buffer owned by the upgrade authority; the buffer's rent goes to `spill`. */
export async function getUpgradeProgramInstruction(p: {
  authority: TransactionSigner;
  buffer: Address;
  spill: Address;
  program?: Address;
}): Promise<Instruction> {
  const program = p.program ?? UNSPENT_PROGRAM_ADDRESS;
  return {
    programAddress: BPF_UPGRADEABLE_LOADER,
    accounts: [
      { address: await findProgramDataAddress(program), role: AccountRole.WRITABLE },
      { address: program, role: AccountRole.WRITABLE },
      { address: p.buffer, role: AccountRole.WRITABLE },
      { address: p.spill, role: AccountRole.WRITABLE },
      { address: SYSVAR_RENT, role: AccountRole.READONLY },
      { address: SYSVAR_CLOCK, role: AccountRole.READONLY },
      { address: p.authority.address, role: AccountRole.READONLY_SIGNER, signer: p.authority },
    ],
    data: Uint8Array.of(3, 0, 0, 0),
  } as Instruction;
}
