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

const execFileAsync = promisify(execFile);
const ENTRYPOINT = path.resolve(
  import.meta.dirname,
  "../../../../agent_images/bin/archestra-hermes",
);

describe("Hermes image entrypoint", () => {
  test("uses native Hermes hooks to report input attention", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-hermes-"));
    try {
      const bin = path.join(root, "bin");
      const runtime = path.join(root, "runtime");
      const workspace = path.join(root, "workspace");
      const home = path.join(root, "home");
      await Promise.all([
        mkdir(bin, { recursive: true }),
        mkdir(workspace, { recursive: true }),
        mkdir(home, { recursive: true }),
      ]);
      await writeExecutable(
        path.join(bin, "hermes"),
        `#!/bin/sh
printf '%s\n' "$@" > "$ARCHESTRA_AGENT_RUNTIME_DIR/captured-args"
`,
      );
      const attentionCommand = path.join(bin, "attention");
      await writeExecutable(
        attentionCommand,
        `#!/bin/sh
printf '%s\n' "$*" >> "$ARCHESTRA_AGENT_RUNTIME_DIR/attention-calls"
`,
      );

      const env = {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        ARCHESTRA_LLM_PROXY_PROTOCOL: "openai_chat",
        ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
        ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "test-model",
        ARCHESTRA_AGENT_RUNTIME_TASK_ID: "12345678-abcd-4000-8000-123456789abc",
        ARCHESTRA_AGENT_RUNTIME_TASK: "Run the task.",
        ARCHESTRA_AGENT_RUNTIME_MODE: "interactive",
        ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT:
          "Follow the configured Agent instructions.",
        ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/test",
        ARCHESTRA_MCP_GATEWAY_TOKEN: "test-token",
        ARCHESTRA_AGENT_ATTENTION_COMMAND: attentionCommand,
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "http://localhost:9000/v1/model-router/test",
      };
      await execFileAsync("bash", [ENTRYPOINT], { cwd: workspace, env });

      const config = JSON.parse(
        await readFile(path.join(runtime, "hermes", "config.yaml"), "utf8"),
      );
      expect(config.hooks_auto_accept).toBe(true);
      expect(config.hooks.pre_tool_call[0].matcher).toBe("^clarify$");
      const command = config.hooks.pre_tool_call[0].command;

      await runHook({
        command,
        payload: { hook_event_name: "pre_tool_call", tool_name: "clarify" },
        env,
      });
      await runHook({
        command,
        payload: { hook_event_name: "post_tool_call", tool_name: "clarify" },
        env,
      });
      await runHook({
        command,
        payload: { hook_event_name: "pre_approval_request" },
        env,
      });
      await runHook({
        command,
        payload: { hook_event_name: "post_approval_response" },
        env,
      });
      await runHook({
        command,
        payload: { hook_event_name: "pre_llm_call" },
        env,
      });
      await runHook({
        command,
        payload: {
          hook_event_name: "on_session_end",
          extra: { completed: true },
        },
        env,
      });

      expect(
        await readFile(path.join(runtime, "attention-calls"), "utf8"),
      ).toBe(
        "set Input requested\nclear\nset Permission needed\nclear\nclear\nset Waiting for input\n",
      );
      expect(
        await readFile(path.join(runtime, "captured-args"), "utf8"),
      ).toContain("--accept-hooks");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeExecutable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, "utf8");
  await chmod(file, 0o755);
}

async function runHook(params: {
  command: string;
  payload: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  await execFileAsync(
    "bash",
    ["-c", 'printf "%s" "$HOOK_PAYLOAD" | exec "$1"', "_", params.command],
    {
      env: {
        ...params.env,
        HOOK_PAYLOAD: JSON.stringify(params.payload),
      },
    },
  );
}
