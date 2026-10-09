// Reads straight from the program's accounts (brief 9.1: balances never come from our DB). Works on the server
// (private RPC) and in the browser (through /api/rpc).

import {
  type Address,
  address,
  getBase58Decoder,
  getBase64Encoder,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  fetchAllMaybeToken,
  fetchMaybeMint,
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  type ConfigField,
  decodeUpgradeAuthority,
  fetchMaybeConfig,
  fetchMaybeUserAccount,
  findConfigPda,
  findProgramDataAddress,
  findUserPda,
  getReservationDecoder,
  RESERVATION_DISCRIMINATOR,
  UNSPENT_PROGRAM_ADDRESS,
} from "@unspent/program";

export type AppRpc = Rpc<SolanaRpcApi>;

export type PendingRow = { field: ConfigField; value: bigint; key: Address; effectiveAt: bigint };

export type ProgramState = {
  config: Address;
  admin: Address;
  gateway: Address | null;
  gatewayBackup: Address | null;
  creditMint: Address;
  usdcMint: Address;
  reserve: Address;
  vault: Address;
  treasury: Address;
  buyPaused: boolean;
  depositPaused: boolean;
  gatewayPaused: boolean;
  shutDown: boolean;
  maxBuyPerIx: bigint;
  supplyCap: bigint;
  maxReservation: bigint;
  maxReservedPerUser: bigint;
  burnCapPerWindow: bigint;
  reservationTtl: bigint;
  adminDelay: bigint;
  /** Delayed changes waiting for admin_delay (brief 6.2). */
  pending: PendingRow[];
  totalUserBalance: bigint;
  activeReserved: bigint;
  totalBurned: bigint;
  totalReleased: bigint;
  totalRedeemed: bigint;
  totalSweptUsdc: bigint;
  supply: bigint;
};

export type UserState = {
  exists: boolean;
  balance: bigint;
  reserved: bigint;
  available: bigint;
  /** 0 = the program-wide max_reserved_per_user. */
  reserveCap: bigint;
};

export type WalletState = {
  sol: bigint;
  usdc: bigint;
  credits: bigint;
  usdcAta: Address;
  creditAta: Address;
  usdcAtaExists: boolean;
  creditAtaExists: boolean;
};

export type ReservationRow = {
  address: Address;
  requestId: string;
  amount: bigint;
  expiresAt: number;
  payer: Address;
};

/** null when the program isn't initialized on this cluster yet. */
export async function readProgram(rpc: AppRpc): Promise<ProgramState | null> {
  const [config] = await findConfigPda();
  const acc = await fetchMaybeConfig(rpc, config, { commitment: "confirmed" });
  if (!acc.exists) return null;
  const c = acc.data;
  const mint = await fetchMaybeMint(rpc, c.creditMint, { commitment: "confirmed" });
  return {
    config,
    admin: c.admin,
    gateway: c.gateway.__option === "Some" ? c.gateway.value : null,
    gatewayBackup: c.gatewayBackup.__option === "Some" ? c.gatewayBackup.value : null,
    creditMint: c.creditMint,
    usdcMint: c.usdcMint,
    reserve: c.reserve,
    vault: c.vault,
    treasury: c.treasury,
    buyPaused: c.buyPaused,
    depositPaused: c.depositPaused,
    gatewayPaused: c.gatewayPaused,
    shutDown: c.shutDown,
    maxBuyPerIx: c.maxBuyPerIx,
    supplyCap: c.supplyCap,
    maxReservation: c.maxReservation,
    maxReservedPerUser: c.maxReservedPerUser,
    burnCapPerWindow: c.burnCapPerWindow,
    reservationTtl: c.reservationTtl,
    adminDelay: c.adminDelay,
    pending: c.pending.flatMap((p, field) => (p.effectiveAt === 0n ? [] : [{ field, ...p }])),
    totalUserBalance: c.totalUserBalance,
    activeReserved: c.activeReserved,
    totalBurned: c.totalBurned,
    totalReleased: c.totalReleased,
    totalRedeemed: c.totalRedeemed,
    totalSweptUsdc: c.totalSweptUsdc,
    supply: mint.exists ? mint.data.supply : 0n,
  };
}

export type ProgramCode = {
  /** The code was deleted with the loader's Close; the program can't run any more. */
  closed: boolean;
  /** null once upgrades are frozen (Q12) or the program is closed. */
  authority: Address | null;
  /** Rent held by the program's code account; Close returns it. */
  rentLamports: bigint;
};

