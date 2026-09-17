import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const binDirectory = path.resolve(
  import.meta.dirname,
  "../../../../agent_images/bin",
);
const eventHelper = path.join(binDirectory, "archestra-agent-event");
const nativeTaskId = "12345678-abcd-4000-8000-123456789abc";
const nativeAttemptId = "12345678-abcd-4000-8000-123456789abd";

test.each([
  "codex",
  "hermes",
  "opencode",
  "openclaw",
])("%s reports incompatible protocols before starting the client", async (image) => {
  const root = await mkdtemp(path.join(tmpdir(), "image-protocol-"));
  try {
    const result = await exec(
      "bash",
      [path.join(binDirectory, `archestra-${image}`)],
      {
        env: {
          ...process.env,
          ARCHESTRA_LLM_PROXY_PROTOCOL: "unsupported",
          ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: path.join(root, "turn"),
        },
      },
    ).catch((error) => error);
    expect(result.code).toBe(78);
    const failure = JSON.parse(
      await readFile(path.join(root, "turn.failure"), "utf8"),
    );
    expect(failure).toMatchObject({ version: 1, code: `${image}_protocol` });
    expect(failure.message).toContain(
      "requires an Agent configured for OpenAI",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  false,
  true,
])("proxy readiness failure preserves exit status with unavailable sidecar=%s", async (unavailable) => {
  const root = await mkdtemp(path.join(tmpdir(), "image-proxy-"));
  try {
    for (const [name, body] of [
      ["curl", "echo synthetic-secret >&2\nexit 22"],
      ["sleep", "exit 0"],
    ]) {
      const file = path.join(root, name);
      await writeFile(file, `#!/bin/sh\n${body}\n`);
      await chmod(file, 0o755);
    }
    const prefix = path.join(root, unavailable ? "missing/turn" : "turn");
    const result = await exec(
      "sh",
      [path.join(binDirectory, "archestra-agent-init")],
      {
        env: {
          PATH: `${root}:${process.env.PATH}`,
          OPENAI_BASE_URL: "http://unused.invalid",
          OPENAI_API_KEY: "synthetic-secret",
          ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: prefix,
        },
      },
    ).catch((error) => error);
    expect(result.code).toBe(69);
    if (!unavailable) {
      const failure = JSON.parse(await readFile(`${prefix}.failure`, "utf8"));
      expect(failure).toMatchObject({ version: 1, code: "proxy_unavailable" });
      expect(failure.message).not.toContain("synthetic-secret");
      expect(failure.message).toContain("proxy");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["opencode", "one_shot"],
  ["opencode", "interactive"],
  ["openclaw", "one_shot"],
  ["openclaw", "interactive"],
])("%s handles native errors in %s mode", async (image, mode) => {
  const root = await mkdtemp(path.join(tmpdir(), "image-native-failure-"));
  try {
    const bin = path.join(root, "bin");
    const runtime = path.join(root, "runtime");
    await mkdir(bin);
    const prefix = path.join(root, "turn");
    const contextPath = `${prefix}.events/context.json`;
    if (image === "opencode") {
      await exec(eventHelper, [
        "context",
        "--path",
        contextPath,
        "--task",
        nativeTaskId,
        "--attempt",
        nativeAttemptId,
      ]);
      const attentionCommand = path.join(bin, "archestra-agent-attention");
      await writeFile(
        attentionCommand,
        `#!/bin/sh
printf '%s:%s\\n' "$*" "\${ARCHESTRA_AGENT_RUNTIME_ATTENTION_KIND:-}" > "$ARCHESTRA_AGENT_RUNTIME_DIR/attention"
`,
      );
      await chmod(attentionCommand, 0o755);
    }
    const client = path.join(bin, image);
    await writeFile(
      client,
      `#!/usr/bin/env node
const fs = require("node:fs");
(async () => {
  const runtime = process.env.ARCHESTRA_AGENT_RUNTIME_DIR;
  let send;
  if (${JSON.stringify(image)} === "opencode") {
    const attention = await import("file://" + runtime + "/opencode-attention.js");
    const attentionHooks = await attention.ArchestraAttention();
    const plugin = await import("file://" + runtime + "/opencode-transcript.js");
    const hooks = await plugin.ArchestraTranscript({ client: { session: {
      get: async ({ path }) => ({ data: { parentID: path.id === "child" ? "main" : undefined } }),
      messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "stale partial answer" }] }] }),
    } }, directory: process.cwd() });
    await attentionHooks.event({ event: { type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } } });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "main" } } } });
    await attentionHooks.event({ event: { type: "session.created", properties: { info: { id: "main" } } } });
    await attentionHooks.event({ event: { type: "session.status", properties: { sessionID: "main", status: { type: "busy" } } } });
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "main", error: { name: "ContextOverflowError" } } } });
    if (fs.existsSync(process.env.ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX + ".failure") || fs.existsSync(runtime + "/turn-complete")) throw new Error("automatic compaction settled the run");
    send = async (child) => {
      const sessionID = child ? "child" : "main";
      const error = child
        ? { name: "APIError", data: { message: "synthetic-secret" } }
        : { name: "APIError", data: { statusCode: 401, message: "synthetic-secret" } };
      await attentionHooks.event({ event: { type: "session.error", properties: { sessionID, error } } });
      await hooks.event({ event: { type: "session.error", properties: { sessionID, error } } });
      if (child) {
        await attentionHooks.event({ event: { type: "session.status", properties: { sessionID: "child", status: { type: "idle" } } } });
        return;
      }
      if (!child) {
        await hooks.event({ event: { type: "session.idle", properties: { sessionID: "main" } } });
        if (process.env.ARCHESTRA_AGENT_RUNTIME_MODE === "interactive") {
          const proxyAuthError = {
            name: "APIError",
            data: {
              responseBody: JSON.stringify({ error: { internal_code: "provider_auth_required" } }),
              message: "synthetic-secret",
            },
          };
          await attentionHooks.event({ event: { type: "session.error", properties: { sessionID, error: proxyAuthError } } });
          await hooks.event({ event: { type: "session.error", properties: { sessionID, error: proxyAuthError } } });
          await attentionHooks.event({ event: { type: "session.status", properties: { sessionID: "child", status: { type: "idle" } } } });
        }
      }
    };
  } else {
    const plugin = await import("file://" + runtime + "/openclaw-transcript/index.mjs");
    let handler;
    plugin.default.register({ on(name, callback) { if (name === "agent_end") handler = callback; } });
    send = (child) => handler({ success: false, error: "synthetic-secret", messages: [] }, { sessionKey: child ? "agent:main:child" : "agent:main:main" });
  }
  await send(true);
  if (fs.existsSync(process.env.ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX + ".failure") || fs.existsSync(runtime + "/turn-complete")) throw new Error("child failure settled the parent");
  await send(false);
})().catch((error) => { console.error(error); process.exitCode = 99; });
`,
    );
    await chmod(client, 0o755);
    const result = await exec(
      "bash",
      [path.join(binDirectory, `archestra-${image}`)],
      {
        cwd: root,
        timeout: 15000,
        env: {
          ...process.env,
          PATH: `${bin}:${binDirectory}:${process.env.PATH}`,
          ARCHESTRA_LLM_PROXY_PROTOCOL: "openai_responses",
          ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
          ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: prefix,
          ARCHESTRA_AGENT_RUNTIME_MODE: mode,
          ARCHESTRA_AGENT_RUNTIME_PLAIN: "0",
          ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "test-model",
          ARCHESTRA_AGENT_RUNTIME_TASK_ID:
            image === "opencode" ? nativeTaskId : "main",
          ...(image === "opencode"
            ? {
                ARCHESTRA_AGENT_RUNTIME_RUN_ID: nativeAttemptId,
                ARCHESTRA_AGENT_ATTENTION_COMMAND: path.join(
                  bin,
                  "archestra-agent-attention",
                ),
              }
            : {}),
          ARCHESTRA_AGENT_RUNTIME_TASK: "Complete the task.",
          ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/test",
          ARCHESTRA_MCP_GATEWAY_TOKEN: "test-token",
          OPENAI_API_KEY: "test-key",
          OPENAI_BASE_URL: "http://localhost:9000/v1/test",
        },
      },
    ).catch((error) => error);
    if (mode === "interactive") {
      expect(result.code ?? 0).toBe(0);
      if (image === "opencode") {
        expect(
          await readFile(path.join(runtime, "attention"), "utf8"),
        ).toContain("auth_required");
        const events = JSON.parse(
          (
            await exec(eventHelper, [
              "read",
              "--task",
              nativeTaskId,
              "--context",
              contextPath,
            ])
          ).stdout,
        );
        expect(
          events.events.filter(
            (event: { type?: string; error?: { code?: string } }) =>
              event.type === "diagnostic" &&
              event.error?.code === "provider_credential_rejected",
          ),
        ).toHaveLength(1);
        expect(
          events.events.filter(
            (event: { type?: string; error?: { code?: string } }) =>
              event.type === "diagnostic" &&
              event.error?.code === "provider_auth_required",
          ),
        ).toHaveLength(1);
      }
      await expect(
        readFile(path.join(root, "turn.failure")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(path.join(runtime, "turn-complete")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(result.code).toBe(1);
      const failure = JSON.parse(
        await readFile(path.join(root, "turn.failure"), "utf8"),
      );
      expect(failure.version).toBe(1);
      if (image === "opencode") {
        expect(failure.code).toBe("provider_credential_rejected");
        expect(failure.resolution).toBeTruthy();
      } else {
        expect(failure.code).toMatch(new RegExp(`^${image}_`));
      }
      expect(failure.message).toContain("provider credential");
      expect(JSON.stringify(failure)).not.toContain("synthetic-secret");
      expect(
        await readFile(path.join(runtime, "final-answer.txt"), "utf8"),
      ).toBe(`${failure.message}\n`);
      await expect(
        readFile(path.join(runtime, "turn-complete.failed")),
      ).resolves.toBeDefined();
      if (image === "opencode") {
        const events = JSON.parse(
          (
            await exec(eventHelper, [
              "read",
              "--task",
              nativeTaskId,
              "--context",
              contextPath,
            ])
          ).stdout,
        );
        expect(
          events.events.some(
            (event: {
              type?: string;
              outcome?: string;
              error?: { code?: string };
            }) =>
              event.type === "turn.finished" &&
              event.outcome === "failed" &&
              event.error?.code === "provider_credential_rejected",
          ),
        ).toBe(true);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
