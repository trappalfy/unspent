// The indexer on a local Surfpool mainnet fork with the real program: a fresh user's cycle comes back as exactly
// the operations performed, and totals over the whole indexed history match the program's counters and the mint.
// Opt-in: E2E_SURFPOOL=1 with `ops/surfpool-up.sh` running. Never shuts the shared fork down.

import { readFileSync } from "node:fs";
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  fetchMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { openPglite } from "@unspent/db";
import {
  fetchConfig,
  findConfigPda,
  findReservationPda,
  findReservePda,
  findUserPda,
  findVaultPda,
  getBuyCreditsInstructionAsync,
  getDepositInstructionAsync,
  getExpireInstructionAsync,
  getReserveInstructionAsync,
  getSetMyReserveCapInstructionAsync,
  getSettleInstructionAsync,
  getWithdrawInstructionAsync,
} from "@unspent/program";
import { expect, it, vi } from "vitest";
import { Indexer } from "../src/indexer";
import { createLogger } from "../src/log";
import { eventTotals, walletHistory } from "../src/queries";

const RUN = process.env.E2E_SURFPOOL === "1";
const RPC = "http://127.0.0.1:8899";
const WS = "ws://127.0.0.1:8900";
const ROOT = new URL("../../../", import.meta.url).pathname;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const C = 1_000_000n;

const rpc = createSolanaRpc(RPC);

async function cheat(method: string, params: unknown[]) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const b = (await r.json()) as { error?: unknown; result?: unknown };
  if (b.error) throw new Error(`${method}: ${JSON.stringify(b.error)}`);
  return b.result;
}

