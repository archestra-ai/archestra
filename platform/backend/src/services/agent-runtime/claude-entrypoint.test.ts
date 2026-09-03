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
  "../../../../agent_images/bin/archestra-claude-code",
);
const ATTENTION_ENTRYPOINT = path.resolve(
  import.meta.dirname,
  "../../../../agent_images/bin/archestra-agent-attention",
);

describe("Claude Code image entrypoint", () => {
  test("uses native Claude hooks to report and clear input attention", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-claude-code-"));
    try {
      const bin = path.join(root, "bin");
      const runtime = path.join(root, "runtime");
      const workspace = path.join(root, "workspace");
      const home = path.join(root, "home");
      await Promise.all([
        mkdir(bin, { recursive: true }),
        mkdir(runtime, { recursive: true }),
        mkdir(workspace, { recursive: true }),
        mkdir(home, { recursive: true }),
      ]);
      await writeExecutable(
        path.join(bin, "claude"),
        `#!/bin/sh
printf '%s\n' "$@" > "$ARCHESTRA_AGENT_RUNTIME_DIR/captured-args"
`,
      );
      await writeExecutable(
        path.join(bin, "tmux"),
        `#!/bin/sh
if [ "$1" = "show-option" ]; then
  [ -f "$ARCHESTRA_AGENT_RUNTIME_DIR/attention-state" ] \
    && cat "$ARCHESTRA_AGENT_RUNTIME_DIR/attention-state"
  exit 0
fi
printf '%s\n' "$*" >> "$ARCHESTRA_AGENT_RUNTIME_DIR/captured-tmux"
case "$*" in
  *"@archestra_attention 1"*)
    printf '1\n' > "$ARCHESTRA_AGENT_RUNTIME_DIR/attention-state"
    ;;
  *"@archestra_attention 0"*)
    printf '0\n' > "$ARCHESTRA_AGENT_RUNTIME_DIR/attention-state"
    ;;
esac
`,
      );
      await writeExecutable(
        path.join(bin, "curl"),
        `#!/bin/sh
printf '%s\n' "$*" >> "$ARCHESTRA_AGENT_RUNTIME_DIR/captured-curl"
`,
      );

      const env = {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        ARCHESTRA_LLM_PROXY_PROTOCOL: "anthropic",
        ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
        ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "test-model",
        ARCHESTRA_AGENT_RUNTIME_TASK_ID: "12345678-abcd-4000-8000-123456789abc",
        ARCHESTRA_AGENT_RUNTIME_TASK: "Run the task.",
        ARCHESTRA_AGENT_RUNTIME_MODE: "interactive",
        ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/test",
        ARCHESTRA_MCP_GATEWAY_TOKEN: "test-token",
        ARCHESTRA_AGENT_ATTENTION_COMMAND: ATTENTION_ENTRYPOINT,
      };
      await execFileAsync("bash", [ENTRYPOINT], { cwd: workspace, env });

      const settings = JSON.parse(
        await readFile(path.join(runtime, "claude-settings.json"), "utf8"),
      );
      const attentionHook = settings.hooks.Notification[0].hooks[0].command;
      expect(settings.hooks.Notification[0].matcher).toContain("idle_prompt");
      expect(settings.hooks.Notification[0].matcher).toContain(
        "permission_prompt",
      );

      await runHook({
        command: attentionHook,
        payload: {
          hook_event_name: "Notification",
          notification_type: "idle_prompt",
        },
        env,
      });
      await runHook({
        command: attentionHook,
        payload: { hook_event_name: "UserPromptSubmit" },
        env,
      });

      const tmuxCalls = await readFile(
        path.join(runtime, "captured-tmux"),
        "utf8",
      );
      expect(tmuxCalls).toContain("set-option -t %3 @archestra_attention 1");
      expect(tmuxCalls).toContain(
        "set-option -t %3 @archestra_attention_label Waiting for input",
      );
      expect(tmuxCalls).toContain("set-option -t %3 @archestra_attention 0");
      const statusCalls = await readFile(
        path.join(runtime, "captured-curl"),
        "utf8",
      );
      expect(statusCalls).toContain("/runtime-status");
      expect(statusCalls).toContain('"attentionState":"input_required"');
      expect(statusCalls).toContain('"attentionState":null');
      expect(
        (await readFile(path.join(runtime, "captured-args"), "utf8"))
          .trim()
          .split("\n"),
      ).toContain("--settings");
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
  payload: Record<string, string>;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  await execFileAsync(
    "bash",
    ["-c", 'printf "%s" "$HOOK_PAYLOAD" | exec "$1"', "_", params.command],
    {
      env: {
        ...params.env,
        TMUX_PANE: "%3",
        HOOK_PAYLOAD: JSON.stringify(params.payload),
      },
    },
  );
}
