"use client";

import { type Address, address } from "@solana/kit";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { browserRpc } from "@/lib/chain/browser";
import { buyWithSwap, buyWithUsdc } from "@/lib/chain/build";
import {
  composeSwap,
  fetchBuild,
  fetchTokenInfo,
  type JupiterBuild,
  type TokenInfo,
} from "@/lib/chain/jupiter";
import type { ProgramState, UserState, WalletState } from "@/lib/chain/read";
import { ATA_RENT, prepare, TxTooLargeError, USER_ACCOUNT_RENT } from "@/lib/chain/tx";
import { credits, formatSol, formatUnits, parseUnits } from "@/lib/format";
import { TxButton, useTxPlan } from "./Tx";
import { Credits, Notice, Preview } from "./ui";

const C = 1_000_000n;
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];
/** SOL left untouched when buying with SOL: fees and rent for the accounts this purchase may create. */
const SOL_BUFFER = 10_000_000n;

type Props = { owner: string; program: ProgramState; user: UserState; wallet: WalletState };

function useSolCheck(p: Props, deposit: boolean, extraLamports = 0n) {
  const rent =
    (p.wallet.creditAtaExists ? 0n : ATA_RENT) + (deposit && !p.user.exists ? USER_ACCOUNT_RENT : 0n);
  const needed = rent + 50_000n + extraLamports;
  return { rent, short: p.wallet.sol < needed, needed };
}

function limitsError(p: ProgramState, amount: bigint): string | null {
  if (amount < C) return "The minimum purchase is 1 credit.";
  if (amount > p.maxBuyPerIx) return `Up to ${credits(p.maxBuyPerIx)} credits per purchase.`;
  const left = p.supplyCap > p.supply ? p.supplyCap - p.supply : 0n;
  if (amount > left) return `Only ${credits(left)} more credits can be issued right now.`;
  return null;
}

