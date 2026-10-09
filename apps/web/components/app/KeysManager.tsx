"use client";

import { type FormEvent, useState, useTransition } from "react";
import { createKeyAction, revokeKeyAction } from "@/app/app/keys/actions";
import { CopyButton } from "@/components/CopyButton";
import { credits } from "@/lib/format";
import type { KeyRow } from "@/lib/keys";
import { Empty, Notice, Panel } from "./ui";

type Model = { id: string; name: string };

const fmtDate = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "—");

function CreateKey({ models, apiBase }: { models: Model[]; apiBase: string }) {
  const [name, setName] = useState("");
  const [limit, setLimit] = useState("");
  const [picked, setPicked] = useState<string[]>(models.map((m) => m.id));
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!picked.length) return setError("Pick at least one model.");
    start(async () => {
      const r = await createKeyAction({ name: name || "Default", dailyLimit: limit, models: picked });
      if (!r.ok) return setError(r.error);
      setSecret(r.apiKey);
      setName("");
      setLimit("");
    });
  }

  if (secret)
    return (
      <Panel title="Your new key">
        <Notice>Copy it now. You won&apos;t see it again; we only keep a hash.</Notice>
        <div className="flex flex-col gap-3 border border-fg p-3 md:flex-row md:items-center">
          <code className="break-all text-sm">{secret}</code>
          <CopyButton value={secret} />
        </div>
        <p className="text-sm text-mute">Use it with Claude Code:</p>
        <pre className="overflow-x-auto border border-line p-3 text-xs">
          {`export ANTHROPIC_BASE_URL=${apiBase}\nexport ANTHROPIC_AUTH_TOKEN=${secret}\nclaude`}
        </pre>
        <button type="button" className="btn self-start" onClick={() => setSecret(null)}>
          Done
        </button>
      </Panel>
    );

  return (
    <Panel title="Create key">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-2 text-sm">
            Name
            <input
              className="input"
              placeholder="Default"
              maxLength={64}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-2 text-sm">
            Daily limit, credits
            <input
              className="input"
              inputMode="decimal"
              placeholder="No limit"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </label>
        </div>
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-2">Models</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {models.map((m) => (
              <label key={m.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={picked.includes(m.id)}
                  onChange={(e) =>
                    setPicked((p) => (e.target.checked ? [...p, m.id] : p.filter((x) => x !== m.id)))
                  }
                />
                {m.name}
              </label>
            ))}
          </div>
        </fieldset>
        {error && <Notice kind="ERROR">{error}</Notice>}
        <button type="submit" className="btn btn-primary self-start" disabled={pending}>
          {pending ? "Creating…" : "Create key"}
        </button>
      </form>
    </Panel>
  );
}

function RevokeButton({ id }: { id: string }) {
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();
  if (!confirm)
    return (
      <button type="button" className="underline" onClick={() => setConfirm(true)}>
        Revoke
      </button>
    );
  return (
    <span className="flex gap-3 whitespace-nowrap">
      <button
        type="button"
        className="underline"
        disabled={pending}
        onClick={() => start(() => void revokeKeyAction(id))}
      >
        {pending ? "Revoking…" : "Yes, revoke"}
      </button>
      <button type="button" className="text-mute" onClick={() => setConfirm(false)}>
        Cancel
      </button>
    </span>
  );
}

export function KeysManager({ keys, models, apiBase }: { keys: KeyRow[]; models: Model[]; apiBase: string }) {
  const names = new Map(models.map((m) => [m.id, m.name]));
  const active = keys.filter((k) => k.status === "active");
  const revoked = keys.filter((k) => k.status === "revoked");
  return (
    <div className="flex flex-col gap-6">
      <CreateKey models={models} apiBase={apiBase} />
      {active.length === 0 ? (
        <Empty>No API keys yet. Create one to start spending credits.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th className="num">Daily limit</th>
                <th>Models</th>
                <th>Created</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {active.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="whitespace-nowrap">
                    {k.prefix}…{k.last4}
                  </td>
                  <td className="num">{k.dailyLimitUcr === null ? "none" : credits(k.dailyLimitUcr)}</td>
                  <td>
                    {k.allowedModels ? k.allowedModels.map((m) => names.get(m) ?? m).join(", ") : "All"}
                  </td>
                  <td className="whitespace-nowrap">{fmtDate(k.createdAt)}</td>
                  <td className="whitespace-nowrap">{fmtDate(k.lastUsedAt)}</td>
                  <td>
                    <RevokeButton id={k.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {revoked.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-mute">Revoked keys ({revoked.length})</summary>
          <ul className="mt-3 flex flex-col gap-1 text-mute">
            {revoked.map((k) => (
              <li key={k.id}>
                {k.name} · {k.prefix}…{k.last4} · revoked {fmtDate(k.revokedAt)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
