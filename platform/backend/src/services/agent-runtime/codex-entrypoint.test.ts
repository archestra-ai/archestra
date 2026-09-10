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
  "../../../../agent_images/bin/archestra-codex",
);

describe("Codex image entrypoint", () => {
  test.each([
    "one_shot",
    "interactive",
  ] as const)("configures and starts %s run through the native session protocol", async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-codex-"));
    try {
      const bin = path.join(root, "bin");
      const runtime = path.join(root, "runtime");
      const workspace = path.join(root, 'workspace "quoted" \\ folder');
      await Promise.all([
        mkdir(bin, { recursive: true }),
        mkdir(workspace, { recursive: true }),
      ]);
      // The native session bridge is the subprocess boundary; provider protocol
      // behavior is exercised by the runtime package and image integration tests.
      await writeExecutable(
        path.join(bin, "archestra-agent-session"),
        `#!/bin/sh
printf '%s\n' "$@" > "$ARCHESTRA_AGENT_RUNTIME_DIR/captured-args"
env > "$ARCHESTRA_AGENT_RUNTIME_DIR/captured-env"
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
        PATH: `${bin}:${process.env.PATH}`,
        ARCHESTRA_LLM_PROXY_PROTOCOL: "openai_responses",
        ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
        ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: 'test-model"\\\n[unexpected]',
        ARCHESTRA_AGENT_RUNTIME_TASK_ID: "12345678-abcd-4000-8000-123456789abc",
        ARCHESTRA_AGENT_RUNTIME_TASK: "Run the task.",
        ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT:
          "Follow the configured Agent instructions.",
        ARCHESTRA_AGENT_RUNTIME_MODE: mode,
        ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/test",
        ARCHESTRA_MCP_GATEWAY_TOKEN: "test-token",
        ARCHESTRA_AGENT_ATTENTION_COMMAND: attentionCommand,
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "http://localhost:9000/v1/model-router/test",
      };

      await execFileAsync("bash", [ENTRYPOINT], {
        cwd: workspace,
        env,
      });

      const config = await readFile(
        path.join(runtime, "codex", "config.toml"),
        "utf8",
      );
      expect(config).toContain('wire_api = "responses"');
      const parsedConfig = JSON.parse(
        (
          await execFileAsync("python3", [
            "-c",
            "import json, sys, tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))",
            path.join(runtime, "codex", "config.toml"),
          ])
        ).stdout,
      );
      expect(parsedConfig.model).toBe(env.ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL);
      expect(parsedConfig.unexpected).toBeUndefined();
      expect(parsedConfig.model_providers.archestra.base_url).toBe(
        env.OPENAI_BASE_URL,
      );
      expect(Object.keys(parsedConfig.projects)[0]).toContain(
        path.basename(workspace),
      );
      expect(config).toContain(
        '"X-Archestra-Run-Id" = "12345678-abcd-4000-8000-123456789abc"',
      );
      expect(config.includes("notify = [")).toBe(mode === "one_shot");
      const hooks = JSON.parse(
        await readFile(path.join(runtime, "codex", "hooks.json"), "utf8"),
      );
      expect(hooks.hooks.PreToolUse[0].matcher).toBe("^request_user_input$");

      const args = (await readFile(path.join(runtime, "captured-args"), "utf8"))
        .trim()
        .split("\n");
      expect(args.slice(0, 3)).toEqual(["codex", "codex", "app-server"]);
      expect(args).not.toContain("Run the task.");

      if (mode === "interactive") {
        const command = hooks.hooks.PreToolUse[0].hooks[0].command;
        await runHook({
          command,
          payload: {
            hook_event_name: "PreToolUse",
            tool_name: "request_user_input",
          },
          env,
        });
        await runHook({
          command,
          payload: { hook_event_name: "PostToolUse" },
          env,
        });
        await runHook({
          command,
          payload: { hook_event_name: "PermissionRequest" },
          env,
        });
        await runHook({
          command,
          payload: { hook_event_name: "Stop" },
          env,
        });
        expect(
          await readFile(path.join(runtime, "attention-calls"), "utf8"),
        ).toBe(
          "set Input requested\nclear\nset Permission needed\nset Waiting for input\n",
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a non-Responses protocol before starting Codex", async () => {
    await expect(
      execFileAsync("bash", [ENTRYPOINT], {
        env: {
          ...process.env,
          ARCHESTRA_LLM_PROXY_PROTOCOL: "openai_chat",
        },
      }),
    ).rejects.toMatchObject({ code: 78 });
  });
});

async function writeExecutable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, "utf8");
  await chmod(file, 0o755);
}

async function runHook(params: {
  command: string;
  payload: Record<string, string>;
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
