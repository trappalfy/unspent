"use client";

// The admin wallet's controls (brief 6.2; owner, 2026-10-10: no multisig, the admin wallet signs everything).
// Risk-reducing actions apply at once; risk-increasing ones wait admin_delay in the program and show as pending.
// Each action simulates only after it is opened, then the wallet signs.

import { type Address, address, createNoopSigner, type Instruction, isAddress } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  ConfigField,
  getActivateBackupGatewayInstructionAsync,
  getApplyPendingInstructionAsync,
  getCancelPendingInstructionAsync,
  getCloseProgramInstruction,
  getProposeGatewayBackupInstructionAsync,
  getProposeTreasuryInstructionAsync,
  getRevokeGatewayInstructionAsync,
  getSetLimitInstructionAsync,
  getSetPauseInstructionAsync,
  getSetUpgradeAuthorityInstruction,
  getShutdownInstructionAsync,
  getSweepSurplusInstructionAsync,
  getUpdateMetadataInstruction,
  getUpgradeProgramInstruction,
  PauseTarget,
  type TokenMetadata,
} from "@unspent/program";
import { type ReactNode, useId, useState } from "react";
import { browserRpc } from "@/lib/chain/browser";
import type { Holder, PendingRow, ProgramCode, ProgramState } from "@/lib/chain/read";
import { prepare } from "@/lib/chain/tx";
import { explorerAddress, publicEnv } from "@/lib/env";
import { exactCredits, formatSol, formatUnits, parseUnits } from "@/lib/format";
import { TxButton, TxDone, useTxPlan } from "./Tx";
import { Notice, Panel, Preview } from "./ui";

type Props = {
  admin: string;
  program: ProgramState;
  code: ProgramCode;
  balances: { reserveUsdc: bigint; vaultCredits: bigint; holds: number };
  holders: Holder[];
  metadata: TokenMetadata | null;
  now: number;
};

const LIMITS: { field: ConfigField; label: string; seconds?: true; get: (p: ProgramState) => bigint }[] = [
  { field: ConfigField.MaxBuyPerIx, label: "Max per purchase", get: (p) => p.maxBuyPerIx },
  { field: ConfigField.SupplyCap, label: "Supply cap", get: (p) => p.supplyCap },
  { field: ConfigField.MaxReservation, label: "Max hold per request", get: (p) => p.maxReservation },
  { field: ConfigField.MaxReservedPerUser, label: "Max hold per wallet", get: (p) => p.maxReservedPerUser },
  { field: ConfigField.BurnCapPerWindow, label: "Burn cap per 10 minutes", get: (p) => p.burnCapPerWindow },
  { field: ConfigField.ReservationTtl, label: "Hold lifetime", seconds: true, get: (p) => p.reservationTtl },
  { field: ConfigField.AdminDelay, label: "Admin delay", seconds: true, get: (p) => p.adminDelay },
];
const FIELD_LABEL: Record<ConfigField, string> = {
  ...(Object.fromEntries(LIMITS.map((l) => [l.field, l.label])) as Record<ConfigField, string>),
  [ConfigField.GatewayBackup]: "Backup gateway key",
  [ConfigField.Treasury]: "Treasury",
};

