"use client";

import type { Instruction } from "@solana/kit";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@/components/wallet/WalletProvider";
import { browserRpc } from "@/lib/chain/browser";
import { instructionPrograms, type Prepared, signAndConfirm, TxError } from "@/lib/chain/tx";
import { explorerTx } from "@/lib/env";
import { formatSol } from "@/lib/format";
import { Notice } from "./ui";

export type Ready<T = undefined> = { prepared: Prepared; ixs: Instruction[]; info: T };

type Quote<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; ready: Ready<T>; at: number }
  | { status: "error"; message: string };

const STALE_MS = 30_000;

export function errorMessage(e: unknown): string {
  if (e instanceof TxError) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  if (/reject|cancel|denied|declined/i.test(msg)) return "You cancelled in the wallet. Nothing was sent.";
  return msg || "Something went wrong.";
}

/**
 * Builds + simulates a transaction whenever `key` changes (debounced), refreshing stale blockhashes and quotes.
 * `build` returns null when the form isn't complete; throwing shows its message under the form.
 */
export function useTxPlan<T>(key: string | null, build: () => Promise<Ready<T> | null>) {
  const [quote, setQuote] = useState<Quote<T>>({ status: "idle" });
  const buildRef = useRef(build);
  buildRef.current = build;
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const n = ++seq.current;
    setQuote((q) => (q.status === "ready" ? q : { status: "loading" }));
    try {
      const ready = await buildRef.current();
      if (n !== seq.current) return null;
      setQuote(ready ? { status: "ready", ready, at: Date.now() } : { status: "idle" });
      return ready;
    } catch (e) {
      if (n === seq.current) setQuote({ status: "error", message: errorMessage(e) });
      return null;
    }
  }, []);

  useEffect(() => {
    if (key === null) {
      seq.current++;
      setQuote({ status: "idle" });
      return;
    }
    setQuote({ status: "loading" });
    const t = setTimeout(() => void refresh(), 350);
    const i = setInterval(() => void refresh(), STALE_MS - 5_000);
    return () => {
      clearTimeout(t);
      clearInterval(i);
    };
  }, [key, refresh]);

  return { quote, refresh };
}

type Stage = "signing" | "confirming" | "done";
const STAGES: [Stage, string][] = [
  ["signing", "Signing"],
  ["confirming", "Confirming"],
  ["done", "Done"],
];

/** Shown in place of a form that has nothing left to do after its transaction landed. */
export function TxDone({ signature, children }: { signature: string; children: ReactNode }) {
  return (
    <p className="text-sm" aria-live="polite" data-stage="done">
      {children}{" "}
      <a className="underline" href={explorerTx(signature)} target="_blank" rel="noreferrer">
        View transaction ↗
      </a>
    </p>
  );
}

/** The action button + "Signing → Confirming → Done" with an explorer link and a readable error. */
export function TxButton<T>({
  label,
  plan,
  disabled,
  onDone,
}: {
  label: string;
  plan: ReturnType<typeof useTxPlan<T>>;
  disabled?: boolean;
  onDone?: (signature: string) => void;
}) {
  const { signTransaction } = useWallet();
  const router = useRouter();
  const [stage, setStage] = useState<Stage | null>(null);
  const [sig, setSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { quote } = plan;
  const busy = stage === "signing" || stage === "confirming";

  async function go() {
    setError(null);
    setSig(null);
    try {
      let ready = quote.status === "ready" && Date.now() - quote.at < STALE_MS ? quote.ready : null;
      ready ??= await plan.refresh();
      if (!ready) return;
      const signature = await signAndConfirm(
        browserRpc(),
        ready.prepared,
        signTransaction,
        (s, signature) => {
          setStage(s);
          if (signature) setSig(signature);
        },
        instructionPrograms(ready.ixs),
      );
      router.refresh();
      onDone?.(signature);
    } catch (e) {
      setStage(null);
      setError(errorMessage(e));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {quote.status === "ready" && (
        <p className="text-xs text-mute">Network fee ≈ {formatSol(quote.ready.prepared.feeLamports)}</p>
      )}
      {quote.status === "error" && !busy && <Notice kind="ERROR">{quote.message}</Notice>}
      <button
        type="button"
        className="btn btn-primary w-full md:w-auto"
        disabled={disabled || busy || quote.status !== "ready"}
        onClick={go}
      >
        {busy ? "Waiting…" : quote.status === "loading" ? "Checking…" : label}
      </button>
      {stage && (
        <p className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite" data-stage={stage}>
          {STAGES.map(([s, name], i) => {
            const idx = STAGES.findIndex(([x]) => x === stage);
            return (
              <span key={s} className={i <= idx ? "text-fg" : "text-mute"}>
                {i > 0 && <span className="mr-2 text-mute">→</span>}
                {i === idx && stage !== "done" ? <u>{name}</u> : name}
              </span>
            );
          })}
          {sig && (
            <a className="ml-2 underline" href={explorerTx(sig)} target="_blank" rel="noreferrer">
              View transaction ↗
            </a>
          )}
        </p>
      )}
      {error && <Notice kind="ERROR">{error}</Notice>}
    </div>
  );
}
