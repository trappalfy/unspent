import "server-only";
import { address } from "@solana/kit";
import { UNSPENT_PROGRAM_ADDRESS } from "@unspent/program";
import {
  ADDRESSES,
  BPS_DENOMINATOR,
  CLAUDE_MODELS,
  chargeUcr,
  creditsPerMillion,
  decimalString,
  estimateInputTokens,
  findModel,
  MARKUP_BPS,
  type ModelEntry,
  PROGRAM_DEFAULTS,
  promptTokens,
  reservationUcr,
  reserveTierFor,
  tierFor,
  type Usage,
  ucrToCredits,
} from "@unspent/shared";
import type { ReactNode } from "react";
import { TableWrap } from "@/components/TableWrap";
import type { ProgramState } from "@/lib/chain/read";
import { apiBase, explorerAddress, network } from "@/lib/env";
import { getProgram } from "@/lib/server/program";
import { serverRpc } from "@/lib/server/rpc";

// Values shown in Docs come from the program's Config and models.ts, never typed by hand. Before launch (no program
// on this network) the launch defaults are shown.

async function program(): Promise<ProgramState | null> {
  try {
    return await getProgram(60_000);
  } catch {
    return null;
  }
}

const DEFAULTS = {
  maxReservation: PROGRAM_DEFAULTS.maxReservationUcr,
  maxReservedPerUser: PROGRAM_DEFAULTS.maxReservedPerUserUcr,
  maxBuyPerIx: PROGRAM_DEFAULTS.maxBuyPerIxUcr,
  supplyCap: PROGRAM_DEFAULTS.supplyCapUcr,
  reservationTtl: BigInt(PROGRAM_DEFAULTS.reservationTtlSec),
  adminDelay: BigInt(PROGRAM_DEFAULTS.adminDelaySec),
} as const;

type LimitName = keyof typeof DEFAULTS;

/** 25_000_000n → "25", 100_000_000_000n → "100,000". */
function plainCredits(ucr: bigint): string {
  const [whole, frac] = ucrToCredits(ucr).split(".");
  return `${BigInt(whole!).toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

function durationWords(seconds: bigint): string {
  const s = Number(seconds);
  if (s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? "" : "s"}`;
  if (s % 60 === 0) return `${s / 60} minutes`;
  return `${s} seconds`;
}

/** A program limit in words: "25 credits", "1 hour". */
export async function Limit({ name }: { name: LimitName }) {
  const p = await program();
  const v = p ? p[name] : DEFAULTS[name];
  return (
    <>
      {name === "reservationTtl" || name === "adminDelay" ? durationWords(v) : `${plainCredits(v)} credits`}
    </>
  );
}

export function ApiBase() {
  return <code>{apiBase}</code>;
}

function Addr({ value }: { value: string }) {
  return (
    <a href={explorerAddress(value)} target="_blank" rel="noreferrer" className="break-all">
      {value}
    </a>
  );
}