/** The program's code account: who can upgrade or close it, and the rent it holds. */
export async function readProgramCode(rpc: AppRpc): Promise<ProgramCode> {
  const { value } = await rpc
    .getAccountInfo(await findProgramDataAddress(), { encoding: "base64", commitment: "confirmed" })
    .send();
  if (!value) return { closed: true, authority: null, rentLamports: 0n };
  const data = getBase64Encoder().encode(value.data[0]) as Uint8Array;
  return { closed: false, authority: decodeUpgradeAuthority(data), rentLamports: value.lamports };
}

export async function readUser(rpc: AppRpc, owner: string): Promise<UserState> {
  const [pda] = await findUserPda({ owner: address(owner) });
  const acc = await fetchMaybeUserAccount(rpc, pda, { commitment: "confirmed" });
  if (!acc.exists) return { exists: false, balance: 0n, reserved: 0n, available: 0n, reserveCap: 0n };
  const { balance, reserved, reserveCap } = acc.data;
  return { exists: true, balance, reserved, available: balance - reserved, reserveCap };
}

export async function ata(owner: string, mint: Address): Promise<Address> {
  const [a] = await findAssociatedTokenPda({
    owner: address(owner),
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return a;
}

export async function readWallet(rpc: AppRpc, owner: string, p: ProgramState): Promise<WalletState> {
  const [usdcAta, creditAta] = await Promise.all([ata(owner, p.usdcMint), ata(owner, p.creditMint)]);
  const [{ value: sol }, [usdc, credits]] = await Promise.all([
    rpc.getBalance(address(owner), { commitment: "confirmed" }).send(),
    fetchAllMaybeToken(rpc, [usdcAta, creditAta], { commitment: "confirmed" }),
  ]);
  return {
    sol,
    usdc: usdc?.exists ? usdc.data.amount : 0n,
    credits: credits?.exists ? credits.data.amount : 0n,
    usdcAta,
    creditAta,
    usdcAtaExists: !!usdc?.exists,
    creditAtaExists: !!credits?.exists,
  };
}

const b58 = getBase58Decoder();

export const toHex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The wallet's live reservations, found by the owner field at offset 8 — no Unspent DB involved (brief 5.5 p.9). */
export async function readReservations(rpc: AppRpc, owner: string): Promise<ReservationRow[]> {
  const accounts = await rpc
    .getProgramAccounts(UNSPENT_PROGRAM_ADDRESS, {
      commitment: "confirmed",
      encoding: "base64",
      filters: [
        { memcmp: { offset: 0n, bytes: b58.decode(RESERVATION_DISCRIMINATOR) as never, encoding: "base58" } },
        { memcmp: { offset: 8n, bytes: owner as never, encoding: "base58" } },
      ],
    })
    .send();
  const dec = getReservationDecoder();
  const enc = getBase64Encoder();
  return accounts
    .map(({ pubkey, account }) => {
      const r = dec.decode(enc.encode(account.data[0]));
      return {
        address: pubkey,
        requestId: toHex(r.requestId),
        amount: r.amount,
        expiresAt: Number(r.expiresAt),
        payer: r.payer,
      };
    })
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

/** Number of live reservations program-wide (for /reserve); data slice of 0 bytes keeps the response small. */
export async function countReservations(rpc: AppRpc): Promise<number> {
  const accounts = await rpc
    .getProgramAccounts(UNSPENT_PROGRAM_ADDRESS, {
      commitment: "confirmed",
      encoding: "base64",
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { memcmp: { offset: 0n, bytes: b58.decode(RESERVATION_DISCRIMINATOR) as never, encoding: "base58" } },
      ],
    })
    .send();
  return accounts.length;
}

/** Token balances behind the /reserve numbers. */
export async function readReserveBalances(rpc: AppRpc, p: ProgramState) {
  const [reserve, vault, treasury] = await fetchAllMaybeToken(rpc, [p.reserve, p.vault, p.treasury], {
    commitment: "confirmed",
  });
  return {
    reserveUsdc: reserve?.exists ? reserve.data.amount : 0n,
    vaultCredits: vault?.exists ? vault.data.amount : 0n,
    treasuryUsdc: treasury?.exists ? treasury.data.amount : 0n,
  };
}