export function BuyForm(props: Props) {
  const [tab, setTab] = useState<"usdc" | "swap">("usdc");
  const [keep, setKeep] = useState(false);
  const { program } = props;
  if (program.shutDown) return <Notice>Buying is closed: Unspent is shut down.</Notice>;
  return (
    <div className="flex max-w-xl flex-col gap-6">
      {program.buyPaused && <Notice>Buying is paused right now. Try again later.</Notice>}
      <div role="tablist" className="flex border border-line">
        {(
          [
            ["usdc", "USDC"],
            ["swap", "Any token"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`flex-1 py-2 text-sm ${tab === id ? "bg-fg text-bg" : "text-mute hover:text-fg"}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "usdc" ? <UsdcBuy {...props} deposit={!keep} /> : <SwapBuy {...props} deposit={!keep} />}
      <label className="flex items-center gap-3 text-sm">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
        Keep in wallet
        <span className="text-mute">— don&apos;t move the credits to the API balance</span>
      </label>
    </div>
  );
}

function UsdcBuy(props: Props & { deposit: boolean }) {
  const { owner, program, wallet, deposit } = props;
  const [input, setInput] = useState("");
  const amount = parseUnits(input, 6);
  const invalid =
    input && amount === null
      ? "Enter a number with up to 6 decimals."
      : amount
        ? (limitsError(program, amount) ??
          (amount > wallet.usdc ? `You have ${formatUnits(wallet.usdc, 6, 2)} USDC.` : null))
        : null;
  const sol = useSolCheck(props, deposit);
  const key = amount && !invalid && !program.buyPaused ? `usdc:${amount}:${deposit}` : null;
  const plan = useTxPlan(key, async () => {
    if (!amount) return null;
    const ixs = await buyWithUsdc({ owner, program }, amount, deposit);
    return { ixs, prepared: await prepare(browserRpc(), address(owner), ixs), info: undefined };
  });

  return (
    <div className="flex flex-col gap-5">
      <label className="flex flex-col gap-2 text-sm">
        Credits to buy
        <input
          className="input"
          inputMode="decimal"
          placeholder="25"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <span className="text-xs text-mute">
          1 credit = 1 USDC = $1 of inference. Wallet: {formatUnits(wallet.usdc, 6, 2)} USDC
        </span>
      </label>
      {invalid && <Notice kind="ERROR">{invalid}</Notice>}
      {amount && !invalid ? (
        <Preview
          rows={[
            ["You pay", `${formatUnits(amount, 6)} USDC`],
            ["You get", <Credits key="c" ucr={amount} unit />],
            ["Goes to", deposit ? "API balance" : "Your wallet"],
            ...(sol.rent ? ([["New accounts", `${formatSol(sol.rent)} rent`]] as [string, string][]) : []),
          ]}
        />
      ) : null}
      {sol.short && (
        <Notice>
          Not enough SOL for network fees{sol.rent ? " and account rent" : ""}. Add about{" "}
          {formatSol(sol.needed)}.
        </Notice>
      )}
      <TxButton
        label={amount && !invalid ? `Buy ${formatUnits(amount, 6)} credits` : "Buy credits"}
        plan={plan}
        disabled={sol.short}
        onDone={() => setInput("")}
      />
    </div>
  );
}

type WalletToken = { mint: string; amount: bigint; decimals: number; info?: TokenInfo };

function useWalletTokens(owner: string, exclude: string[]) {
  const [tokens, setTokens] = useState<WalletToken[] | null>(null);
  const excludeKey = exclude.join(",");
  useEffect(() => {
    let live = true;
    (async () => {
      const rpc = browserRpc();
      const [{ value: sol }, ...lists] = await Promise.all([
        rpc.getBalance(address(owner), { commitment: "confirmed" }).send(),
        ...TOKEN_PROGRAMS.map((programId) =>
          rpc
            .getTokenAccountsByOwner(
              address(owner),
              { programId: programId as Address },
              { encoding: "jsonParsed", commitment: "confirmed" },
            )
            .send(),
        ),
      ]);
      const skip = new Set(excludeKey.split(","));
      const spl: WalletToken[] = lists
        .flatMap((l) => l.value)
        .map((a) => {
          const info = (
            a.account.data as {
              parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } };
            }
          ).parsed.info;
          return {
            mint: info.mint,
            amount: BigInt(info.tokenAmount.amount),
            decimals: info.tokenAmount.decimals,
          };
        })
        .filter((t) => t.amount > 0n && !skip.has(t.mint));
      const all = [{ mint: WSOL, amount: sol > SOL_BUFFER ? sol - SOL_BUFFER : 0n, decimals: 9 }, ...spl];
      const meta = await fetchTokenInfo(all.map((t) => t.mint));
      if (live) setTokens(all.map((t) => ({ ...t, info: meta[t.mint] })));
    })().catch(() => live && setTokens([]));
    return () => {
      live = false;
    };
  }, [owner, excludeKey]);
  return tokens;
}

const SLIPPAGE = [50, 100, 200] as const;

function SwapBuy(props: Props & { deposit: boolean }) {
  const { owner, program, deposit } = props;
  const tokens = useWalletTokens(owner, [program.usdcMint, program.creditMint]);
  const [mint, setMint] = useState(WSOL);
  const [input, setInput] = useState("");
  const [slippage, setSlippage] = useState<number>(50);
  const token = tokens?.find((t) => t.mint === mint) ?? tokens?.[0];
  const decimals = token?.decimals ?? 9;
  const amount = parseUnits(input, decimals);
  const symbol = token?.info?.symbol ?? (token?.mint === WSOL ? "SOL" : `${token?.mint.slice(0, 4)}…`);
  const invalid =
    input && amount === null
      ? `Enter a number with up to ${decimals} decimals.`
      : amount && token && amount > token.amount
        ? `You have ${formatUnits(token.amount, decimals)} ${symbol}${token.mint === WSOL ? " to spend after fees" : ""}.`
        : null;
  const sol = useSolCheck(props, deposit, token?.mint === WSOL ? (amount ?? 0n) : 0n);
  const key =
    token && amount && !invalid && !program.buyPaused
      ? `swap:${token.mint}:${amount}:${slippage}:${deposit}`
      : null;

  const plan = useTxPlan<JupiterBuild>(key, async () => {
    if (!token || !amount) return null;
    const rpc = browserRpc();
    const r = await composeSwap(
      (maxAccounts) =>
        fetchBuild({
          side: "buy",
          mint: token.mint,
          amount,
          taker: owner,
          slippageBps: slippage,
          maxAccounts,
        }),
      async (b) => {
        const err = limitsError(program, BigInt(b.otherAmountThreshold));
        if (err) throw new Error(err.replace("purchase", "purchase from this swap"));
        return buyWithSwap({ owner, program }, b, deposit);
      },
      (ixs, alts) => prepare(rpc, address(owner), ixs, alts),
      (e) => e instanceof TxTooLargeError,
    );
    return { prepared: r.prepared, ixs: r.ixs, info: r.build };
  });

  const b = plan.quote.status === "ready" ? plan.quote.ready.info : null;
  const preview = useMemo(() => {
    if (!b || !token) return null;
    const inAmt = BigInt(b.inAmount);
    const out = BigInt(b.outAmount);
    const min = BigInt(b.otherAmountThreshold);
    const rate = inAmt > 0n ? (out * 10n ** BigInt(decimals)) / inAmt : 0n;
    const route = [...new Set(b.routePlan.map((r) => r.swapInfo.label))].join(" → ");
    return [
      ["You pay", `${formatUnits(inAmt, decimals)} ${symbol}`],
      ["Rate", `1 ${symbol} ≈ ${formatUnits(rate, 6, 4)} USDC`],
      ["You get at least", <Credits key="m" ucr={min} unit />],
      ["Expected", `${formatUnits(out, 6, 4)} USDC; anything above the minimum stays in your wallet as USDC`],
      ["Price impact", `${(Number(b.priceImpactPct ?? 0) * 100).toFixed(2)}%`],
      ["Slippage", `${slippage / 100}%`],
      ["Route", route || "Jupiter"],
      ["Jupiter fee", "none"],
      ["Goes to", deposit ? "API balance" : "Your wallet"],
    ] as [string, ReactNode][];
  }, [b, token, decimals, symbol, slippage, deposit]);

  if (tokens === null) return <p className="text-sm text-mute">Loading your tokens…</p>;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_1fr]">
        <label className="flex flex-col gap-2 text-sm">
          Pay with
          <select className="input" value={token?.mint ?? ""} onChange={(e) => setMint(e.target.value)}>
            {tokens.map((t) => (
              <option key={t.mint} value={t.mint}>
                {t.info?.symbol ?? (t.mint === WSOL ? "SOL" : `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`)} —{" "}
                {formatUnits(t.amount, t.decimals, 4)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-2 text-sm">
          Amount
          <div className="flex gap-2">
            <input
              className="input flex-1"
              inputMode="decimal"
              placeholder="0.5"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button
              type="button"
              className="btn min-h-10 px-3 text-xs"
              disabled={!token?.amount}
              onClick={() => token && setInput(formatUnits(token.amount, decimals).replace(/,/g, ""))}
            >
              Max
            </button>
          </div>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-mute">Slippage</span>
        {SLIPPAGE.map((s) => (
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
      {invalid && <Notice kind="ERROR">{invalid}</Notice>}
      {preview && <Preview rows={preview} />}
      {sol.short && (
        <Notice>Not enough SOL for this purchase and network fees. Add about {formatSol(sol.needed)}.</Notice>
      )}
      <p className="text-xs text-mute">
        The swap price is Jupiter&apos;s quote. You sign one transaction: swap to USDC, buy credits
        {deposit ? ", deposit" : ""}.
      </p>
      <TxButton
        label={b ? `Buy ${credits(BigInt(b.otherAmountThreshold))} credits` : "Buy credits"}
        plan={plan}
        disabled={sol.short}
        onDone={() => setInput("")}
      />
    </div>
  );
}
