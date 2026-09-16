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
import { describe, expect, test } from "vitest";

const exec = promisify(execFile);

describe.each([
  {
    client: "hermes",
    command: "hermes",
    protocol: "openai_chat",
    marker: "hermes-main-session",
  },
  {
    client: "opencode",
    command: "opencode",
    protocol: "openai_responses",
    marker: "opencode-main-session",
  },
  {
    client: "claude-code",
    command: "claude",
    protocol: "anthropic",
    marker: "claude-session-id",
  },
  {
    client: "codex",
    command: "codex",
    protocol: "openai_responses",
    marker: "codex-main-session",
  },
])("$client session continuity", ({ client, command, protocol, marker }) => {
  test.each([
    "present",
    "missing",
    "empty",
  ])("resumes only the recorded session (%s marker)", async (state) => {
    const root = await mkdtemp(path.join(tmpdir(), "runtime-continuation-"));
    try {
      const bin = path.join(root, "bin");
      const runtime = path.join(root, "runtime");
      await mkdir(bin);
      await mkdir(runtime);
      const executable = path.join(bin, command);
      await writeFile(
        executable,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$ARCHESTRA_AGENT_RUNTIME_DIR/args"\n',
      );
      await chmod(executable, 0o755);
      if (state !== "missing")
        await writeFile(
          path.join(runtime, marker),
          state === "present" ? "session-original\n" : "",
        );
      const execution = exec(
        "bash",
        [
          path.resolve(
            import.meta.dirname,
            `../../../../agent_images/bin/archestra-${client}`,
          ),
        ],
        {
          cwd: root,
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            HOME: root,
            ARCHESTRA_LLM_PROXY_PROTOCOL: protocol,
            ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
            ARCHESTRA_AGENT_RUNTIME_NATIVE_STATE_DIR: runtime,
            ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "test-model",
            ARCHESTRA_AGENT_RUNTIME_TASK_ID: "test-task",
            ARCHESTRA_AGENT_RUNTIME_TASK: "Continue the same work",
            ARCHESTRA_AGENT_RUNTIME_MODE: "interactive",
            ARCHESTRA_AGENT_RUNTIME_CLAUDE_AUTH: "subscription",
            ARCHESTRA_AGENT_RUNTIME_CONTINUE: "1",
            ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/test",
            ARCHESTRA_MCP_GATEWAY_TOKEN: "test-token",
            ANTHROPIC_AUTH_TOKEN: "test-key",
            CLAUDE_CODE_OAUTH_TOKEN: "test-subscription-token",
            OPENAI_API_KEY: "test-key",
            OPENAI_BASE_URL: "http://localhost:9000/v1/test",
          },
        },
      );
      if (state === "present") {
        await execution;
        const args = (await readFile(path.join(runtime, "args"), "utf8"))
          .trim()
          .split("\n");
        const resume = args.indexOf(
          command === "codex"
            ? "resume"
            : command === "opencode"
              ? "--session"
              : "--resume",
        );
        expect(resume).toBeGreaterThanOrEqual(0);
        expect(args[resume + 1]).toBe("session-original");
        expect(args).not.toContain("--last");
        expect(args).not.toContain("--continue");
      } else {
        await expect(execution).rejects.toMatchObject({
          code: 78,
          stderr: expect.stringContaining("no new session was started"),
        });
        await expect(
          readFile(path.join(runtime, "args")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
