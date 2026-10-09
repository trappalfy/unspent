// Launch: credit mint → Metaplex metadata → mint authority to the Config PDA → treasury USDC account → initialize.
// The program must already be deployed, and DEPLOYER must still be its upgrade authority (only it can initialize).
//
// Env: NETWORK (localnet|mainnet), RPC_URL, WS_URL, DEPLOYER_KEYPAIR, ADMIN, GATEWAY, TREASURY_OWNER,
//      TOKEN_NAME, TOKEN_SYMBOL, TOKEN_URI. Mainnet additionally requires CONFIRM_MAINNET=yes.

import { address } from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  AuthorityType,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getSetAuthorityInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { findConfigPda, getInitializeInstructionAsync, UNSPENT_PROGRAM_ADDRESS } from "@unspent/program";
import { PROGRAM_DEFAULTS } from "@unspent/shared";
import {
  connect,
  createMetadataV3Instruction,
  env,
  loadKeypair,
  loadOrCreateKeypair,
  programDataAddress,
  USDC_MINT,
  writeJson,
} from "./lib";

const network = env("NETWORK", "localnet");
const skipMetadata = process.env.SKIP_METADATA === "1";
if (skipMetadata && network !== "localnet")
  throw new Error("SKIP_METADATA is for an offline local fork only");
if (network !== "localnet" && network !== "mainnet") throw new Error(`NETWORK must be localnet or mainnet`);
if (network === "mainnet" && process.env.CONFIRM_MAINNET !== "yes") {
  throw new Error(
    "Refusing to touch mainnet without CONFIRM_MAINNET=yes (owner's explicit go, brief rule 0.3).",
  );
}

const { rpc, send } = connect(env("RPC_URL", "http://127.0.0.1:8899"), env("WS_URL", "ws://127.0.0.1:8900"));
const deployer = await loadKeypair(env("DEPLOYER_KEYPAIR", `keys/${network}-deployer-keypair.json`));
const admin = address(env("ADMIN"));
const gateway = address(env("GATEWAY"));
const treasuryOwner = address(env("TREASURY_OWNER"));
const mint = await loadOrCreateKeypair(`keys/${network}-credit-mint-keypair.json`);
const [config] = await findConfigPda();
const [treasury] = await findAssociatedTokenPda({
  owner: treasuryOwner,
  mint: USDC_MINT,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});

console.log(`network ${network}, program ${UNSPENT_PROGRAM_ADDRESS}, deployer ${deployer.address}`);
console.log(`credit mint ${mint.address}, config ${config}, treasury ${treasury}`);

const mintInfo = await rpc.getAccountInfo(mint.address, { encoding: "base64" }).send();
if (!mintInfo.value) {
  const lamports = await rpc.getMinimumBalanceForRentExemption(82n).send();
  const sig = await send(deployer, [
    getCreateAccountInstruction({
      payer: deployer,
      newAccount: mint,
      lamports,
      space: 82,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({
      mint: mint.address,
      decimals: 6,
      mintAuthority: deployer.address,
      freezeAuthority: null,
    }),
    // An offline local fork has no Metaplex program; metadata is skipped there only.
    ...(skipMetadata
      ? []
      : [
          await createMetadataV3Instruction({
            mint: mint.address,
            mintAuthority: deployer,
            payer: deployer,
            updateAuthority: admin,
            name: env("TOKEN_NAME", "Unspent Credit"),
            symbol: env("TOKEN_SYMBOL"),
            uri: env("TOKEN_URI"),
          }),
        ]),
    getSetAuthorityInstruction({
      owned: mint.address,
      owner: deployer,
      authorityType: AuthorityType.MintTokens,
      newAuthority: config,
    }),
    getCreateAssociatedTokenIdempotentInstruction({
      payer: deployer,
      ata: treasury,
      owner: treasuryOwner,
      mint: USDC_MINT,
    }),
  ]);
  console.log(`mint + metadata + authority → config: ${sig}`);
} else {
  console.log("credit mint exists, skipping creation");
}

const sig = await send(deployer, [
  await getInitializeInstructionAsync({
    authority: deployer,
    programData: await programDataAddress(UNSPENT_PROGRAM_ADDRESS),
    creditMint: mint.address,
    treasury,
    admin,
    gateway,
    maxBuyPerIx: PROGRAM_DEFAULTS.maxBuyPerIxUcr,
    supplyCap: PROGRAM_DEFAULTS.supplyCapUcr,
    maxReservation: PROGRAM_DEFAULTS.maxReservationUcr,
    maxReservedPerUser: PROGRAM_DEFAULTS.maxReservedPerUserUcr,
    burnCapPerWindow: PROGRAM_DEFAULTS.burnCapPerWindowUcr,
    reservationTtl: PROGRAM_DEFAULTS.reservationTtlSec,
    adminDelay: PROGRAM_DEFAULTS.adminDelaySec,
  }),
]);
console.log(`initialize: ${sig}`);

writeJson(`ops/deployments/${network}.json`, {
  network,
  program: UNSPENT_PROGRAM_ADDRESS,
  creditMint: mint.address,
  usdcMint: USDC_MINT,
  config,
  treasury,
  treasuryOwner,
  admin,
  gateway,
  initializedAt: new Date().toISOString(),
});
console.log(`wrote ops/deployments/${network}.json`);
