"use client";

import { address } from "@solana/kit";
import { useState } from "react";
import { browserRpc } from "@/lib/chain/browser";
import { redeemAll } from "@/lib/chain/build";
import type { ProgramState, ReservationRow, UserState, WalletState } from "@/lib/chain/read";
import { prepare } from "@/lib/chain/tx";
import { credits, formatUnits } from "@/lib/format";
import { TxButton, TxDone, useTxPlan } from "./Tx";
import { Credits, Empty, Notice, Preview } from "./ui";

type Props = {
  owner: string;
  program: ProgramState;
  user: UserState;
  wallet: WalletState;
  expired: ReservationRow[];
};

/** After shutdown: everything on the API balance comes back to the wallet and all credits redeem 1:1 (5.7). */
export function RedeemForm({ owner, program, user, wallet, expired }: Props) {
  const closing = expired.slice(0, 10);
  const freed = closing.reduce((s, r) => s + r.amount, 0n);
  const withdraw = user.available + freed;
  const total = wallet.credits + withdraw;
  const stillHeld = user.reserved - freed;
  const [done, setDone] = useState<string | null>(null);
  const plan = useTxPlan(total > 0n ? `redeem:${total}:${closing.length}` : null, async () => {
    const ixs = await redeemAll({ owner, program }, { withdraw, expired: closing, redeem: total });
    return { ixs, prepared: await prepare(browserRpc(), address(owner), ixs), info: undefined };
  });
  if (done && total === 0n) return <TxDone signature={done}>Redeemed. The USDC is in your wallet.</TxDone>;
  if (total === 0n && stillHeld <= 0n)
    return <Empty>Nothing to redeem: this wallet has no credits left.</Empty>;
  return (
    <div className="flex max-w-xl flex-col gap-5">
      <Preview
        rows={[
          ["From wallet", <Credits key="w" ucr={wallet.credits} unit />],
          ["From API balance", <Credits key="b" ucr={withdraw} unit />],
          ["You redeem", <Credits key="t" ucr={total} unit />],
          ["You get", `${formatUnits(total, 6)} USDC`],
        ]}
      />
      {stillHeld > 0n && (
        <Notice>
          <Credits ucr={stillHeld} unit /> are still held for running requests. They become available after
          they settle or expire; come back then.
        </Notice>
      )}
      <TxButton
        label={`Redeem ${credits(total)} credits for ${credits(total)} USDC`}
        plan={plan}
        onDone={setDone}
      />
    </div>
  );
}
