// End-to-end onchain cycle against a local Surfpool mainnet fork (never a public cluster):
// buy + deposit → reserve → settle → settle_many → abandoned reservation expires (time travel) and is closed by
// withdraw → shutdown → redeem. Checks balances and invariants after each step.
//
// Prereq: `surfpool start --network mainnet --no-tui --no-deploy`, program deployed, `pnpm launch` run for localnet
// with keys/localnet-{admin,gateway}-keypair.json as ADMIN and GATEWAY.

import { AccountRole, type Address, type Instruction, lamports } from "@solana/kit";
import {
  fetchMint,
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  fetchConfig,
  fetchMaybeReservation,
  fetchUserAccount,
  findConfigPda,
  findReservationPda,
  findReservePda,
  findUserPda,
  findVaultPda,
  getBuyCreditsInstructionAsync,
  getDepositInstructionAsync,
  getRedeemInstructionAsync,
  getReserveInstructionAsync,
  getSettleInstructionAsync,
  getSettleManyInstructionAsync,
  getShutdownInstructionAsync,
  getWithdrawInstructionAsync,
} from "@unspent/program";
import { connect, env, loadKeypair, loadOrCreateKeypair, readJson, USDC_MINT } from "./lib";

const RPC = env("RPC_URL", "http://127.0.0.1:8899");
if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error("cycle.ts runs only against a local Surfpool fork");
const { rpc, send } = connect(RPC, env("WS_URL", "ws://127.0.0.1:8900"));
const dep = readJson<{ creditMint: Address; treasury: Address }>("ops/deployments/localnet.json");
const C = 1_000_000n;

