"use client";

import { address } from "@solana/kit";
import { type ReactNode, useEffect, useState } from "react";
import { browserRpc } from "@/lib/chain/browser";
import { depositCredits, releaseExpired, setReserveCap, withdrawCredits } from "@/lib/chain/build";
import type { ProgramState, ReservationRow, UserState, WalletState } from "@/lib/chain/read";
import { prepare } from "@/lib/chain/tx";
import { credits, formatUnits, parseUnits } from "@/lib/format";
import { TxButton, TxDone, useTxPlan } from "./Tx";
import { Credits, Empty, Notice, Panel, Preview } from "./ui";

/** withdraw / expire take two accounts per hold; this keeps one transaction well under the account limit. */
const MAX_RELEASE_PER_TX = 10;

type Props = {
  owner: string;
  program: ProgramState;
  user: UserState;
  wallet: WalletState;
  reservations: ReservationRow[];
  /** Chain clock (unix s) when the page was rendered; reservations expire by the chain's clock, not the browser's. */
  chainNow: number;
};

function useChainClock(chainNow: number) {
  const [offset] = useState(() => chainNow - Math.floor(Date.now() / 1000));
  const [now, setNow] = useState(chainNow);
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000) + offset), 1000);
    return () => clearInterval(t);
  }, [offset]);
  return now;
}

function countdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s).padStart(2, "0")}`;
}

function AmountInput({
  value,
  onChange,
  max,
  label,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  max: bigint;
  label: string;
  hint: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm">
      {label}
      <div className="flex gap-2">
        <input
          className="input flex-1"
          inputMode="decimal"
          placeholder="0.00"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="btn min-h-10 px-3 text-xs"
          disabled={max === 0n}
          onClick={() => onChange(formatUnits(max, 6).replace(/,/g, ""))}
        >
          Max
        </button>
      </div>
      <span className="text-xs text-mute">{hint}</span>
    </label>
  );
}

function amountError(input: string, amount: bigint | null, max: bigint, what: string): string | null {
  if (!input) return null;
  if (amount === null) return "Enter a number with up to 6 decimals.";
  if (amount === 0n) return "Enter an amount above zero.";
  if (amount > max) return `You can ${what} up to ${credits(max)} credits.`;
  return null;
}

function Deposit({ owner, program, wallet }: Props) {
  const [input, setInput] = useState("");
  const amount = parseUnits(input, 6);
  const err = amountError(input, amount, wallet.credits, "deposit");
  const blocked = program.shutDown || program.depositPaused;
  const plan = useTxPlan(amount && !err && !blocked ? `deposit:${amount}` : null, async () => {
    const ixs = await depositCredits({ owner, program }, amount!);
    return { ixs, prepared: await prepare(browserRpc(), address(owner), ixs), info: undefined };
  });
  return (
    <Panel title="Deposit" id="deposit">
      <p className="text-sm text-mute">
        Move credits from your wallet to the API balance so your keys can spend them.
      </p>
      {blocked && <Notice>Deposits are {program.shutDown ? "closed" : "paused"} right now.</Notice>}
      <AmountInput
        label="Credits"
        value={input}
        onChange={setInput}
        max={wallet.credits}
        hint={
          <>
            In wallet: <Credits ucr={wallet.credits} digits={4} />
          </>
        }
      />
      {err && <Notice kind="ERROR">{err}</Notice>}
      {amount && !err ? (
        <Preview
          rows={[
            ["From wallet", <Credits key="a" ucr={amount} unit />],
            ["To API balance", <Credits key="b" ucr={amount} unit />],
          ]}
        />
      ) : null}
      <TxButton
        label={amount && !err ? `Deposit ${credits(amount)} credits` : "Deposit"}
        plan={plan}
        onDone={() => setInput("")}
      />
    </Panel>
  );
}

function Withdraw({ owner, program, user, expired }: Props & { expired: ReservationRow[] }) {
  const [input, setInput] = useState("");
  const amount = parseUnits(input, 6);
  const closing = expired.slice(0, MAX_RELEASE_PER_TX);
  const freed = closing.reduce((s, r) => s + r.amount, 0n);
  const max = user.available + freed;
  const err = amountError(input, amount, max, "withdraw");
  const plan = useTxPlan(amount && !err ? `withdraw:${amount}:${closing.length}` : null, async () => {
    const ixs = await withdrawCredits({ owner, program }, amount!, closing);
    return { ixs, prepared: await prepare(browserRpc(), address(owner), ixs), info: undefined };
  });
  return (
    <Panel title="Withdraw" id="withdraw">
      <p className="text-sm text-mute">
        Credits go back to your wallet right away. Withdrawals don&apos;t need our approval and work even when
        Unspent is paused.
      </p>
      <AmountInput
        label="Credits"
        value={input}
        onChange={setInput}
        max={max}
        hint={
          <>
            Available: <Credits ucr={user.available} digits={4} />
            {freed > 0n && (
              <>
                {" "}
                + <Credits ucr={freed} digits={4} /> from expired holds, released in the same transaction
              </>
            )}
          </>
        }
      />
      {err && <Notice kind="ERROR">{err}</Notice>}
      {amount && !err ? (
        <Preview
          rows={[
            ["From API balance", <Credits key="a" ucr={amount} unit />],
            ["To wallet", <Credits key="b" ucr={amount} unit />],
            ...(closing.length
              ? ([["Expired holds closed", String(closing.length)]] as [string, string][])
              : []),
          ]}
        />
      ) : null}
      <TxButton
        label={amount && !err ? `Withdraw ${credits(amount)} credits` : "Withdraw"}
        plan={plan}
        onDone={() => setInput("")}
      />
    </Panel>
  );
}

function Reservations({ owner, program, reservations, now }: Props & { now: number }) {
  const expired = reservations.filter((r) => r.expiresAt <= now);
  const batch = expired.slice(0, MAX_RELEASE_PER_TX);
  const [released, setReleased] = useState<string | null>(null);
  const plan = useTxPlan(
    batch.length ? `release:${batch.map((r) => r.address).join(",")}` : null,
    async () => {
      const ixs = await releaseExpired({ owner, program }, batch);
      return { ixs, prepared: await prepare(browserRpc(), address(owner), ixs), info: undefined };
    },
  );
  return (
    <Panel title="Held for running requests" id="holds">
      <p className="text-sm text-mute">
        Read directly from the program. A hold is settled when its request finishes; if it&apos;s still here
        after it expires, anyone can release it back to your available balance.
      </p>
      {reservations.length === 0 ? (
        <Empty>Nothing is held right now. Holds appear while your API requests run.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Request</th>
                <th className="num">Held</th>
                <th className="num">Expires</th>
              </tr>
            </thead>
            <tbody>
              {reservations.map((r) => (
                <tr key={r.address}>
                  <td title={r.requestId}>{r.requestId.slice(0, 12)}…</td>
                  <td className="num">
                    <Credits ucr={r.amount} digits={4} />
                  </td>
                  <td className="num">
                    {r.expiresAt <= now ? "expired" : `in ${countdown(r.expiresAt - now)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {expired.length > 0 ? (
        <TxButton
          label={`Release expired (${batch.length}${expired.length > batch.length ? ` of ${expired.length}` : ""})`}
          plan={plan}
          onDone={setReleased}
        />
      ) : (
        released && <TxDone signature={released}>Released. Those credits are available again.</TxDone>
      )}
    </Panel>
  );
}