const seconds = (s: bigint) => (s % 3600n === 0n ? `${s / 3600n} h` : `${s} s`);
const utc = (unix: bigint) =>
  `${new Date(Number(unix) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function Addr({ value }: { value: string | null }) {
  if (!value) return <span className="text-mute">none</span>;
  return (
    <a className="break-all underline" href={explorerAddress(value)} target="_blank" rel="noreferrer">
      {value}
    </a>
  );
}

/** One admin action: closed until clicked; then it simulates, asks for a typed confirmation if needed, and signs. */
function Action({
  admin,
  id,
  label,
  build,
  confirm,
  children,
}: {
  admin: string;
  id: string;
  label: string;
  build: () => Promise<Instruction[]>;
  confirm?: string;
  children?: ReactNode;
}) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const armed = open && (!confirm || typed.trim() === confirm);
  const plan = useTxPlan(armed ? id : null, async () => {
    const ixs = await build();
    return { ixs, prepared: await prepare(browserRpc(), address(admin), ixs), info: undefined };
  });
  if (!open)
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          className="btn w-full md:w-auto"
          onClick={() => {
            setDone(null);
            setTyped("");
            setOpen(true);
          }}
        >
          {label}
        </button>
        {done && <TxDone signature={done}>Done.</TxDone>}
      </div>
    );
  return (
    <div className="flex flex-col gap-3 border-l border-line pl-4">
      {children}
      {confirm && (
        <label htmlFor={inputId} className="flex flex-col gap-1 text-sm">
          <span>
            Type <code>{confirm}</code> to confirm
          </span>
          <input
            id={inputId}
            className="input max-w-xs"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </label>
      )}
      <TxButton
        label={label}
        plan={plan}
        disabled={!armed}
        onDone={(sig) => {
          setDone(sig);
          setOpen(false);
        }}
      />
      <button type="button" className="self-start text-sm text-mute underline" onClick={() => setOpen(false)}>
        Close
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id} className="text-mute">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

export function AdminPanel({ admin, program: p, code, balances, holders, metadata, now }: Props) {
  const upgradeAuthority = code.authority;
  const signer = createNoopSigner(address(admin));
  const [limitField, setLimitField] = useState<ConfigField>(ConfigField.MaxReservation);
  const [limitValue, setLimitValue] = useState("");
  const [backupKey, setBackupKey] = useState("");
  const [treasuryOwner, setTreasuryOwner] = useState("");
  const [buffer, setBuffer] = useState("");
  const [token, setToken] = useState({
    name: metadata?.name ?? "",
    symbol: metadata?.symbol ?? "",
    uri: metadata?.uri ?? "",
  });
  const limit = LIMITS.find((l) => l.field === limitField) ?? LIMITS[0]!;
  const act = { admin };

  function parseLimit(): bigint {
    const raw = limitValue.trim();
    const v = limit.seconds ? (/^\d+$/.test(raw) ? BigInt(raw) : null) : parseUnits(raw, 6);
    if (v === null) throw new Error(limit.seconds ? "Enter whole seconds." : "Enter an amount in credits.");
    return v;
  }
  function addr(raw: string, what: string): Address {
    const v = raw.trim();
    if (!isAddress(v)) throw new Error(`Enter a valid ${what} address.`);
    return v;
  }
  const pause = (target: PauseTarget, paused: boolean) => async () => [
    await getSetPauseInstructionAsync({ admin: signer, target, paused }),
  ];

  const pauses: [PauseTarget, string, boolean][] = [
    [PauseTarget.Buy, "buying", p.buyPaused],
    [PauseTarget.Deposit, "deposits", p.depositPaused],
    [PauseTarget.Gateway, "API requests", p.gatewayPaused],
  ];
  const frozen = upgradeAuthority === null;
  // What closing would leave with the program for good: credits in circulation, the reserve and vault, open holds.
  // Owner, 2026-10-10: closing with funds left is allowed on purpose (a test of exactly that), behind its own
  // confirmation, with the holders listed.
  const blockers = [
    p.supply > 0n && `${exactCredits(p.supply)} are still in circulation.`,
    balances.reserveUsdc > 0n && `The reserve still holds ${formatUnits(balances.reserveUsdc, 6)} USDC.`,
    balances.vaultCredits > 0n &&
      `The vault still holds ${exactCredits(balances.vaultCredits)} of API balances.`,
    balances.holds > 0 && `${balances.holds} holds are still open.`,
  ].filter((b): b is string => !!b);

  if (code.closed)
    return (
      <Panel title="Program closed">
        <p className="text-sm">
          The program&apos;s code is deleted and its SOL deposit went back to the recipient. Nothing can run
          here any more.
        </p>
      </Panel>
    );

  return (
    <div className="flex flex-col gap-6">
      <Panel title="Status">
        <Preview
          rows={[
            ["Service", p.shutDown ? "Shut down" : "Running"],
            ...pauses.map(
              ([, name, paused]) =>
                [name[0]!.toUpperCase() + name.slice(1), paused ? "Paused" : "On"] as [string, ReactNode],
            ),
            ["Gateway key", <Addr key="g" value={p.gateway} />],
            ["Backup gateway key", <Addr key="b" value={p.gatewayBackup} />],
            ["Treasury", <Addr key="t" value={p.treasury} />],
            [
              "Upgrade authority",
              frozen ? (
                "Frozen: the code can't change"
              ) : upgradeAuthority === admin ? (
                "This wallet"
              ) : (
                <Addr key="u" value={upgradeAuthority} />
              ),
            ],
            ["Admin delay", seconds(p.adminDelay)],
          ]}
        />
      </Panel>

      {!p.shutDown && (
        <Panel title="Pauses">
          <p className="text-sm text-mute">
            Pausing applies at once. Withdrawals, settlement and expiry keep working.
          </p>
          <div className="flex flex-col gap-3">
            {pauses.map(([target, name, paused]) => (
              <Action
                key={target}
                {...act}
                id={`pause:${target}:${!paused}`}
                label={`${paused ? "Resume" : "Pause"} ${name}`}
                build={pause(target, !paused)}
              />
            ))}
          </div>
        </Panel>
      )}

      <Panel title="Limits">
        <Preview
          rows={LIMITS.map((l) => [l.label, l.seconds ? seconds(l.get(p)) : exactCredits(l.get(p))])}
        />
        <p className="text-sm text-mute">
          Lowering a limit applies at once. Raising one, or any change of the admin delay, waits{" "}
          {seconds(p.adminDelay)} and shows under pending changes.
        </p>
        <div className="flex flex-col gap-3 md:flex-row">
          <Field label="Limit">
            {(id) => (
              <select
                id={id}
                className="input"
                value={limitField}
                onChange={(e) => setLimitField(Number(e.target.value) as ConfigField)}
              >
                {LIMITS.map((l) => (
                  <option key={l.field} value={l.field}>
                    {l.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={limit.seconds ? "New value, seconds" : "New value, credits"}>
            {(id) => (
              <input
                id={id}
                className="input"
                inputMode="decimal"
                value={limitValue}
                onChange={(e) => setLimitValue(e.target.value)}
                autoComplete="off"
              />
            )}
          </Field>
        </div>
        <Action
          {...act}
          id={`limit:${limitField}:${limitValue}`}
          label="Set limit"
          build={async () => [
            await getSetLimitInstructionAsync({ admin: signer, field: limitField, value: parseLimit() }),
          ]}
        />
      </Panel>

      <Panel title="Pending changes">
        {p.pending.length === 0 ? (
          <p className="text-sm text-mute">Nothing pending.</p>
        ) : (
          p.pending.map((row: PendingRow) => {
            const ready = BigInt(now) >= row.effectiveAt;
            const keyed = row.field === ConfigField.GatewayBackup || row.field === ConfigField.Treasury;
            const lim = LIMITS.find((l) => l.field === row.field);
            return (
              <div key={row.field} className="flex flex-col gap-3 border-t border-line pt-3">
                <Preview
                  rows={[
                    ["Field", FIELD_LABEL[row.field]],
                    [
                      "New value",
                      keyed ? (
                        <Addr key="k" value={row.key} />
                      ) : lim?.seconds ? (
                        seconds(row.value)
                      ) : (
                        exactCredits(row.value)
                      ),
                    ],
                    ["Takes effect", `${utc(row.effectiveAt)}${ready ? ", ready to apply" : ""}`],
                  ]}
                />
                <div className="flex flex-col gap-3">
                  {ready && (
                    <Action
                      {...act}
                      id={`apply:${row.field}`}
                      label={`Apply: ${FIELD_LABEL[row.field]}`}
                      build={async () => [await getApplyPendingInstructionAsync({ field: row.field })]}
                    />
                  )}
                  <Action
                    {...act}
                    id={`cancel:${row.field}`}
                    label={`Cancel: ${FIELD_LABEL[row.field]}`}
                    build={async () => [
                      await getCancelPendingInstructionAsync({ admin: signer, field: row.field }),
                    ]}
                  />
                </div>
              </div>
            );
          })
        )}
      </Panel>

      <Panel title="Gateway key">
        <p className="text-sm text-mute">
          If the gateway key leaks: switch to the backup at once, or revoke the key. A new backup waits{" "}
          {seconds(p.adminDelay)}.
        </p>
        <Field label="Backup gateway key">
          {(id) => (
            <input
              id={id}
              className="input"
              value={backupKey}
              onChange={(e) => setBackupKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
        <Action
          {...act}
          id={`backup:${backupKey}`}
          label="Propose backup key"
          build={async () => [
            await getProposeGatewayBackupInstructionAsync({ admin: signer, key: addr(backupKey, "key") }),
          ]}
        />
        {p.gatewayBackup && (
          <Action
            {...act}
            id="activate-backup"
            label="Switch to the backup key"
            build={async () => [await getActivateBackupGatewayInstructionAsync({ admin: signer })]}
          >
            <Notice>
              The gateway server must already run with the backup key, or API requests stop until it does.
            </Notice>
          </Action>
        )}
        {p.gateway && (
          <Action
            {...act}
            id="revoke"
            label="Revoke the gateway key"
            confirm="REVOKE"
            build={async () => [await getRevokeGatewayInstructionAsync({ admin: signer })]}
          >
            <Notice>API requests stop until a backup key is activated.</Notice>
          </Action>
        )}
      </Panel>

      {metadata && (
        <Panel title="Token">
          <Preview
            rows={[
              ["Name", metadata.name || "none"],
              ["Symbol", metadata.symbol || "none"],
              ["Metadata URI", metadata.uri ? <span className="break-all">{metadata.uri}</span> : "none"],
            ]}
          />
          {metadata.updateAuthority !== admin ? (
            <p className="text-sm text-mute">Another key holds the metadata update authority.</p>
          ) : (
            <>
              <p className="text-sm text-mute">
                Wallets and explorers show these. They pick up a change within minutes to hours.
              </p>
              <div className="flex flex-col gap-3 md:flex-row">
                {(["name", "symbol", "uri"] as const).map((k) => (
                  <Field key={k} label={k === "uri" ? "Metadata URI" : k[0]!.toUpperCase() + k.slice(1)}>
                    {(id) => (
                      <input
                        id={id}
                        className="input"
                        value={token[k]}
                        onChange={(e) => setToken({ ...token, [k]: e.target.value })}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    )}
                  </Field>
                ))}
              </div>
              <button
                type="button"
                className="self-start text-sm text-mute underline"
                onClick={() =>
                  setToken({ ...token, name: "Unspent Credit", uri: `${publicEnv.siteUrl}/token.json` })
                }
              >
                Fill in the launch name and URI
              </button>
              <Action
                {...act}
                id={`metadata:${token.name}:${token.symbol}:${token.uri}`}
                label="Update token metadata"
                build={async () => [
                  await getUpdateMetadataInstruction({
                    mint: p.creditMint,
                    updateAuthority: signer,
                    name: token.name.trim(),
                    symbol: token.symbol.trim(),
                    uri: token.uri.trim(),
                  }),
                ]}
              />
            </>
          )}
        </Panel>
      )}

      <Panel title="Treasury">
        <p className="text-sm text-mute">
          USDC for spent credits goes to the treasury. A new treasury waits {seconds(p.adminDelay)}. Sweeping
          moves only USDC above the credits in circulation.
        </p>
        <Field label="New treasury owner (wallet address)">
          {(id) => (
            <input
              id={id}
              className="input"
              value={treasuryOwner}
              onChange={(e) => setTreasuryOwner(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
        <Action
          {...act}
          id={`treasury:${treasuryOwner}`}
          label="Propose new treasury"
          build={async () => {
            const owner = addr(treasuryOwner, "wallet");
            const [newTreasury] = await findAssociatedTokenPda({
              owner,
              mint: p.usdcMint,
              tokenProgram: TOKEN_PROGRAM_ADDRESS,
            });
            return [
              getCreateAssociatedTokenIdempotentInstruction({
                payer: signer,
                ata: newTreasury,
                owner,
                mint: p.usdcMint,
              }),
              await getProposeTreasuryInstructionAsync({ admin: signer, newTreasury }),
            ];
          }}
        />
        <Action
          {...act}
          id="sweep"
          label="Sweep surplus to the treasury"
          build={async () => [
            await getSweepSurplusInstructionAsync({
              admin: signer,
              creditMint: p.creditMint,
              vault: p.vault,
              reserve: p.reserve,
              treasury: p.treasury,
            }),
          ]}
        />
      </Panel>

      <Panel title="Program upgrades">
        {frozen ? (
          <p className="text-sm">Upgrades are frozen. The program&apos;s code can never change.</p>
        ) : upgradeAuthority !== admin ? (
          <p className="text-sm text-mute">Another key holds the upgrade authority.</p>
        ) : (
          <>
            <p className="text-sm text-mute">
              To upgrade, the new code is first written to a buffer whose authority is this wallet. Freezing
              is final: after it nobody can change the code, including you, and the program can&apos;t be
              closed to return its SOL deposit.
            </p>
            <Field label="Buffer address">
              {(id) => (
                <input
                  id={id}
                  className="input"
                  value={buffer}
                  onChange={(e) => setBuffer(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </Field>
            <Action
              {...act}
              id={`upgrade:${buffer}`}
              label="Upgrade the program from the buffer"
              confirm="UPGRADE"
              build={async () => [
                await getUpgradeProgramInstruction({
                  authority: signer,
                  buffer: addr(buffer, "buffer"),
                  spill: address(admin),
                }),
              ]}
            />
            <Action
              {...act}
              id="freeze"
              label="Freeze upgrades forever"
              confirm="FREEZE"
              build={async () => [
                await getSetUpgradeAuthorityInstruction({ authority: signer, newAuthority: null }),
              ]}
            />
          </>
        )}
      </Panel>

      {p.shutDown && upgradeAuthority === admin && (
        <Panel title="Close the program">
          <p className="text-sm text-mute">
            Deletes the program for good and returns its SOL deposit, {formatSol(code.rentLamports)}, to this
            wallet.
          </p>
          {blockers.length === 0 ? (
            <Action
              {...act}
              id="close"
              label="Close the program and return its SOL"
              confirm="CLOSE"
              build={async () => [
                await getCloseProgramInstruction({ authority: signer, recipient: address(admin) }),
              ]}
            />
          ) : (
            <>
              {blockers.map((b) => (
                <Notice key={b}>{b}</Notice>
              ))}
              <p className="text-sm">
                To close cleanly, holders redeem first and the surplus is swept. Closing now leaves this money
                with the program for good:
              </p>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-mute">
                <li>
                  USDC in the reserve stays in the reserve account. Nobody can move it again, including you.
                </li>
                <li>
                  Credits in wallets stay tokens: they can still be sent or traded, never redeemed or spent.
                </li>
                <li>Credits on API balances stay locked in the vault.</li>
              </ul>
              {holders.length > 0 && (
                <>
                  <p className="text-sm">Wallets holding credits. Check that every one is yours:</p>
                  <Preview
                    rows={holders.map((h) => [
                      `${h.owner.slice(0, 4)}…${h.owner.slice(-4)}`,
                      `wallet ${exactCredits(h.wallet)} · API balance ${exactCredits(h.apiBalance)}`,
                    ])}
                  />
                </>
              )}
              <Action
                {...act}
                id="close-with-funds"
                label="Close the program and leave the funds"
                confirm="LEAVE THE FUNDS"
                build={async () => [
                  await getCloseProgramInstruction({ authority: signer, recipient: address(admin) }),
                ]}
              />
            </>
          )}
        </Panel>
      )}

      {!p.shutDown && (
        <Panel title="Shut down">
          <p className="text-sm text-mute">
            Irreversible. Buying, deposits and new API requests stop for good. Withdrawals keep working, and
            every holder can redeem credits for USDC 1:1. Once everything is redeemed, the program can be
            closed to return its SOL deposit.
          </p>
          <Action
            {...act}
            id="shutdown"
            label="Shut down Unspent"
            confirm="SHUT DOWN"
            build={async () => [await getShutdownInstructionAsync({ admin: signer })]}
          />
        </Panel>
      )}
    </div>
  );
}
