// Squads v4 multisigs (brief 6.2, 14): `admin`, 2 of 3 without a time lock (the program delays risky changes itself),
// and the program's upgrade authority, 2 of 3 with a time lock ≥ admin_delay. Admin actions are proposed here as vault
// transactions; members approve and execute them in the Squads app (or with approve/execute here on a local fork).
//
//   pnpm --filter @unspent/ops squads create <admin|upgrade>    MEMBERS=a,b,c [PROPOSER=d] [THRESHOLD=2] [TIME_LOCK=s]
//   pnpm --filter @unspent/ops squads handover                  DEPLOYER_KEYPAIR: upgrade authority → upgrade vault
//   pnpm --filter @unspent/ops squads propose <admin|upgrade> <action> [args]    PROPOSER_KEYPAIR
//   pnpm --filter @unspent/ops squads approve <admin|upgrade> <index>            MEMBER_KEYPAIR (local fork)
//   pnpm --filter @unspent/ops squads execute <admin|upgrade> <index>            MEMBER_KEYPAIR (local fork)
//   pnpm --filter @unspent/ops squads show <admin|upgrade>
//
// Actions (admin): pause|unpause <buy|deposit|gateway>, set-limit <field> <credits|seconds>, cancel <field>,
//   apply <field>, propose-treasury <owner>, propose-gateway-backup <key>, revoke-gateway, activate-backup-gateway,
//   shutdown, sweep-surplus. Actions (upgrade): freeze-upgrades.
// PROPOSER is an extra member with only the Initiate permission: it can propose but not vote, so its key can live on
// an ops machine. Env: NETWORK (localnet|mainnet), RPC_URL. Mainnet sends only with CONFIRM_MAINNET=yes.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AccountRole, type Address, address, createNoopSigner, type Instruction } from "@solana/kit";
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage } from "@solana/web3.js";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import * as multisig from "@sqds/multisig";
import {
  ConfigField,
  fetchConfig,
  findConfigPda,
  findReservePda,
  findVaultPda,
  getActivateBackupGatewayInstructionAsync,
  getApplyPendingInstructionAsync,
  getCancelPendingInstructionAsync,
  getProposeGatewayBackupInstructionAsync,
  getProposeTreasuryInstructionAsync,
  getRevokeGatewayInstructionAsync,
  getSetLimitInstructionAsync,
  getSetPauseInstructionAsync,
  getShutdownInstructionAsync,
  getSweepSurplusInstructionAsync,
  PauseTarget,
  UNSPENT_PROGRAM_ADDRESS,
} from "@unspent/program";
import { creditsToUcr } from "@unspent/shared";
import {
  BPF_UPGRADEABLE_LOADER,
  connect,
  env,
  loadKeypair,
  programDataAddress,
  ROOT,
  USDC_MINT,
  writeJson,
} from "./lib";

type Kind = "admin" | "upgrade";
type Entry = {
  multisig: string;
  vault: string;
  threshold: number;
  timeLock: number;
  members: string[];
  proposer?: string;
};

const network = env("NETWORK", "localnet");
const rpcUrl = env("RPC_URL", "http://127.0.0.1:8899");
const conn = new Connection(rpcUrl, "confirmed");
const FILE = `ops/deployments/${network}-squads.json`;
const [cmd, ...args] = process.argv.slice(2);

function guard() {
  if (network === "mainnet" && process.env.CONFIRM_MAINNET !== "yes")
    throw new Error(
      "Refusing to send on mainnet without CONFIRM_MAINNET=yes (owner's explicit go, brief rule 0.3).",
    );
}

function saved(): Partial<Record<Kind, Entry>> {
  const full = resolve(ROOT, FILE);
  return existsSync(full) ? JSON.parse(readFileSync(full, "utf8")) : {};
}

function entry(kind: string | undefined): Entry & { pda: PublicKey; vaultKey: PublicKey } {
  if (kind !== "admin" && kind !== "upgrade") throw new Error("Expected admin or upgrade");
  const e = saved()[kind];
  if (!e) throw new Error(`No ${kind} multisig in ${FILE}; run \`squads create ${kind}\` first`);
  return { ...e, pda: new PublicKey(e.multisig), vaultKey: new PublicKey(e.vault) };
}

