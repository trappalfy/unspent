// Real Claude Code CLI against the local gateway and the mock provider (brief 13): a conversation with a tool call.
// Runs only when a Claude Code binary is available (CLAUDE_BIN or the VS Code extension's bundled binary).

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { requests } from "@unspent/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type Harness, startHarness, until } from "./harness";
import type { RecordedRequest, Scenario } from "./mock/mockAnthropic";

function findClaude(): string | null {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const ext = join(homedir(), ".vscode", "extensions");
  if (!existsSync(ext)) return null;
  for (const d of readdirSync(ext)
    .filter((x) => x.startsWith("anthropic.claude-code-"))
    .sort()
    .reverse()) {
    const bin = join(ext, d, "resources", "native-binary", "claude");
    if (existsSync(bin)) return bin;
  }
  return null;
}

const bin = findClaude();
let h: Harness;
const work = mkdtempSync(join(tmpdir(), "unspent-cc-"));
const file = join(work, "hello.txt");

beforeAll(async () => {
  if (!bin) return;
  writeFileSync(file, "The secret word is PINEAPPLE.\n");
  h = await startHarness({ credits: 40n });
  h.settle.start();
  h.mock.setScenario((req: RecordedRequest): Scenario => {
    const history = JSON.stringify(req.json?.messages ?? []);
    const hasRead =
      Array.isArray(req.json?.tools) && req.json.tools.some((t: { name?: string }) => t.name === "Read");
    if (history.includes('"tool_result"')) return { type: "text", chunks: ["The file says ", "PINEAPPLE."] };
    if (hasRead)
      return {
        type: "tool_use",
        chunks: ["Reading it."],
        tools: [{ name: "Read", input: { file_path: file } }],
      };
    return { type: "text", chunks: ["ok"] };
  });
});

afterAll(async () => {
  await h?.close();
});

it.skipIf(!bin)(
  "Claude Code completes a tool-using turn through Unspent",
  async () => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: homedir(),
      CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "unspent-cc-config-")),
      ANTHROPIC_BASE_URL: h.url,
      ANTHROPIC_AUTH_TOKEN: h.apiKey,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_AUTOUPDATER: "1",
    };
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const p = spawn(
        bin!,
        ["-p", `What does ${file} say?`, "--model", "claude-sonnet-5-5", "--allowedTools", "Read"],
        { cwd: work, env },
      );
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => p.kill("SIGKILL"), 150_000);
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    expect(out.stderr).not.toMatch(/API Error|authentication/i);
    expect(
      out.code,
      `stdout: ${out.stdout}\nstderr: ${out.stderr}\nmock: ${JSON.stringify(h.mock.requests.map((r) => r.path))}\nlogs: ${h.logs.slice(-5).join("\n")}`,
    ).toBe(0);
    expect(out.stdout).toContain("PINEAPPLE");

    const inference = h.mock.requests.filter(
      (r) => r.path.startsWith("/v1/messages") && !r.path.includes("count_tokens"),
    );
    expect(inference.some((r) => r.path.includes("beta=true"))).toBe(true);
    expect(inference.some((r) => JSON.stringify(r.json.messages).includes("tool_result"))).toBe(true);
    // Every inference request was reserved and metered; a tool round trip means at least two.
    await until(
      async () =>
        (await h.db.select().from(requests)).filter((r) => r.status !== "dispatched").length >=
        inference.length,
      10_000,
    );
    const rows = await h.db.select().from(requests);
    expect(rows.length).toBe(inference.length);
    expect(rows.some((r) => r.ccSessionId)).toBe(true);
    await h.settle.drain();
    expect((await h.chain.user(h.wallet))!.reserved).toBe(0n);
  },
  180_000,
);
