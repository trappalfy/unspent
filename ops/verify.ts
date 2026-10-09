// Read-only check of a launched deployment (go/no-go before opening the site): program, Config, credit mint,
// Metaplex metadata, reserve and vault, and both Squads multisigs, against ops/deployments/<network>*.json and the
// launch defaults. Sends nothing, so it is safe on mainnet. Env: NETWORK, RPC_URL, EXPECT_FROZEN=1 after Q12.

import { type Address, address, createSolanaRpc, getAddressDecoder } from "@solana/kit";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchMint, fetchToken, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import * as multisig from "@sqds/multisig";
import {
  fetchConfig,
  findConfigPda,
  findReservePda,
  findVaultPda,
  UNSPENT_PROGRAM_ADDRESS,
} from "@unspent/program";
import { PROGRAM_DEFAULTS } from "@unspent/shared";
import { env, METADATA_PROGRAM, metadataAddress, programDataAddress, readJson, USDC_MINT } from "./lib";

const network = env("NETWORK", "localnet");
const rpcUrl = env("RPC_URL", "http://127.0.0.1:8899");
const rpc = createSolanaRpc(rpcUrl);
const conn = new Connection(rpcUrl, "confirmed");
const deployment = readJson<{ creditMint: string; treasury: string; treasuryOwner: string; gateway: string }>(
  `ops/deployments/${network}.json`,
);
type Ms = { multisig: string; vault: string; threshold: number; timeLock: number; members: string[] };
const squads = readJson<{ admin: Ms; upgrade: Ms }>(`ops/deployments/${network}-squads.json`);

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
}
const b64 = async (a: Address) => {
  const r = await rpc.getAccountInfo(a, { encoding: "base64" }).send();
  return r.value
    ? { owner: r.value.owner, executable: r.value.executable, data: Buffer.from(r.value.data[0], "base64") }
    : null;
};
const addr = (bytes: Uint8Array) => getAddressDecoder().decode(bytes);

// Program and its upgrade authority
const prog = await b64(UNSPENT_PROGRAM_ADDRESS);
check("program is deployed and executable", !!prog?.executable, UNSPENT_PROGRAM_ADDRESS);
const pd = await b64(await programDataAddress(UNSPENT_PROGRAM_ADDRESS));
const authority = pd && pd.data[12] === 1 ? addr(pd.data.subarray(13, 45)) : null;
if (process.env.EXPECT_FROZEN === "1")
  check("upgrades are frozen (no upgrade authority)", pd !== null && authority === null);
else
  check(
    "upgrade authority is the upgrade multisig's vault",
    authority === squads.upgrade.vault,
    authority ?? "none",
  );

// Config
const [configPda] = await findConfigPda();
const c = (await fetchConfig(rpc, configPda)).data;
check("admin is the admin multisig's vault", c.admin === squads.admin.vault, c.admin);
check(
  "gateway is the launch gateway key",
  c.gateway.__option === "Some" && c.gateway.value === deployment.gateway,
);
const [treasuryAta] = await findAssociatedTokenPda({
  owner: address(deployment.treasuryOwner),
  mint: USDC_MINT,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});
check(
  "treasury is the USDC account of the treasury owner",
  c.treasury === treasuryAta && c.treasury === deployment.treasury,
);
check(
  "treasury owner is the admin multisig's vault",
  deployment.treasuryOwner === squads.admin.vault,
  deployment.treasuryOwner,
);
check("USDC mint is mainnet USDC", c.usdcMint === USDC_MINT);
check("credit mint matches the launch record", c.creditMint === deployment.creditMint);
const limits: [string, bigint, bigint][] = [
  ["max_buy_per_ix", c.maxBuyPerIx, PROGRAM_DEFAULTS.maxBuyPerIxUcr],
  ["supply_cap", c.supplyCap, PROGRAM_DEFAULTS.supplyCapUcr],
  ["max_reservation", c.maxReservation, PROGRAM_DEFAULTS.maxReservationUcr],
  ["max_reserved_per_user", c.maxReservedPerUser, PROGRAM_DEFAULTS.maxReservedPerUserUcr],
  ["burn_cap_per_window", c.burnCapPerWindow, PROGRAM_DEFAULTS.burnCapPerWindowUcr],
  ["reservation_ttl", c.reservationTtl, BigInt(PROGRAM_DEFAULTS.reservationTtlSec)],
  ["admin_delay", c.adminDelay, BigInt(PROGRAM_DEFAULTS.adminDelaySec)],
];
for (const [name, v, want] of limits) check(`${name} = ${want}`, v === want, String(v));
check("nothing paused, not shut down", !c.buyPaused && !c.depositPaused && !c.gatewayPaused && !c.shutDown);
check(
  "no pending admin changes",
  c.pending.every((p) => p.effectiveAt === 0n),
);

// Credit mint and metadata
const mint = (await fetchMint(rpc, c.creditMint)).data;
check("credit mint: 6 decimals", mint.decimals === 6);
check(
  "credit mint: mint authority is Config",
  mint.mintAuthority.__option === "Some" && mint.mintAuthority.value === configPda,
);
check("credit mint: no freeze authority", mint.freezeAuthority.__option === "None");
console.log(`  supply ${mint.supply} μcr`);
const meta = await b64(await metadataAddress(c.creditMint));
if (!meta) check("Metaplex metadata exists", false);
else {
  const d = meta.data;
  let o = 65;
  const str = () => {
    const n = d.readUInt32LE(o);
    const s = d
      .subarray(o + 4, o + 4 + n)
      .toString("utf8")
      .replace(/\0+$/, "");
    o += 4 + n;
    return s;
  };
  const [name, symbol, uri] = [str(), str(), str()];
  check("Metaplex metadata exists", meta.owner === METADATA_PROGRAM, `${name} / ${symbol} / ${uri}`);
  check(
    "metadata update authority is the admin multisig's vault",
    addr(d.subarray(1, 33)) === squads.admin.vault,
  );
}

// Reserve and vault
const [reservePda] = await findReservePda();
const [vaultPda] = await findVaultPda();
const reserve = (await fetchToken(rpc, reservePda)).data;
const vault = (await fetchToken(rpc, vaultPda)).data;
check("reserve: USDC account owned by Config", reserve.mint === USDC_MINT && reserve.owner === configPda);
check("vault: credit account owned by Config", vault.mint === c.creditMint && vault.owner === configPda);
check("reserve ≥ supply", reserve.amount >= mint.supply, `${reserve.amount} ≥ ${mint.supply}`);

// Squads
for (const kind of ["admin", "upgrade"] as const) {
  const e = squads[kind];
  const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, new PublicKey(e.multisig));
  const [vaultKey] = multisig.getVaultPda({ multisigPda: new PublicKey(e.multisig), index: 0 });
  const voters = ms.members.filter((m) =>
    multisig.types.Permissions.has(m.permissions, multisig.types.Permission.Vote),
  );
  check(`${kind} multisig: vault matches`, vaultKey.toBase58() === e.vault);
  check(
    `${kind} multisig: ${ms.threshold} of ${voters.length} voters`,
    ms.threshold >= 2 && voters.length >= 3,
  );
  check(`${kind} multisig: no config authority`, ms.configAuthority.equals(PublicKey.default));
  if (kind === "admin") check("admin multisig: no time lock", ms.timeLock === 0, `${ms.timeLock} s`);
  else
    check(
      "upgrade multisig: time lock ≥ admin_delay",
      BigInt(ms.timeLock) >= c.adminDelay,
      `${ms.timeLock} s`,
    );
}

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nDEPLOYMENT VERIFIED");
process.exit(failed ? 1 : 0);
