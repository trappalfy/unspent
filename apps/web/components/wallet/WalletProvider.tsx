"use client";

import { getBase58Decoder } from "@solana/kit";
import {
  SolanaSignAndSendTransaction,
  type SolanaSignAndSendTransactionFeature,
  SolanaSignIn,
  type SolanaSignInFeature,
  SolanaSignMessage,
  type SolanaSignMessageFeature,
  SolanaSignTransaction,
  type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import { createSignInMessageText } from "@solana/wallet-standard-util";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  StandardConnect,
  type StandardConnectFeature,
  StandardDisconnect,
  type StandardDisconnectFeature,
  StandardEvents,
  type StandardEventsFeature,
} from "@wallet-standard/features";
import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { SignResult } from "@/lib/chain/tx";
import { chain } from "@/lib/env";
import { type SiwsInput, type SiwsProof, toBase64 } from "@/lib/siws";

// Wallet Standard discovery (Phantom, Solflare, Backpack and any compliant wallet) + Sign-In With Solana.

const REMEMBER_KEY = "usp_wallet";

type WalletState = {
  wallets: Wallet[];
  wallet: Wallet | null;
  account: WalletAccount | null;
  /** Address of the signed-in session (server cookie), null when signed out. */
  sessionAddress: string | null;
  busy: boolean;
  error: string | null;
  signIn: (wallet: Wallet) => Promise<void>;
  signOut: () => Promise<void>;
  /** Signs a serialized transaction with the signed-in account, reconnecting the wallet if needed. */
  signTransaction: (bytes: Uint8Array) => Promise<SignResult>;
};

const Ctx = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}

function isSolanaWallet(w: Wallet): boolean {
  return (
    w.chains.some((c) => c.startsWith("solana:")) &&
    StandardConnect in w.features &&
    (SolanaSignIn in w.features || SolanaSignMessage in w.features)
  );
}

function remember(name: string | null) {
  try {
    if (name) localStorage.setItem(REMEMBER_KEY, name);
    else localStorage.removeItem(REMEMBER_KEY);
  } catch {}
}

