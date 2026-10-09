// Instruction lists for every app action (brief 5.3, 5.6, 5.7, 5.8, 10.1). The user's wallet is the only signer.

import { AccountRole, type Address, address, createNoopSigner, type Instruction } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import {
  findUserPda,
  getBuyCreditsInstructionAsync,
  getDepositInstructionAsync,
  getExpireInstruction,
  getRedeemInstructionAsync,
  getSetMyReserveCapInstructionAsync,
  getWithdrawInstructionAsync,
} from "@unspent/program";
import type { JupiterBuild } from "./jupiter";
import { jupiterInstructions } from "./jupiter";
import { ata, type ProgramState, type ReservationRow } from "./read";

export type Ctx = { owner: string; program: ProgramState };

const signer = (owner: string) => createNoopSigner(address(owner));

async function createAta(owner: string, mint: Address): Promise<Instruction> {
  return getCreateAssociatedTokenIdempotentInstruction({
    payer: signer(owner),
    ata: await ata(owner, mint),
    owner: address(owner),
    mint,
  });
}

/** Expired reservations passed to withdraw are closed first and their hold returns to available (6.3). */
function withExpiredPairs(ix: Instruction, expired: ReservationRow[]): Instruction {
  const extra = expired.flatMap((r) => [
    { address: r.address, role: AccountRole.WRITABLE },
    { address: r.payer, role: AccountRole.WRITABLE },
  ]);
  return { ...ix, accounts: [...(ix.accounts ?? []), ...extra] };
}

async function buyAndMaybeDeposit({ owner, program: p }: Ctx, amount: bigint, deposit: boolean) {
  const usdcAta = await ata(owner, p.usdcMint);
  const creditAta = await ata(owner, p.creditMint);
  const ixs: Instruction[] = [
    await createAta(owner, p.creditMint),
    await getBuyCreditsInstructionAsync({
      buyer: signer(owner),
      creditMint: p.creditMint,
      reserve: p.reserve,
      buyerUsdc: usdcAta,
      buyerCredits: creditAta,
      amount,
    }),
  ];
  if (deposit)
    ixs.push(
      await getDepositInstructionAsync({
        owner: signer(owner),
        vault: p.vault,
        ownerCredits: creditAta,
        amount,
      }),
    );
  return ixs;
}

/** Buy with USDC: one signature, deposit included unless "Keep in wallet" (5.3). */
export function buyWithUsdc(ctx: Ctx, amount: bigint, deposit: boolean) {
  return buyAndMaybeDeposit(ctx, amount, deposit);
}

/**
 * Buy with any token: Jupiter ExactIn swap token → USDC, then buy_credits(min_out) and deposit(min_out).
 * Only the guaranteed minimum is bought; any extra USDC from the swap stays in the wallet (5.3).
 */
export async function buyWithSwap(ctx: Ctx, build: JupiterBuild, deposit: boolean) {
  const j = jupiterInstructions(build);
  const minOut = BigInt(build.otherAmountThreshold);
  return [...j.before, ...(await buyAndMaybeDeposit(ctx, minOut, deposit))];
}

export async function depositCredits({ owner, program: p }: Ctx, amount: bigint) {
  return [
    await getDepositInstructionAsync({
      owner: signer(owner),
      vault: p.vault,
      ownerCredits: await ata(owner, p.creditMint),
      amount,
    }),
  ];
}

export async function withdrawCredits(
  { owner, program: p }: Ctx,
  amount: bigint,
  expired: ReservationRow[] = [],
) {
  const ix = await getWithdrawInstructionAsync({
    owner: signer(owner),
    vault: p.vault,
    ownerCredits: await ata(owner, p.creditMint),
    amount,
  });
  return [await createAta(owner, p.creditMint), withExpiredPairs(ix, expired)];
}

/** expire is permissionless; rent goes back to whoever paid it (the gateway). */
export async function releaseExpired({ owner, program: p }: Ctx, expired: ReservationRow[]) {
  const [user] = await findUserPda({ owner: address(owner) });
  return expired.map((r) =>
    getExpireInstruction({ config: p.config, reservation: r.address, rentPayer: r.payer, user }),
  );
}

export async function setReserveCap({ owner }: Ctx, cap: bigint) {
  return [await getSetMyReserveCapInstructionAsync({ owner: signer(owner), cap })];
}

/** After shutdown: withdraw what's on the API balance (closing expired holds), then redeem 1:1 for USDC (5.7). */
export async function redeemAll(
  ctx: Ctx,
  { withdraw, expired, redeem }: { withdraw: bigint; expired: ReservationRow[]; redeem: bigint },
) {
  const { owner, program: p } = ctx;
  const ixs: Instruction[] = [];
  if (withdraw > 0n) ixs.push(...(await withdrawCredits(ctx, withdraw, expired)));
  else if (expired.length) ixs.push(...(await releaseExpired(ctx, expired)));
  if (redeem > 0n)
    ixs.push(
      await createAta(owner, p.usdcMint),
      await getRedeemInstructionAsync({
        owner: signer(owner),
        creditMint: p.creditMint,
        reserve: p.reserve,
        ownerCredits: await ata(owner, p.creditMint),
        ownerUsdc: await ata(owner, p.usdcMint),
        amount: redeem,
      }),
    );
  return ixs;
}

/** Sell: withdraw the missing part from the API balance if needed, then swap credits → USDC on Jupiter (5.8). */
export async function sellCredits(
  ctx: Ctx,
  build: JupiterBuild,
  withdraw: bigint,
  expired: ReservationRow[],
) {
  const ixs: Instruction[] = [];
  if (withdraw > 0n) ixs.push(...(await withdrawCredits(ctx, withdraw, expired)));
  return [...ixs, ...jupiterInstructions(build).before];
}