function HoldLimit({ owner, program, user }: Props) {
  const [input, setInput] = useState("");
  const cap = parseUnits(input, 6);
  const err =
    input && cap === null
      ? "Enter a number with up to 6 decimals."
      : cap !== null && cap > program.maxReservedPerUser
        ? `The program-wide limit is ${credits(program.maxReservedPerUser)} credits; you can only go lower.`
        : null;
  const plan = useTxPlan(input && cap !== null && !err && user.exists ? `cap:${cap}` : null, async () => {
    const ixs = await setReserveCap({ owner, program }, cap!);
    return { ixs, prepared: await prepare(browserRpc(), address(owner), ixs), info: undefined };
  });
  const effective =
    user.reserveCap > 0n && user.reserveCap < program.maxReservedPerUser
      ? user.reserveCap
      : program.maxReservedPerUser;
  return (
    <Panel title="Max held at once" id="limit">
      <p className="text-sm text-mute">
        The most the gateway can hold from your balance at the same time. Lower it to cap what parallel
        requests can lock up. 0 restores the default of {credits(program.maxReservedPerUser)} credits.
      </p>
      <p className="text-sm">
        Now: <Credits ucr={effective} unit />
        {user.reserveCap === 0n && <span className="text-mute"> (default)</span>}
      </p>
      {!user.exists ? (
        <Empty>Deposit credits first; the limit lives on your API balance account.</Empty>
      ) : (
        <>
          <label className="flex flex-col gap-2 text-sm">
            New limit, credits
            <input
              className="input"
              inputMode="decimal"
              placeholder={credits(effective)}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </label>
          {err && <Notice kind="ERROR">{err}</Notice>}
          <TxButton label="Save limit" plan={plan} onDone={() => setInput("")} />
        </>
      )}
    </Panel>
  );
}

export function BalanceForms(props: Props) {
  const now = useChainClock(props.chainNow);
  const expired = props.reservations.filter((r) => r.expiresAt <= now);
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Deposit {...props} />
      <Withdraw {...props} expired={expired} />
      <Reservations {...props} now={now} />
      <HoldLimit {...props} />
    </div>
  );
}