function remembered(): string | null {
  try {
    return localStorage.getItem(REMEMBER_KEY);
  } catch {
    return null;
  }
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

async function signInWithWallet(wallet: Wallet): Promise<{ account: WalletAccount; proof: SiwsProof }> {
  const input = await postJson<SiwsInput>("/api/auth/nonce");
  if (SolanaSignIn in wallet.features) {
    const feature = (wallet.features as SolanaSignInFeature)[SolanaSignIn];
    const [out] = await feature.signIn(input);
    if (!out) throw new Error("The wallet returned no signature.");
    return {
      account: out.account,
      proof: {
        address: out.account.address,
        publicKey: toBase64(new Uint8Array(out.account.publicKey)),
        signedMessage: toBase64(out.signedMessage),
        signature: toBase64(out.signature),
      },
    };
  }
  const { accounts } = await (wallet.features as StandardConnectFeature)[StandardConnect].connect();
  const account = accounts[0];
  if (!account) throw new Error("The wallet shared no account.");
  const message = new TextEncoder().encode(createSignInMessageText({ ...input, address: account.address }));
  const [out] = await (wallet.features as SolanaSignMessageFeature)[SolanaSignMessage].signMessage({
    account,
    message,
  });
  if (!out) throw new Error("The wallet returned no signature.");
  return {
    account,
    proof: {
      address: account.address,
      publicKey: toBase64(new Uint8Array(account.publicKey)),
      signedMessage: toBase64(out.signedMessage),
      signature: toBase64(out.signature),
    },
  };
}

export function WalletProvider({
  initialAddress,
  children,
}: {
  initialAddress: string | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [sessionAddress, setSessionAddress] = useState(initialAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = getWallets();
    const sync = () => setWallets(api.get().filter(isSolanaWallet));
    sync();
    const offRegister = api.on("register", sync);
    const offUnregister = api.on("unregister", sync);
    return () => {
      offRegister();
      offUnregister();
    };
  }, []);

  // Silent reconnect to the remembered wallet so a signed-in session can sign transactions after a reload.
  useEffect(() => {
    if (!sessionAddress || wallet) return;
    const name = remembered();
    const w = name ? wallets.find((x) => x.name === name) : undefined;
    if (!w) return;
    (w.features as StandardConnectFeature)[StandardConnect]
      .connect({ silent: true })
      .then(({ accounts }) => {
        const a = accounts.find((x) => x.address === sessionAddress);
        if (a) {
          setWallet(w);
          setAccount(a);
        }
      })
      .catch(() => {});
  }, [sessionAddress, wallet, wallets]);

  const signOut = useCallback(async () => {
    setError(null);
    await postJson("/api/auth/logout").catch(() => {});
    if (wallet && StandardDisconnect in wallet.features) {
      await (wallet.features as StandardDisconnectFeature)[StandardDisconnect].disconnect().catch(() => {});
    }
    remember(null);
    setWallet(null);
    setAccount(null);
    setSessionAddress(null);
    router.refresh();
  }, [wallet, router]);

  // A different account selected in the wallet ends the session: keys and reservations belong to one wallet.
  useEffect(() => {
    if (!wallet || !(StandardEvents in wallet.features)) return;
    return (wallet.features as StandardEventsFeature)[StandardEvents].on("change", ({ accounts }) => {
      if (accounts && sessionAddress && !accounts.some((a) => a.address === sessionAddress)) void signOut();
    });
  }, [wallet, sessionAddress, signOut]);

  const signIn = useCallback(
    async (w: Wallet) => {
      setBusy(true);
      setError(null);
      try {
        const { account: a, proof } = await signInWithWallet(w);
        const { address } = await postJson<{ address: string }>("/api/auth/verify", proof);
        remember(w.name);
        setWallet(w);
        setAccount(a);
        setSessionAddress(address);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Sign-in failed.");
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const connected = useCallback(async (): Promise<{ w: Wallet; a: WalletAccount }> => {
    if (wallet && account && account.address === sessionAddress) return { w: wallet, a: account };
    const name = remembered();
    const w = wallet ?? (name ? wallets.find((x) => x.name === name) : undefined);
    if (!w) throw new Error("Connect your wallet again to sign.");
    const { accounts } = await (w.features as StandardConnectFeature)[StandardConnect].connect();
    const a = accounts.find((x) => x.address === sessionAddress);
    if (!a) throw new Error(`Switch your wallet to ${shortAddress(sessionAddress ?? "")} or sign in again.`);
    setWallet(w);
    setAccount(a);
    return { w, a };
  }, [wallet, account, wallets, sessionAddress]);

  const signTransaction = useCallback(
    async (bytes: Uint8Array): Promise<SignResult> => {
      const { w, a } = await connected();
      if (SolanaSignTransaction in w.features) {
        const [out] = await (w.features as SolanaSignTransactionFeature)[
          SolanaSignTransaction
        ].signTransaction({
          account: a,
          transaction: bytes,
          chain,
        });
        if (!out) throw new Error("The wallet returned no signature.");
        return { signed: out.signedTransaction };
      }
      if (SolanaSignAndSendTransaction in w.features) {
        const [out] = await (w.features as SolanaSignAndSendTransactionFeature)[
          SolanaSignAndSendTransaction
        ].signAndSendTransaction({ account: a, transaction: bytes, chain });
        if (!out) throw new Error("The wallet returned no signature.");
        return { signature: getBase58Decoder().decode(out.signature) };
      }
      throw new Error("This wallet can't sign transactions.");
    },
    [connected],
  );

  const value = useMemo(
    () => ({ wallets, wallet, account, sessionAddress, busy, error, signIn, signOut, signTransaction }),
    [wallets, wallet, account, sessionAddress, busy, error, signIn, signOut, signTransaction],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}
