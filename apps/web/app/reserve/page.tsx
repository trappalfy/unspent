import { recentSettlements } from "@unspent/indexer";
import { UNSPENT_PROGRAM_ADDRESS } from "@unspent/program";
import { formatCredits } from "@unspent/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Empty, Stat } from "@/components/app/ui";
import { Roll } from "@/components/Roll";
import { TableWrap } from "@/components/TableWrap";
import { countReservations, readReserveBalances } from "@/lib/chain/read";
import { explorerAddress, explorerTx, network } from "@/lib/env";
import { getDb } from "@/lib/server/db";
import { getProgram } from "@/lib/server/program";
import { serverRpc } from "@/lib/server/rpc";

export const metadata: Metadata = {
  title: "Reserve",
  description:
    "Every credit in circulation is backed by 1 USDC in the program's reserve. Live onchain numbers.",
};
export const dynamic = "force-dynamic";

/** A large figure (credits or USDC, both 6 decimals) that rolls in once; the exact amount is in the tooltip. */
function Fig({ v }: { v: bigint }) {
  const exact = `${(Number(v) / 1e6).toFixed(6)}`;
  return (
    <span title={exact}>
      <Roll text={v > 0n && v < 10_000n ? "<0.01" : formatCredits(v, 2)} />
    </span>
  );
}

function Addr({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-line py-2 md:flex-row md:items-center md:justify-between">
      <span className="text-sm text-mute">{label}</span>
      <a
        className="break-all text-sm underline"
        href={explorerAddress(value)}
        target="_blank"
        rel="noreferrer"
      >
        {value}
      </a>
    </div>
  );
}

/** Coverage = reserve / supply, floored to 0.01%; 100% means every credit is backed 1:1. */
function coverage(reserve: bigint, supply: bigint): string {
  if (supply === 0n) return "—";
  const bp = (reserve * 10_000n) / supply;
  return `${bp / 100n}.${String(bp % 100n).padStart(2, "0")}%`;
}

async function settlements() {
  try {
    return await recentSettlements(await getDb(), network, 20);
  } catch {
    return null;
  }
}

async function load() {
  try {
    const program = await getProgram(0);
    if (!program) return null;
    const rpc = serverRpc();
    const [balances, holds, recent] = await Promise.all([
      readReserveBalances(rpc, program),
      countReservations(rpc),
      settlements(),
    ]);
    return { program, balances, holds, recent };
  } catch {
    return "unavailable" as const;
  }
}

export default async function ReservePage() {
  const data = await load();
  if (data === null || data === "unavailable")
    return (
      <section className="mx-auto max-w-[1280px] px-4 py-16 md:px-8">
        <AutoRefresh seconds={15} />
        <h1 className="text-xl">Reserve</h1>
        <p className="mt-4 text-sm text-mute">
          {data === null
            ? "Unspent isn’t running on this network yet."
            : "The chain can’t be read right now. This page retries every 15 seconds."}
        </p>
      </section>
    );
  const { program, balances, holds, recent } = data;

  return (
    <section className="mx-auto flex max-w-[1280px] flex-col gap-8 px-4 py-12 md:px-8">
      <AutoRefresh seconds={15} />
      <header className="flex flex-col gap-3">
        <h1 className="text-xl md:text-2xl">Reserve</h1>
        <p className="max-w-2xl text-sm text-mute">
          Every credit in circulation is backed by 1 USDC held by the program, not by Unspent. These numbers
          are read from the chain and refresh every 15 seconds. Until program upgrades are frozen, this also
          depends on whoever holds the program&apos;s upgrade authority; see{" "}
          <Link className="underline" href="/docs/onchain">
            Onchain
          </Link>
          .
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Credits in circulation">
          <Fig v={program.supply} />
        </Stat>
        <Stat label="USDC in reserve">
          <Fig v={balances.reserveUsdc} />
        </Stat>
        <Stat label="Coverage" hint="reserve ÷ circulation, at least 100%">
          <Roll text={coverage(balances.reserveUsdc, program.supply)} />
        </Stat>
        <Stat label="On API balances" hint="credits in the program's vault">
          <Fig v={program.totalUserBalance} />
        </Stat>
        <Stat label="Spent and burned" hint="credits spent on inference">
          <Fig v={program.totalBurned} />
        </Stat>
        <Stat label="Sent to treasury" hint="USDC for burned credits, 1:1">
          <Fig v={program.totalReleased} />
        </Stat>
        <Stat label="Held right now" hint={`${holds} running request${holds === 1 ? "" : "s"}`}>
          <Fig v={program.activeReserved} />
        </Stat>
        {program.shutDown ? (
          <Stat label="Redeemed" hint="after shutdown, 1 credit → 1 USDC">
            <Fig v={program.totalRedeemed} />
          </Stat>
        ) : (
          <Stat label="Surplus withdrawn" hint="USDC above circulation only">
            <Fig v={program.totalSweptUsdc} />
          </Stat>
        )}
      </div>
      {program.shutDown && (
        <p className="text-sm">
          <span className="notice">[!]</span> Unspent is shut down. Holders redeem credits for USDC 1:1.
        </p>
      )}

      <div className="flex flex-col gap-3">
        <h2 className="text-base font-medium">Latest settlements</h2>
        <p className="text-sm text-mute">
          Each API request is two program transactions: a hold when it starts and a settlement when it ends.
          Only the charged part is burned; the rest of the hold returns to the user.
        </p>
        {recent === null ? (
          <Empty>Settlement history is temporarily unavailable.</Empty>
        ) : recent.length === 0 ? (
          <Empty>No settlements yet.</Empty>
        ) : (
          <TableWrap label="Latest settlements">
            <table>
              <thead>
                <tr>
                  <th>Time (UTC)</th>
                  <th>Wallet</th>
                  <th>Request</th>
                  <th className="num">Held</th>
                  <th className="num">Charged</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((s) => (
                  <tr key={`${s.signature}-${s.requestId}`}>
                    <td className="whitespace-nowrap">
                      {s.blockTime ? new Date(s.blockTime).toISOString().slice(0, 19).replace("T", " ") : "—"}
                    </td>
                    <td>{s.owner ? `${s.owner.slice(0, 4)}…${s.owner.slice(-4)}` : "—"}</td>
                    <td title={s.requestId}>{s.requestId.slice(0, 10)}…</td>
                    <td className="num">{formatCredits(BigInt(s.reserved), 4)}</td>
                    <td className="num">{formatCredits(BigInt(s.actual), 4)}</td>
                    <td>
                      <a
                        className="underline"
                        href={explorerTx(s.signature)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {s.signature.slice(0, 8)}…
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </div>

      <div className="flex flex-col">
        <h2 className="mb-2 text-base font-medium">Addresses</h2>
        <Addr label="Program" value={UNSPENT_PROGRAM_ADDRESS} />
        <Addr label="Credit mint" value={program.creditMint} />
        <Addr label="Reserve (USDC)" value={program.reserve} />
        <Addr label="Vault (API balances)" value={program.vault} />
        <Addr label="Treasury" value={program.treasury} />
        <Addr label="Config" value={program.config} />
      </div>
    </section>
  );
}