async function send(signer: KeyPairSigner, ixs: Instruction[]): Promise<string> {
  let sig: ReturnType<typeof getSignatureFromTransaction> | null = null;
  // Surfpool's first remote account fetch after a pause sometimes fails without processing the transaction.
  for (let attempt = 0; !sig; attempt++) {
    const { value: bh } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const tx = await signTransactionMessageWithSigners(msg);
    try {
      await cheat("sendTransaction", [getBase64EncodedWireTransaction(tx), { encoding: "base64" }]);
      sig = getSignatureFromTransaction(tx);
    } catch (e) {
      if (attempt >= 2 || !String(e).includes("Failed to fetch accounts from remote")) throw e;
    }
  }
  for (let i = 0; i < 60; i++) {
    const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (st?.err) throw new Error(JSON.stringify(st.err));
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${sig} not confirmed`);
}

const withRemaining = (ix: Instruction, extra: Address[]): Instruction => ({
  ...ix,
  accounts: [...(ix.accounts ?? []), ...extra.map((a) => ({ address: a, role: AccountRole.WRITABLE }))],
});

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const rid = () => crypto.getRandomValues(new Uint8Array(32));

it.skipIf(!RUN)(
  "indexes a real cycle and matches the program's counters",
  async () => {
    const dep = JSON.parse(readFileSync(`${ROOT}ops/deployments/localnet.json`, "utf8"));
    const creditMint = address(dep.creditMint);
    const treasury = address(dep.treasury);
    const gateway = await createKeyPairSignerFromBytes(
      Uint8Array.from(JSON.parse(readFileSync(`${ROOT}keys/localnet-gateway-keypair.json`, "utf8"))),
    );
    const [configPda] = await findConfigPda();
    const [reserve] = await findReservePda();
    const [vault] = await findVaultPda();

    // A fresh PGlite, indexed from the start of the program's history, live through the logs subscription.
    const { db, close } = await openPglite();
    const logs: string[] = [];
    const indexer = new Indexer({
      db,
      rpc,
      rpcSubscriptions: createSolanaRpcSubscriptions(WS),
      network: "localnet",
      log: createLogger((l) => logs.push(l)),
      backfillMs: 600_000, // only the initial pass and notifications drive polls here
      debounceMs: 100,
    });
    indexer.start();

    try {
      const user = await generateKeyPairSigner();
      await rpc.requestAirdrop(user.address, lamports(2_000_000_000n)).send();
      await new Promise((r) => setTimeout(r, 1000));
      const [usdc] = await findAssociatedTokenPda({
        owner: user.address,
        mint: address(USDC),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const [credits] = await findAssociatedTokenPda({
        owner: user.address,
        mint: creditMint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      await cheat("surfnet_setTokenAccount", [
        user.address,
        USDC,
        { amount: Number(10n * C) },
        TOKEN_PROGRAM_ADDRESS,
      ]);
      const [userPda] = await findUserPda({ owner: user.address });
      const settleAccounts = {
        creditMint,
        vault,
        reserve,
        treasury,
        rentPayer: gateway.address,
        user: userPda,
      };

      // buy 10, deposit 6, cap holds at 5
      const sBuy = await send(user, [
        getCreateAssociatedTokenIdempotentInstruction({
          payer: user,
          ata: credits,
          owner: user.address,
          mint: creditMint,
        }),
        await getBuyCreditsInstructionAsync({
          buyer: user,
          creditMint,
          reserve,
          buyerUsdc: usdc,
          buyerCredits: credits,
          amount: 10n * C,
        }),
        await getDepositInstructionAsync({ owner: user, vault, ownerCredits: credits, amount: 6n * C }),
        await getSetMyReserveCapInstructionAsync({ owner: user, cap: 5n * C }),
      ]);

      // reserve 2, settle 0.5
      const r1 = rid();
      const sR1 = await send(gateway, [
        await getReserveInstructionAsync({ gateway, requestId: r1, owner: user.address, amount: 2n * C }),
      ]);
      const [res1] = await findReservationPda({ requestId: r1 });
      const sS1 = await send(gateway, [
        await getSettleInstructionAsync({ gateway, reservation: res1, actual: 500_000n, ...settleAccounts }),
      ]);

      // two abandoned reservations: one closed by `expire`, one by withdraw's remaining accounts
      const [r2, r3] = [rid(), rid()];
      const sR2 = await send(gateway, [
        await getReserveInstructionAsync({ gateway, requestId: r2, owner: user.address, amount: C }),
      ]);
      const sR3 = await send(gateway, [
        await getReserveInstructionAsync({ gateway, requestId: r3, owner: user.address, amount: 1_500_000n }),
      ]);
      const [res2] = await findReservationPda({ requestId: r2 });
      const [res3] = await findReservationPda({ requestId: r3 });
      const ttl = (await fetchConfig(rpc, configPda)).data.reservationTtl;
      const now =
        (await rpc.getBlockTime(await rpc.getSlot().send()).send()) ?? BigInt(Math.floor(Date.now() / 1000));
      await cheat("surfnet_timeTravel", [{ absoluteTimestamp: Number((now + ttl + 60n) * 1000n) }]);
      const sExp = await send(user, [
        await getExpireInstructionAsync({ reservation: res2, rentPayer: gateway.address, user: userPda }),
      ]);
      const sW = await send(user, [
        withRemaining(
          await getWithdrawInstructionAsync({
            owner: user,
            vault,
            ownerCredits: credits,
            amount: 5_500_000n,
          }),
          [res3, gateway.address],
        ),
      ]);

      // the subscription alone brings the last transaction in
      await vi.waitFor(
        async () =>
          expect((await walletHistory(db, "localnet", user.address, { limit: 1 }))[0]?.signature).toBe(sW),
        { timeout: 20_000, interval: 200 },
      );

      expect(logs.some((l) => l.includes("logs subscription open"))).toBe(true);
      const history = (await walletHistory(db, "localnet", user.address, { limit: 100 })).reverse();
      const me = user.address;
      expect(history.map((h) => [h.signature, h.name, h.data])).toEqual([
        [sBuy, "CreditsBought", { buyer: me, amount: "10000000" }],
        [sBuy, "Deposited", { owner: me, amount: "6000000" }],
        [sBuy, "ReserveCapSet", { owner: me, cap: "5000000" }],
        [
          sR1,
          "Reserved",
          { owner: me, requestId: hex(r1), amount: "2000000", expiresAt: expect.any(String) },
        ],
        [sS1, "Settled", { owner: me, requestId: hex(r1), reserved: "2000000", actual: "500000" }],
        [
          sR2,
          "Reserved",
          { owner: me, requestId: hex(r2), amount: "1000000", expiresAt: expect.any(String) },
        ],
        [
          sR3,
          "Reserved",
          { owner: me, requestId: hex(r3), amount: "1500000", expiresAt: expect.any(String) },
        ],
        [sExp, "Expired", { owner: me, requestId: hex(r2), amount: "1000000" }],
        [sW, "Expired", { owner: me, requestId: hex(r3), amount: "1500000" }],
        [sW, "Withdrawn", { owner: me, amount: "5500000" }],
      ]);
      for (const i of [5, 6])
        expect(BigInt(history[i]!.data.expiresAt as string)).toBeLessThanOrEqual(now + ttl);
      expect(history.every((h) => h.blockTime instanceof Date)).toBe(true);

      // Global cross-checks over the whole indexed history, on a snapshot no other transaction moved.
      const snapshot = async () => {
        const c = (await fetchConfig(rpc, configPda, { commitment: "confirmed" })).data;
        const supply = (await fetchMint(rpc, creditMint, { commitment: "confirmed" })).data.supply;
        return `${c.totalBurned}/${c.activeReserved}/${c.totalUserBalance}/${supply}`;
      };
      let state = "";
      for (let attempt = 0; attempt < 5; attempt++) {
        const before = await snapshot();
        await indexer.poll();
        if ((await snapshot()) === before) {
          state = before;
          break;
        }
      }
      expect(state).not.toBe("");
      const [burned, active, userBalance, supply] = state.split("/").map(BigInt) as [
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      const t = await eventTotals(db, "localnet");
      console.log("cross-check", { ...t, burned, active, userBalance, supply });
      expect(t.settledActual).toBe(burned);
      expect(t.reserved - t.settledReserved - t.expired).toBe(active);
      expect(t.deposited - t.withdrawn - t.settledActual).toBe(userBalance);
      expect(t.bought - t.settledActual - t.redeemed).toBe(supply);
    } finally {
      await indexer.stop();
      await close();
    }
  },
  180_000,
);