async function cheat(method: string, params: unknown[]) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { error?: unknown; result?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

const tokenBalance = async (acc: Address) => (await fetchToken(rpc, acc)).data.amount;

function check(label: string, cond: boolean) {
  if (!cond) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
}

const [config] = await findConfigPda();
const [reserve] = await findReservePda();
const [vault] = await findVaultPda();

async function invariants(step: string) {
  const cfg = (await fetchConfig(rpc, config)).data;
  const supply = (await fetchMint(rpc, dep.creditMint)).data.supply;
  const r = await tokenBalance(reserve);
  const v = await tokenBalance(vault);
  check(`${step}: reserve ${r} ≥ supply ${supply}`, r >= supply);
  check(`${step}: vault ${v} ≥ total_user_balance ${cfg.totalUserBalance}`, v >= cfg.totalUserBalance);
  check(`${step}: total_released = total_burned`, cfg.totalReleased === cfg.totalBurned);
}

const withRemaining = (ix: Instruction, extra: Address[]): Instruction => ({
  ...ix,
  accounts: [...(ix.accounts ?? []), ...extra.map((address) => ({ address, role: AccountRole.WRITABLE }))],
});

const gateway = await loadKeypair("keys/localnet-gateway-keypair.json");
const admin = await loadKeypair("keys/localnet-admin-keypair.json");
const user = await loadOrCreateKeypair(`keys/localnet-cycle-user-${Date.now()}.json`);
await rpc.requestAirdrop(user.address, lamports(5_000_000_000n)).send();
await new Promise((r) => setTimeout(r, 1000));

const [userUsdc] = await findAssociatedTokenPda({
  owner: user.address,
  mint: USDC_MINT,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});
const [userCredits] = await findAssociatedTokenPda({
  owner: user.address,
  mint: dep.creditMint,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});
await cheat("surfnet_setTokenAccount", [
  user.address,
  USDC_MINT,
  { amount: Number(100n * C) },
  TOKEN_PROGRAM_ADDRESS,
]);
check("user holds 100 real-mint USDC", (await tokenBalance(userUsdc)) === 100n * C);

// 1. buy 100 credits and deposit 60 in one transaction
let sig = await send(user, [
  getCreateAssociatedTokenIdempotentInstruction({
    payer: user,
    ata: userCredits,
    owner: user.address,
    mint: dep.creditMint,
  }),
  await getBuyCreditsInstructionAsync({
    buyer: user,
    creditMint: dep.creditMint,
    reserve,
    buyerUsdc: userUsdc,
    buyerCredits: userCredits,
    amount: 100n * C,
  }),
  await getDepositInstructionAsync({ owner: user, vault, ownerCredits: userCredits, amount: 60n * C }),
]);
console.log(`buy + deposit ${sig}`);
const [userPda] = await findUserPda({ owner: user.address });
let ua = (await fetchUserAccount(rpc, userPda)).data;
check(
  "balance 60 credits on the API balance, 40 in the wallet",
  ua.balance === 60n * C && (await tokenBalance(userCredits)) === 40n * C,
);
await invariants("after buy");

// 2. reserve 2 credits, settle 0.01035
const rid = (n: number) => {
  const id = crypto.getRandomValues(new Uint8Array(32));
  id[0] = n;
  return id;
};
const settleAccounts = { creditMint: dep.creditMint, vault, reserve, treasury: dep.treasury };
const r1 = rid(1);
sig = await send(gateway, [
  await getReserveInstructionAsync({ gateway, requestId: r1, owner: user.address, amount: 2n * C }),
]);
console.log(`reserve ${sig}`);
const [res1] = await findReservationPda({ requestId: r1 });
sig = await send(gateway, [
  await getSettleInstructionAsync({
    gateway,
    reservation: res1,
    rentPayer: gateway.address,
    user: userPda,
    actual: 10_350n,
    ...settleAccounts,
  }),
]);
console.log(`settle ${sig}`);
check("treasury received 0.01035 USDC", (await tokenBalance(dep.treasury)) >= 10_350n);
await invariants("after settle");

// 3. three reservations settled in one settle_many (one is a pure release)
const ids = [rid(2), rid(3), rid(4)];
for (const id of ids)
  await send(gateway, [
    await getReserveInstructionAsync({ gateway, requestId: id, owner: user.address, amount: C }),
  ]);
const pdas = await Promise.all(ids.map(async (id) => (await findReservationPda({ requestId: id }))[0]));
const many = await getSettleManyInstructionAsync({
  gateway,
  rentPayer: gateway.address,
  actuals: [500_000n, 0n, C],
  ...settleAccounts,
});
sig = await send(gateway, [
  withRemaining(
    many,
    pdas.flatMap((p) => [p, userPda]),
  ),
]);
console.log(`settle_many ${sig}`);
for (const p of pdas) check("reservation closed", !(await fetchMaybeReservation(rpc, p)).exists);
await invariants("after settle_many");

// 4. abandoned reservation: the gateway never settles it; after the TTL the user's withdraw closes it
const r5 = rid(5);
await send(gateway, [
  await getReserveInstructionAsync({ gateway, requestId: r5, owner: user.address, amount: 10n * C }),
]);
const [res5] = await findReservationPda({ requestId: r5 });
const now = Number(
  (await rpc.getBlockTime(await rpc.getSlot().send()).send()) ?? Math.floor(Date.now() / 1000),
);
await cheat("surfnet_timeTravel", [{ absoluteTimestamp: (now + 3_700) * 1000 }]);
ua = (await fetchUserAccount(rpc, userPda)).data;
const withdrawAll = await getWithdrawInstructionAsync({
  owner: user,
  vault,
  ownerCredits: userCredits,
  amount: ua.balance,
});
sig = await send(user, [withRemaining(withdrawAll, [res5, gateway.address])]);
console.log(`withdraw (closes the expired reservation) ${sig}`);
check("expired reservation closed by withdraw", !(await fetchMaybeReservation(rpc, res5)).exists);
check("API balance empty", (await fetchUserAccount(rpc, userPda)).data.balance === 0n);
await invariants("after withdraw");

// 5. shutdown and redeem everything 1:1
sig = await send(admin, [await getShutdownInstructionAsync({ admin })]);
console.log(`shutdown ${sig}`);
const held = await tokenBalance(userCredits);
const usdcBefore = await tokenBalance(userUsdc);
sig = await send(user, [
  await getRedeemInstructionAsync({
    owner: user,
    creditMint: dep.creditMint,
    reserve,
    ownerCredits: userCredits,
    ownerUsdc: userUsdc,
    amount: held,
  }),
]);
console.log(`redeem ${sig}`);
check(`redeemed ${held} credits for the same USDC`, (await tokenBalance(userUsdc)) === usdcBefore + held);
await invariants("after redeem");
console.log("cycle complete");