function web3Keypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolve(ROOT, path), "utf8"))));
}

function toWeb3(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts ?? []).map((a) => ({
      pubkey: new PublicKey(a.address),
      isSigner: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER,
      isWritable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER,
    })),
    data: Buffer.from(ix.data ?? new Uint8Array()),
  });
}

async function confirmed(signature: string): Promise<string> {
  for (let i = 0; i < 120; i++) {
    const { value } = await conn.getSignatureStatuses([signature]);
    const st = value[0];
    if (st?.err) throw new Error(`${signature} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return signature;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${signature} not confirmed in 60 s`);
}

const FIELDS: Record<string, ConfigField> = {
  "max-buy-per-ix": ConfigField.MaxBuyPerIx,
  "supply-cap": ConfigField.SupplyCap,
  "max-reservation": ConfigField.MaxReservation,
  "max-reserved-per-user": ConfigField.MaxReservedPerUser,
  "burn-cap-per-window": ConfigField.BurnCapPerWindow,
  "reservation-ttl": ConfigField.ReservationTtl,
  "admin-delay": ConfigField.AdminDelay,
  "gateway-backup": ConfigField.GatewayBackup,
  treasury: ConfigField.Treasury,
};
const TARGETS: Record<string, PauseTarget> = {
  buy: PauseTarget.Buy,
  deposit: PauseTarget.Deposit,
  gateway: PauseTarget.Gateway,
};

function field(name: string | undefined): ConfigField {
  const f = name ? FIELDS[name] : undefined;
  if (f === undefined) throw new Error(`Field must be one of ${Object.keys(FIELDS).join(", ")}`);
  return f;
}

/** Limit values: credits for amounts, seconds for durations. */
function limitValue(f: ConfigField, raw: string | undefined): bigint {
  if (!raw) throw new Error("Missing value");
  return f === ConfigField.ReservationTtl || f === ConfigField.AdminDelay ? BigInt(raw) : creditsToUcr(raw);
}

/** Program instructions signed by the multisig vault. */
export async function actionInstructions(
  kind: Kind,
  vault: Address,
  action: string,
  a: string[],
): Promise<Instruction[]> {
  const admin = createNoopSigner(vault);
  if (kind === "upgrade") {
    if (action !== "freeze-upgrades")
      throw new Error("The upgrade multisig only proposes freeze-upgrades here");
    // BPF upgradeable loader SetAuthority (4) without a new authority: the program becomes immutable.
    return [
      {
        programAddress: BPF_UPGRADEABLE_LOADER,
        accounts: [
          { address: await programDataAddress(UNSPENT_PROGRAM_ADDRESS), role: AccountRole.WRITABLE },
          { address: vault, role: AccountRole.READONLY_SIGNER },
        ],
        data: Uint8Array.of(4, 0, 0, 0),
      },
    ];
  }
  switch (action) {
    case "pause":
    case "unpause": {
      const target = a[0] ? TARGETS[a[0]] : undefined;
      if (target === undefined) throw new Error("Target must be buy, deposit or gateway");
      return [await getSetPauseInstructionAsync({ admin, target, paused: action === "pause" })];
    }
    case "set-limit": {
      const f = field(a[0]);
      return [await getSetLimitInstructionAsync({ admin, field: f, value: limitValue(f, a[1]) })];
    }
    case "cancel":
      return [await getCancelPendingInstructionAsync({ admin, field: field(a[0]) })];
    case "apply":
      return [await getApplyPendingInstructionAsync({ field: field(a[0]) })];
    case "propose-treasury": {
      if (!a[0]) throw new Error("Missing treasury owner");
      const [newTreasury] = await findAssociatedTokenPda({
        owner: address(a[0]),
        mint: USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      return [await getProposeTreasuryInstructionAsync({ admin, newTreasury })];
    }
    case "propose-gateway-backup":
      if (!a[0]) throw new Error("Missing key");
      return [await getProposeGatewayBackupInstructionAsync({ admin, key: address(a[0]) })];
    case "revoke-gateway":
      return [await getRevokeGatewayInstructionAsync({ admin })];
    case "activate-backup-gateway":
      return [await getActivateBackupGatewayInstructionAsync({ admin })];
    case "shutdown":
      return [await getShutdownInstructionAsync({ admin })];
    case "sweep-surplus": {
      const { rpc } = connect(rpcUrl, rpcUrl.replace(/^http/, "ws"));
      const [configPda] = await findConfigPda();
      const config = await fetchConfig(rpc, configPda);
      const [vaultPda] = await findVaultPda();
      const [reserve] = await findReservePda();
      return [
        await getSweepSurplusInstructionAsync({
          admin,
          creditMint: config.data.creditMint,
          vault: vaultPda,
          reserve,
          treasury: config.data.treasury,
        }),
      ];
    }
    default:
      throw new Error(`Unknown action ${action}`);
  }
}

async function create(kind: string | undefined) {
  if (kind !== "admin" && kind !== "upgrade") throw new Error("create admin|upgrade");
  guard();
  const payer = web3Keypair(env("PAYER_KEYPAIR", `keys/${network}-deployer-keypair.json`));
  const voters = env("MEMBERS")
    .split(",")
    .map((s) => s.trim());
  const proposer = process.env.PROPOSER?.trim() || undefined;
  const threshold = Number(process.env.THRESHOLD ?? 2);
  const timeLock = Number(process.env.TIME_LOCK ?? (kind === "upgrade" ? 48 * 3600 : 0));
  const { Permission, Permissions } = multisig.types;
  const members = [
    ...voters.map((k) => ({ key: new PublicKey(k), permissions: Permissions.all() })),
    ...(proposer
      ? [{ key: new PublicKey(proposer), permissions: Permissions.fromPermissions([Permission.Initiate]) }]
      : []),
  ];
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, programConfigPda);
  await confirmed(
    await multisig.rpc.multisigCreateV2({
      connection: conn,
      treasury: programConfig.treasury,
      createKey,
      creator: payer,
      multisigPda,
      // Autonomous: membership and the time lock change only by the members' own vote.
      configAuthority: null,
      threshold,
      members,
      timeLock,
      rentCollector: null,
    }),
  );
  const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
  const all = saved();
  all[kind] = {
    multisig: multisigPda.toBase58(),
    vault: vault.toBase58(),
    threshold,
    timeLock,
    members: voters,
    ...(proposer ? { proposer } : {}),
  };
  writeJson(FILE, all);
  console.log(`${kind} multisig ${multisigPda.toBase58()}, vault ${vault.toBase58()} → ${FILE}`);
}

/** Moves the program's upgrade authority from the deployer to the upgrade multisig's vault. */
async function handover() {
  guard();
  const up = entry("upgrade");
  const deployer = await loadKeypair(env("DEPLOYER_KEYPAIR", `keys/${network}-deployer-keypair.json`));
  const { send } = connect(rpcUrl, env("WS_URL", rpcUrl.replace(/^http/, "ws").replace(":8899", ":8900")));
  const sig = await send(deployer, [
    {
      programAddress: BPF_UPGRADEABLE_LOADER,
      accounts: [
        { address: await programDataAddress(UNSPENT_PROGRAM_ADDRESS), role: AccountRole.WRITABLE },
        { address: deployer.address, role: AccountRole.READONLY_SIGNER, signer: deployer },
        { address: address(up.vault), role: AccountRole.READONLY },
      ],
      data: Uint8Array.of(4, 0, 0, 0),
    } as Instruction,
  ]);
  console.log(`upgrade authority → ${up.vault}: ${sig}`);
}

async function propose(kind: string | undefined, action: string | undefined, rest: string[]) {
  guard();
  const e = entry(kind);
  if (!action) throw new Error("Missing action");
  const proposer = web3Keypair(env("PROPOSER_KEYPAIR"));
  const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, e.pda);
  const transactionIndex = BigInt(ms.transactionIndex.toString()) + 1n;
  const ixs = await actionInstructions(kind as Kind, address(e.vault), action, rest);
  const { blockhash } = await conn.getLatestBlockhash();
  const transactionMessage = new TransactionMessage({
    payerKey: e.vaultKey,
    recentBlockhash: blockhash,
    instructions: ixs.map(toWeb3),
  });
  const memo = [action, ...rest].join(" ");
  await confirmed(
    await multisig.rpc.vaultTransactionCreate({
      connection: conn,
      feePayer: proposer,
      multisigPda: e.pda,
      transactionIndex,
      creator: proposer.publicKey,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage,
      memo,
    }),
  );
  await confirmed(
    await multisig.rpc.proposalCreate({
      connection: conn,
      feePayer: proposer,
      creator: proposer,
      multisigPda: e.pda,
      transactionIndex,
    }),
  );
  console.log(`${kind} proposal #${transactionIndex}: ${memo}`);
  console.log(`Members approve and execute it in the Squads app (${e.threshold} of ${e.members.length}).`);
}

async function vote(kind: string | undefined, index: string | undefined, execute: boolean) {
  guard();
  const e = entry(kind);
  const member = web3Keypair(env("MEMBER_KEYPAIR"));
  const transactionIndex = BigInt(index ?? "");
  const sig = execute
    ? await multisig.rpc.vaultTransactionExecute({
        connection: conn,
        feePayer: member,
        multisigPda: e.pda,
        transactionIndex,
        member: member.publicKey,
      })
    : await multisig.rpc.proposalApprove({
        connection: conn,
        feePayer: member,
        member,
        multisigPda: e.pda,
        transactionIndex,
      });
  await confirmed(sig);
  console.log(
    `${kind} #${transactionIndex} ${execute ? "executed" : `approved by ${member.publicKey.toBase58()}`}: ${sig}`,
  );
}

async function show(kind: string | undefined) {
  const e = entry(kind);
  const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, e.pda);
  const last = Number(ms.transactionIndex.toString());
  console.log(`${kind} multisig ${e.multisig}, vault ${e.vault}`);
  console.log(
    `threshold ${ms.threshold} of ${ms.members.length}, time lock ${ms.timeLock} s, last index ${last}`,
  );
  for (let i = Math.max(1, last - 9); i <= last; i++) {
    const [pda] = multisig.getProposalPda({ multisigPda: e.pda, transactionIndex: BigInt(i) });
    const p = await multisig.accounts.Proposal.fromAccountAddress(conn, pda).catch(() => null);
    console.log(
      `  #${i}: ${p ? p.status.__kind : "no proposal"}${p ? `, approved ${p.approved.length}` : ""}`,
    );
  }
  if (kind !== "admin") return;
  // What the admin controls, as the program sees it now.
  const { rpc } = connect(rpcUrl, rpcUrl.replace(/^http/, "ws"));
  const c = (await fetchConfig(rpc, (await findConfigPda())[0])).data;
  console.log(
    `program: buy_paused ${c.buyPaused}, deposit_paused ${c.depositPaused}, gateway_paused ${c.gatewayPaused}, ` +
      `shut_down ${c.shutDown}`,
  );
  console.log(
    `gateway ${c.gateway.__option === "Some" ? c.gateway.value : "none"}, backup ${
      c.gatewayBackup.__option === "Some" ? c.gatewayBackup.value : "none"
    }, treasury ${c.treasury}`,
  );
  c.pending.forEach((p, i) => {
    if (p.effectiveAt !== 0n)
      console.log(
        `pending ${ConfigField[i]}: value ${p.value}, key ${p.key}, effective ${new Date(Number(p.effectiveAt) * 1000).toISOString()}`,
      );
  });
}

if (import.meta.main) {
  switch (cmd) {
    case "create":
      await create(args[0]);
      break;
    case "handover":
      await handover();
      break;
    case "propose":
      await propose(args[0], args[1], args.slice(2));
      break;
    case "approve":
      await vote(args[0], args[1], false);
      break;
    case "execute":
      await vote(args[0], args[1], true);
      break;
    case "show":
      await show(args[0]);
      break;
    default:
      console.log("squads create|handover|propose|approve|execute|show (see the header of ops/squads.ts)");
      process.exit(1);
  }
}
