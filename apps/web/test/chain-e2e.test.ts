// The app's transaction code (lib/chain) against the real program on a local Surfpool mainnet fork: the same builders,
// simulation and confirmation loop the UI uses, with a test keypair instead of a browser wallet. Buying with any token
// goes through a real Jupiter route (mainnet quote, executed on the fork).
// Opt-in: E2E_SURFPOOL=1 after ops/surfpool-up.sh. E2E_SHUTDOWN=1 also runs shutdown + redeem (irreversible on the fork).

import { readFileSync } from "node:fs";
import {
  type Address,
  address,
  createSolanaRpc,
  generateKeyPairSigner,
  getTransactionDecoder,
  getTransactionEncoder,
  type Instruction,
  type KeyPairSigner,
  lamports,
  signTransaction,
} from "@solana/kit";
import { getReserveInstructionAsync, getShutdownInstructionAsync } from "@unspent/program";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buyWithSwap,
  buyWithUsdc,
  type Ctx,
  depositCredits,
  redeemAll,
  releaseExpired,
  setReserveCap,
  withdrawCredits,
} from "../lib/chain/build";
import { composeSwap } from "../lib/chain/jupiter";
import { type ProgramState, readProgram, readReservations, readUser, readWallet } from "../lib/chain/read";
import { instructionPrograms, prepare, signAndConfirm, TxError, TxTooLargeError } from "../lib/chain/tx";
import { jupiterBuild } from "../lib/jupiter-api";

const RUN = process.env.E2E_SURFPOOL === "1";
const RPC = "http://127.0.0.1:8899";
const ROOT = new URL("../../../", import.meta.url).pathname;
const C = 1_000_000n;
const rpc = createSolanaRpc(RPC);

async function cheat(method: string, params: unknown[]) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const b = (await r.json()) as { error?: unknown };
  if (b.error) throw new Error(JSON.stringify(b.error));
}

