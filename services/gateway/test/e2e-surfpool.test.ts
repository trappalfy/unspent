// The gateway with the real program on a local Surfpool mainnet fork (real USDC mint), mock provider, PGlite.
// Opt-in: E2E_SURFPOOL=1 after `surfpool start --network mainnet`, deploy and `pnpm --filter @unspent/ops launch`.

import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  type Instruction,
  type KeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { apiKeys, openPglite, requests, wallets } from "@unspent/db";
import {
  fetchConfig,
  fetchUserAccount,
  findConfigPda,
  findReservePda,
  findUserPda,
  findVaultPda,
  getBuyCreditsInstructionAsync,
  getDepositInstructionAsync,
} from "@unspent/program";
import { generateApiKey, sha256 } from "@unspent/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../src/app";
import { SolanaChain } from "../src/chain";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/log";
import { MemoryRateLimiter } from "../src/ratelimit";
import { SettleWorker } from "../src/settle";
import { AnthropicUpstream } from "../src/upstream";
import { type MockAnthropic, startMockAnthropic } from "./mock/mockAnthropic";

const RUN = process.env.E2E_SURFPOOL === "1";
const RPC = "http://127.0.0.1:8899";
const ROOT = new URL("../../../", import.meta.url).pathname;
const C = 1_000_000n;

const rpc = createSolanaRpc(RPC);
let mock: MockAnthropic;
let url = "";
let apiKey = "";
let user: KeyPairSigner;
let settle: SettleWorker;
let closeAll: () => Promise<void> = async () => {};
let db: Awaited<ReturnType<typeof openPglite>>["db"];
let creditMint: Address;
let treasury: Address;

async function cheat(method: string, params: unknown[]) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const b = (await r.json()) as { error?: unknown };
  if (b.error) throw new Error(JSON.stringify(b.error));
}

async function send(signer: KeyPairSigner, ixs: Instruction[]) {
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  const raw = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [getBase64EncodedWireTransaction(tx), { encoding: "base64" }],
    }),
  }).then((r) => r.json() as Promise<{ result?: string; error?: unknown }>);
  if (!raw.result) throw new Error(`sendTransaction: ${JSON.stringify(raw.error)}`);
  const sig = raw.result as Parameters<typeof rpc.getSignatureStatuses>[0][number];
  for (let i = 0; i < 60; i++) {
    const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (st?.err) throw new Error(JSON.stringify(st.err));
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("not confirmed");
}

beforeAll(async () => {
  if (!RUN) return;
  const dep = JSON.parse(readFileSync(`${ROOT}ops/deployments/localnet.json`, "utf8"));
  creditMint = address(dep.creditMint);
  treasury = address(dep.treasury);
  user = await generateKeyPairSigner();
  await rpc.requestAirdrop(user.address, lamports(2_000_000_000n)).send();
  await new Promise((r) => setTimeout(r, 1000));
  const [usdc] = await findAssociatedTokenPda({
    owner: user.address,
    mint: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [credits] = await findAssociatedTokenPda({
    owner: user.address,
    mint: creditMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  await cheat("surfnet_setTokenAccount", [
    user.address,
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    { amount: Number(10n * C) },
    TOKEN_PROGRAM_ADDRESS,
  ]);
  const [reserve] = await findReservePda();
  const [vault] = await findVaultPda();
  await send(user, [
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
    await getDepositInstructionAsync({ owner: user, vault, ownerCredits: credits, amount: 10n * C }),
  ]);

  mock = await startMockAnthropic();
  const opened = await openPglite();
  db = opened.db;
  const log = createLogger({ sink: () => {} });
  const config = loadConfig({
    PROVIDER_MODE: "mock",
    ANTHROPIC_BASE_URL: mock.url,
    ANTHROPIC_API_KEYS: "sk-ant-test",
    NEXT_PUBLIC_SOLANA_NETWORK: "localnet",
  });
  const chain = await SolanaChain.create(RPC, `${ROOT}keys/localnet-gateway-keypair.json`, 0n);
  const deps = {
    config,
    db,
    chain,
    upstream: new AnthropicUpstream(mock.url, ["sk-ant-test"], log),
    limiter: new MemoryRateLimiter(),
    log,
  };
  settle = new SettleWorker(db, chain, log, 50);
  await db.insert(wallets).values({ address: user.address });
  apiKey = generateApiKey("localnet");
  await db.insert(apiKeys).values({
    wallet: user.address,
    network: "localnet",
    name: "e2e",
    keyHash: await sha256(apiKey),
    last4: apiKey.slice(-4),
  });
  const server = serve({ fetch: createApp(deps).fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const a = server.address();
  url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  closeAll = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await mock.close();
    await opened.close();
  };
}, 120_000);

afterAll(async () => {
  await closeAll();
});

it.skipIf(!RUN)(
  "requests reserve and settle on the real program",
  async () => {
    const [config] = await findConfigPda();
    const before = (await fetchConfig(rpc, config)).data;
    const treasuryBefore = (await fetchToken(rpc, treasury)).data.amount;
    const call = (body: object) =>
      fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5-5",
          max_tokens: 400,
          messages: [{ role: "user", content: "hi" }],
          ...body,
        }),
      });

    // three parallel streamed requests and one provider error (released)
    mock.setScenario((req) =>
      req.json?.metadata?.user_id === "fail"
        ? { type: "error_before_first_token", status: 529 }
        : { type: "text" },
    );
    const res = await Promise.all([
      call({ stream: true }),
      call({ stream: true }),
      call({}),
      call({ metadata: { user_id: "fail" } }),
    ]);
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 529]);
    await Promise.all(res.map((r) => r.text()));
    await new Promise((r) => setTimeout(r, 300));
    await settle.drain();

    const rows = await db.select().from(requests);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.status === "settled")).toHaveLength(3);
    expect(rows.filter((r) => r.status === "released")).toHaveLength(1);
    const charged = rows.reduce((s, r) => s + (r.chargedUcr ?? 0n), 0n);
    expect(new Set(rows.map((r) => r.settleSig).filter(Boolean)).size).toBeLessThanOrEqual(2); // batched settle_many

    const [userPda] = await findUserPda({ owner: user.address });
    const ua = (await fetchUserAccount(rpc, userPda)).data;
    expect(ua.reserved).toBe(0n);
    expect(ua.balance).toBe(10n * C - charged);
    const after = (await fetchConfig(rpc, config)).data;
    expect(after.totalBurned - before.totalBurned).toBe(charged);
    expect(after.activeReserved).toBe(before.activeReserved);
    expect((await fetchToken(rpc, treasury)).data.amount - treasuryBefore).toBe(charged);

    const bal = await (await fetch(`${url}/v1/balance`, { headers: { "x-api-key": apiKey } })).json();
    expect(BigInt(Math.round(Number(bal.available) * 1e6))).toBe(10n * C - charged);
  },
  120_000,
);
