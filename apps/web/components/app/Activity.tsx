import type { HistoryEvent } from "@unspent/indexer";
import { explorerTx } from "@/lib/env";
import { Credits, Empty, Panel } from "./ui";

// Wallet history from the indexer (program events). Per-request holds and settlements live on /app/usage.
const LABEL: Partial<Record<HistoryEvent["name"], string>> = {
  CreditsBought: "Bought",
  Deposited: "Deposited to API balance",
  Withdrawn: "Withdrawn to wallet",
  Expired: "Expired hold released",
  Redeemed: "Redeemed for USDC",
  ReserveCapSet: "Max held at once set",
};

export function Activity({ events }: { events: HistoryEvent[] | null }) {
  const rows = events?.filter((e) => LABEL[e.name]).slice(0, 20) ?? null;
  return (
    <Panel title="Activity" id="activity">
      {rows === null ? (
        <Empty>
          History is temporarily unavailable. Balances above are read from the chain and are current.
        </Empty>
      ) : rows.length === 0 ? (
        <Empty>No activity yet. Purchases, deposits and withdrawals show up here.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Event</th>
                <th className="num">Credits</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const amount = (e.data.amount ?? e.data.cap) as string | undefined;
                return (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap">
                      {e.blockTime ? e.blockTime.toISOString().slice(0, 19).replace("T", " ") : "—"}
                    </td>
                    <td>{LABEL[e.name]}</td>
                    <td className="num">
                      {amount === undefined ? (
                        "—"
                      ) : e.name === "ReserveCapSet" && amount === "0" ? (
                        "default"
                      ) : (
                        <Credits ucr={BigInt(amount)} digits={4} />
                      )}
                    </td>
                    <td>
                      <a
                        className="underline"
                        href={explorerTx(e.signature)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {e.signature.slice(0, 8)}…
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