async function keypair(path: string): Promise<KeyPairSigner> {
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}${path}`, "utf8"))));
}

let p: ProgramState;
let user: KeyPairSigner;
let ctx: Ctx;

/** What the browser wallet does: sign the bytes it is given. */
const walletOf = (s: KeyPairSigner) => async (bytes: Uint8Array) => {
  const tx = getTransactionDecoder().decode(bytes);
  const signed = await signTransaction([s.keyPair], tx);
  return { signed: new Uint8Array(getTransactionEncoder().encode(signed)) };
};

async function run(ixs: Instruction[], signer = user, alts: Record<Address, Address[]> = {}) {
  const prepared = await prepare(rpc, signer.address, ixs, alts);
  const stages: string[] = [];
  const sig = await signAndConfirm(
    rpc,
    prepared,
    walletOf(signer),
    (s) => stages.push(s),
    instructionPrograms(ixs),
  );
  expect(stages).toEqual(["signing", "confirming", "done"]);
  return { sig, prepared };
}

async function fundUser() {
  const u = await generateKeyPairSigner();
  await rpc.requestAirdrop(u.address, lamports(5_000_000_000n)).send();
  await cheat("surfnet_setTokenAccount", [
    u.address,
    p.usdcMint,
    { amount: Number(200n * C) },
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  ]);
  for (let i = 0; i < 20; i++) {
    if ((await rpc.getBalance(u.address).send()).value > 0n) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return u;
}

async function chainNow(): Promise<number> {
  const slot = await rpc.getSlot().send();
  return Number((await rpc.getBlockTime(slot).send()) ?? BigInt(Math.floor(Date.now() / 1000)));
}

describe.skipIf(!RUN)("app transactions on a mainnet fork", () => {
  beforeAll(async () => {
    const prog = await readProgram(rpc);
    if (!prog) throw new Error("program not initialized on the fork: run ops/surfpool-up.sh");
    p = prog;
    user = await fundUser();
    ctx = { owner: user.address, program: p };
  }, 60_000);

  it("buys with USDC and deposits in one signature", async () => {
    const { prepared } = await run(await buyWithUsdc(ctx, 10n * C, true));
    expect(prepared.bytes.length).toBeLessThanOrEqual(1232);
    expect(prepared.units).toBeLessThan(200_000);
    const u = await readUser(rpc, user.address);
    const w = await readWallet(rpc, user.address, p);
    expect(u.balance).toBe(10n * C);
    expect(w.credits).toBe(0n);
    expect(w.usdc).toBe(190n * C);
  }, 60_000);

  it("keep in wallet, then deposit and set a hold limit", async () => {
    await run(await buyWithUsdc(ctx, 5n * C, false));
    expect((await readWallet(rpc, user.address, p)).credits).toBe(5n * C);
    await run(await depositCredits(ctx, 2n * C));
    await run(await setReserveCap(ctx, 3n * C));
    const u = await readUser(rpc, user.address);
    expect(u.balance).toBe(12n * C);
    expect(u.reserveCap).toBe(3n * C);
    expect((await readWallet(rpc, user.address, p)).credits).toBe(3n * C);
  }, 60_000);

  it("explains program errors before the wallet opens", async () => {
    const err = await prepare(rpc, user.address, await withdrawCredits(ctx, 13n * C)).catch((e) => e);
    expect(err).toBeInstanceOf(TxError);
    expect(err.message).toMatch(/Not enough available balance/);
    const small = await prepare(rpc, user.address, await buyWithUsdc(ctx, C / 2n, true)).catch((e) => e);
    expect(small.message).toMatch(/minimum purchase is 1 credit/);
  }, 60_000);

  it("buys with SOL through a real Jupiter route in one transaction", async () => {
    const before = await readWallet(rpc, user.address, p);
    const userBefore = await readUser(rpc, user.address);
    const { build, prepared, ixs } = await composeSwap(
      async (maxAccounts) => {
        const r = await jupiterBuild(
          {
            side: "buy",
            mint: "So11111111111111111111111111111111111111112",
            amount: 100_000_000n,
            taker: user.address,
            slippageBps: 100,
            maxAccounts,
            // A fork's clock and oracles lag mainnet; plain AMMs execute the same either way.
            dexes: "Whirlpool,Raydium CLMM,Meteora DLMM,Raydium,Orca V2",
          },
          { usdc: p.usdcMint, credit: p.creditMint },
        );
        if (!r.ok) throw new Error(r.error);
        return r.build;
      },
      (b) => buyWithSwap(ctx, b, true),
      (ixs, alts) =>
        prepare(rpc, user.address, ixs, alts).catch((e) => {
          if (e instanceof TxError) console.log(e.logs.join("\n"));
          throw e;
        }),
      (e) => e instanceof TxTooLargeError,
    );
    expect(prepared.bytes.length).toBeLessThanOrEqual(1232);
    const minOut = BigInt(build.otherAmountThreshold);
    expect(minOut).toBeGreaterThan(C);
    await signAndConfirm(rpc, prepared, walletOf(user), () => {}, instructionPrograms(ixs));

    const after = await readWallet(rpc, user.address, p);
    const userAfter = await readUser(rpc, user.address);
    expect(userAfter.balance - userBefore.balance).toBe(minOut);
    expect(after.credits).toBe(before.credits);
    // Positive slippage stays in the wallet as USDC.
    expect(after.usdc).toBeGreaterThanOrEqual(before.usdc);
    expect(before.sol - after.sol).toBeGreaterThanOrEqual(100_000_000n);
  }, 120_000);

  it("lists reservations from the program, releases expired ones and closes them inside withdraw", async () => {
    const gateway = await keypair("keys/localnet-gateway-keypair.json");
    const ids = [1, 2].map(() => crypto.getRandomValues(new Uint8Array(32)));
    for (const requestId of ids)
      await run(
        [await getReserveInstructionAsync({ gateway, requestId, owner: address(user.address), amount: C })],
        gateway,
      );
    let rows = await readReservations(rpc, user.address);
    expect(rows.map((r) => r.amount)).toEqual([C, C]);
    const u0 = await readUser(rpc, user.address);
    expect(u0.available).toBe(u0.balance - 2n * C);

    await cheat("surfnet_timeTravel", [{ absoluteTimestamp: ((await chainNow()) + 3_700) * 1000 }]);
    rows = await readReservations(rpc, user.address);
    const now = await chainNow();
    expect(rows.every((r) => r.expiresAt <= now)).toBe(true);

    await run(await releaseExpired(ctx, rows.slice(0, 1)));
    rows = await readReservations(rpc, user.address);
    expect(rows).toHaveLength(1);

    // Withdraw everything, the remaining expired hold included, in one transaction.
    const balance = (await readUser(rpc, user.address)).balance;
    const credits = (await readWallet(rpc, user.address, p)).credits;
    await run(await withdrawCredits(ctx, balance, rows));
    expect(await readReservations(rpc, user.address)).toHaveLength(0);
    const u = await readUser(rpc, user.address);
    expect(u.balance).toBe(0n);
    expect(u.reserved).toBe(0n);
    expect((await readWallet(rpc, user.address, p)).credits).toBe(credits + balance);
  }, 120_000);

  it("has no market for credits yet (sell route)", async () => {
    const r = await jupiterBuild(
      { side: "sell", mint: "", amount: C, taker: user.address, slippageBps: 50, maxAccounts: 48 },
      { usdc: p.usdcMint, credit: p.creditMint },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.error).toBe("No market for credits yet.");
    }
  }, 30_000);

  it.skipIf(process.env.E2E_SHUTDOWN !== "1")(
    "after shutdown: withdraws and redeems 1:1 for USDC",
    async () => {
      await run(await depositCredits(ctx, 5n * C));
      const admin = await keypair("keys/localnet-admin-keypair.json");
      await run([await getShutdownInstructionAsync({ admin })], admin);
      p = (await readProgram(rpc))!;
      ctx = { owner: user.address, program: p };
      expect(p.shutDown).toBe(true);
      const u = await readUser(rpc, user.address);
      const w = await readWallet(rpc, user.address, p);
      await run(
        await redeemAll(ctx, { withdraw: u.available, expired: [], redeem: w.credits + u.available }),
      );
      const w2 = await readWallet(rpc, user.address, p);
      expect(w2.credits).toBe(0n);
      expect(w2.usdc - w.usdc).toBe(w.credits + u.available);
    },
    60_000,
  );
});
