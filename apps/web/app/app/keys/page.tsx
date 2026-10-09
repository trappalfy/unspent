import { CLAUDE_MODELS } from "@unspent/shared";
import type { Metadata } from "next";
import { KeysManager } from "@/components/app/KeysManager";
import { PageTitle } from "@/components/app/ui";
import { apiBase, network } from "@/lib/env";
import { listKeys } from "@/lib/keys";
import { getDb } from "@/lib/server/db";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "API keys" };

export default async function KeysPage() {
  const session = await getSession();
  if (!session) return null;
  const keys = await listKeys(await getDb(), session.address, network);
  const models = CLAUDE_MODELS.filter((m) => m.enabled).map((m) => ({ id: m.id, name: m.displayName }));
  return (
    <>
      <PageTitle sub="Keys spend credits from this wallet's API balance. A daily limit counts what's charged plus what's held for running requests.">
        API keys
      </PageTitle>
      <KeysManager keys={keys} models={models} apiBase={apiBase} />
    </>
  );
}
