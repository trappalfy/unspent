"use client";

import { address } from "@solana/kit";
import { type ReactNode, useState } from "react";
import { browserRpc } from "@/lib/chain/browser";
import { sellCredits } from "@/lib/chain/build";
import { composeSwap, fetchBuild, type JupiterBuild } from "@/lib/chain/jupiter";
import type { ProgramState, ReservationRow, UserState, WalletState } from "@/lib/chain/read";
import { prepare, TxTooLargeError } from "@/lib/chain/tx";
import { credits, formatUnits, parseUnits } from "@/lib/format";
import { TxButton, useTxPlan } from "./Tx";
import { Credits, Notice, Preview } from "./ui";

type Props = {
  owner: string;
  program: ProgramState;
  user: UserState;
  wallet: WalletState;
  expired: ReservationRow[];
};

/** Sell: credits from the wallet first, the rest withdrawn from the API balance in the same transaction (5.8). */
export function SellForm({ owner, program, user, wallet, expired }: Props) {
  const [input, setInput] = useState("");
  const [slippage, setSlippage] = useState(100);
  const closing = expired.slice(0, 10);
  const freed = closing.reduce((s, r) => s + r.amount, 0n);
  const max = wallet.credits + user.available + freed;
  const amount = parseUnits(input, 6);
  const fromBalance = amount && amount > wallet.credits ? amount - wallet.credits : 0n;
  const err =
    input && amount === null
      ? "Enter a number with up to 6 decimals."
      : amount === 0n
        ? "Enter an amount above zero."
        : amount && amount > max
          ? `You can sell up to ${credits(max)} credits.`
          : null;

  const plan = useTxPlan<JupiterBuild>(amount && !err ? `sell:${amount}:${slippage}` : null, async () => {
    const rpc = browserRpc();
    const r = await composeSwap(
      (maxAccounts) =>
        fetchBuild({
          side: "sell",
          mint: program.creditMint,
          amount: amount!,
          taker: owner,
          slippageBps: slippage,
          maxAccounts,
        }),
      (b) => sellCredits({ owner, program }, b, fromBalance, fromBalance > user.available ? closing : []),
      (ixs, alts) => prepare(rpc, address(owner), ixs, alts),
      (e) => e instanceof TxTooLargeError,
    );
    return { prepared: r.prepared, ixs: r.ixs, info: r.build };
  });
  const b = plan.quote.status === "ready" ? plan.quote.ready.info : null;

  return (
    <div className="flex max-w-xl flex-col gap-5">
      <label className="flex flex-col gap-2 text-sm">
        Credits to sell
        <div className="flex gap-2">
          <input
            className="input flex-1"
            inputMode="decimal"
            placeholder="10"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button
            type="button"
            className="btn min-h-10 px-3 text-xs"
            disabled={max === 0n}
            onClick={() => setInput(formatUnits(max, 6).replace(/,/g, ""))}
          >
            Max
          </button>
        </div>
        <span className="text-xs text-mute">
          In wallet: <Credits ucr={wallet.credits} digits={4} /> · API balance available:{" "}
          <Credits ucr={user.available} digits={4} />
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-mute">Slippage</span>
        {[50, 100, 200].map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={slippage === s}
            className={`border px-3 py-1 text-xs ${slippage === s ? "border-fg" : "border-line text-mute"}`}
            onClick={() => setSlippage(s)}
          >
            {s / 100}%
          </button>
        ))}
      </div>
      {err && <Notice kind="ERROR">{err}</Notice>}
      {b && amount ? (
        <Preview
          rows={[
            ["You sell", <Credits key="a" ucr={amount} unit />],
            ...(fromBalance > 0n
              ? ([["Withdrawn first", <Credits key="w" ucr={fromBalance} unit />]] as [string, ReactNode][])
              : []),
            ["You get at least", `${formatUnits(BigInt(b.otherAmountThreshold), 6, 4)} USDC`],
            ["Expected", `${formatUnits(BigInt(b.outAmount), 6, 4)} USDC`],
            ["Price impact", `${(Number(b.priceImpactPct ?? 0) * 100).toFixed(2)}%`],
            ["Route", [...new Set(b.routePlan.map((r) => r.swapInfo.label))].join(" → ") || "Jupiter"],
          ]}
        />
      ) : null}
      <p className="text-xs text-mute">
        The price is the market&apos;s, quoted by Jupiter. Unspent doesn&apos;t buy credits back while it
        runs.
      </p>
      <TxButton
        label={amount && !err ? `Sell ${credits(amount)} credits` : "Sell credits"}
        plan={plan}
        onDone={() => setInput("")}
      />
    </div>
  );
}