export async function Addresses() {
  const p = await program();
  const rows: [string, string | null][] = [
    ["Program", UNSPENT_PROGRAM_ADDRESS],
    ["Config", p?.config ?? null],
    ["Credit mint", p?.creditMint ?? null],
    ["Reserve (USDC)", p?.reserve ?? null],
    ["Vault (API balances)", p?.vault ?? null],
    ["Treasury", p?.treasury ?? null],
    ["USDC mint", p?.usdcMint ?? ADDRESSES[network].usdcMint],
  ];
  return (
    <>
      <TableWrap label={"Addresses"}>
        <table>
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{value ? <Addr value={value} /> : "published at launch"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {!p && (
        <p>The program is not live on this network yet. The remaining addresses appear here at launch.</p>
      )}
    </>
  );
}

type Parsed = { parsed?: { info?: Record<string, unknown> } };
const parsedInfo = (data: unknown) => (data as Parsed | null)?.parsed?.info;

/** Who can upgrade the program right now, read from its ProgramData account. */
export async function UpgradeAuthority() {
  try {
    const rpc = serverRpc();
    const prog = await rpc.getAccountInfo(UNSPENT_PROGRAM_ADDRESS, { encoding: "jsonParsed" }).send();
    const programData = parsedInfo(prog.value?.data)?.programData;
    if (typeof programData !== "string") throw new Error("not deployed");
    const pd = await rpc.getAccountInfo(address(programData), { encoding: "jsonParsed" }).send();
    const authority = parsedInfo(pd.value?.data)?.authority;
    return typeof authority === "string" ? (
      <>
        held by <Addr value={authority} />
      </>
    ) : (
      <>none: upgrades are frozen and the code can no longer change</>
    );
  } catch {
    return <>shown on the program account in any Solana explorer</>;
  }
}

function model(id: string): ModelEntry {
  const m = findModel(id);
  if (!m) throw new Error(`Docs: unknown model ${id}`);
  return m;
}

/** Exact credits for `tokens × price` with the markup, trailing zeros trimmed. */
function lineCredits(tokens: number, pusdPerToken: bigint): string {
  // pUSD × (10 000 + bps) / (10^12 × 10^4) = credits.
  return decimalString(BigInt(tokens) * pusdPerToken * (BPS_DENOMINATOR + BigInt(MARKUP_BPS)), 16);
}

function ExampleTable({ caption, rows, total }: { caption: string; rows: ReactNode[][]; total: ReactNode }) {
  return (
    <TableWrap label={caption}>
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th>Tokens</th>
            <th className="num">Count</th>
            <th className="num">Credits per 1M</th>
            <th className="num">Credits</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r[0])}>
              {r.map((c, i) => (
                <td key={String(i)} className={i ? "num" : undefined}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <th scope="row">Total</th>
            <td colSpan={3} className="num">
              {total}
            </td>
          </tr>
        </tbody>
      </table>
    </TableWrap>
  );
}

/** Metered cost of one request, line by line, from models.ts and the shared pricing math. */
export function CostExample(props: {
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}) {
  const m = model(props.model);
  const usage: Usage = {
    inputTokens: props.input,
    outputTokens: props.output,
    cacheReadInputTokens: props.cacheRead ?? 0,
    cacheCreationInputTokens: (props.cacheWrite5m ?? 0) + (props.cacheWrite1h ?? 0),
    cacheCreation1hInputTokens: props.cacheWrite1h ?? 0,
  };
  const p = tierFor(m, promptTokens(usage)).prices;
  const lines: [string, number, bigint][] = [
    ["Input", props.input, p.input],
    ["Cache read", props.cacheRead ?? 0, p.cacheRead],
    ["Cache write 5m", props.cacheWrite5m ?? 0, p.cacheWrite5m],
    ["Cache write 1h", props.cacheWrite1h ?? 0, p.cacheWrite1h],
    ["Output", props.output, p.output],
  ];
  return (
    <ExampleTable
      caption={`${m.displayName} request cost`}
      rows={lines
        .filter(([, n]) => n > 0)
        .map(([name, n, price]) => [
          name,
          n.toLocaleString("en-US"),
          creditsPerMillion(price),
          lineCredits(n, price),
        ])}
      total={`${ucrToCredits(chargeUcr(m, usage))} credits`}
    />
  );
}

/** What a request holds before it runs: estimated input plus max_tokens of output (brief 5.5 step 2). */
export function HoldExample(props: { model: string; textBytes: number; maxTokens: number }) {
  const m = model(props.model);
  const input = estimateInputTokens(props.textBytes, m.contextWindow);
  const p = reserveTierFor(m, input).prices;
  return (
    <ExampleTable
      caption={`${m.displayName} hold`}
      rows={[
        [
          `Input (${props.textBytes.toLocaleString("en-US")} bytes / 3)`,
          input.toLocaleString("en-US"),
          creditsPerMillion(p.input),
          lineCredits(input, p.input),
        ],
        [
          "Output (max_tokens)",
          props.maxTokens.toLocaleString("en-US"),
          creditsPerMillion(p.output),
          lineCredits(props.maxTokens, p.output),
        ],
      ]}
      total={`${ucrToCredits(reservationUcr(m, { inputTokens: input, maxTokens: props.maxTokens, cacheWrite: "none" }))} credits held`}
    />
  );
}

/** Web search price in credits per 1,000 searches, with the markup. */
export function WebSearchPrice() {
  const pusd = model("claude-sonnet-5-5").webSearchPusd ?? 0n;
  return <>{lineCredits(1000, pusd)} credits per 1,000 searches</>;
}

const tokens = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1000}k`);

/** Enabled models from models.ts. */
export function ModelList() {
  return (
    <TableWrap label={"Models"}>
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>ID</th>
            <th className="num">Context</th>
            <th className="num">Max output</th>
          </tr>
        </thead>
        <tbody>
          {CLAUDE_MODELS.filter((m) => m.enabled).map((m) => (
            <tr key={m.id}>
              <td className="whitespace-nowrap">{m.displayName}</td>
              <td>
                <code>{m.id}</code>
              </td>
              <td className="num">{tokens(m.contextWindow)}</td>
              <td className="num">{tokens(m.maxOutputTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}
