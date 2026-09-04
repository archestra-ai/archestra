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

describe("Claude Code image entrypoint", () => {
  test.each([
    "one_shot",
    "interactive",
  ] as const)("configures and starts %s run in the native TUI", async (mode) => {
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
if [ "$ARCHESTRA_AGENT_RUNTIME_MODE" = "one_shot" ]; then
  settings=""
  previous=""
  for argument in "$@"; do
    if [ "$previous" = "--settings" ]; then settings="$argument"; fi
    previous="$argument"
  done
  transcript="$ARCHESTRA_AGENT_RUNTIME_DIR/transcript.jsonl"
  printf '%s\n' \
    '{"type":"user","timestamp":"2026-09-04T10:00:00Z","message":{"content":"Build the feature."}}' \
    '{"type":"assistant","timestamp":"2026-09-04T10:00:01Z","message":{"content":[{"type":"text","text":"I will inspect the code."},{"type":"tool_use","id":"tool-1","name":"Read","input":{"file_path":"src/app.ts"}}]}}' \
    '{"type":"user","timestamp":"2026-09-04T10:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"export const ready = true;"}]}}' \
    '{"type":"assistant","timestamp":"2026-09-04T10:00:03Z","message":{"content":[{"type":"text","text":"Claude finished the task."}]}}' \
    > "$transcript"
  hook_script="$(jq -r '.hooks.Stop[0].hooks[0].command' "$settings")"
  printf '{"transcript_path":"%s"}' "$transcript" | "$hook_script"
  trap 'exit 0' TERM
  while :; do sleep 1; done
fi
`,
      );

      const result = await execFileAsync("bash", [ENTRYPOINT], {
        cwd: workspace,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          ARCHESTRA_LLM_PROXY_PROTOCOL: "anthropic",
          ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
          ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "test-model",
          ARCHESTRA_AGENT_RUNTIME_TASK_ID:
            "12345678-abcd-4000-8000-123456789abc",
          ARCHESTRA_AGENT_RUNTIME_TASK: "Run the task.",
          ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT:
            "Follow the configured Agent instructions.",
          ARCHESTRA_AGENT_RUNTIME_MODE: mode,
          ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/test",
          ARCHESTRA_MCP_GATEWAY_TOKEN: "test-token",
          ANTHROPIC_AUTH_TOKEN: "test-key",
          ANTHROPIC_BASE_URL: "http://localhost:9000/v1/model-router/test",
        },
      });

      const mcpConfig = JSON.parse(
        await readFile(path.join(runtime, "claude-mcp.json"), "utf8"),
      );
      expect(mcpConfig.mcpServers.archestra.headers.Authorization).toBe(
        "Bearer test-token",
      );

      const args = (await readFile(path.join(runtime, "captured-args"), "utf8"))
        .trim()
        .split("\n");
      expect(args).toContain("--strict-mcp-config");
      expect(args.at(-1)).toBe("Run the task.");
      expect(args.includes("--print")).toBe(false);
      const settings = JSON.parse(
        await readFile(path.join(runtime, "claude-settings.json"), "utf8"),
      );
      expect(settings.hooks.Stop[0].hooks[0].command).toBe(
        path.join(runtime, "transcript-hook.sh"),
      );

      if (mode === "one_shot") {
        expect(args).toContain("--settings");
        expect(result.stdout).toContain("===ARCHESTRA-FINAL-ANSWER===");
        expect(result.stdout).toContain("Claude finished the task.");
        expect(
          JSON.parse(
            await readFile(
              path.join(runtime, "readable-transcript.json"),
              "utf8",
            ),
          ),
        ).toEqual({
          version: 1,
          provider: "claude-code",
          entries: [
            {
              type: "message",
              role: "user",
              text: "Build the feature.",
              timestamp: "2026-09-04T10:00:00Z",
            },
            {
              type: "message",
              role: "assistant",
              text: "I will inspect the code.",
              timestamp: "2026-09-04T10:00:01Z",
            },
            {
              type: "tool_call",
              name: "Read",
              input: '{"file_path":"src/app.ts"}',
              toolCallId: "tool-1",
              timestamp: "2026-09-04T10:00:01Z",
            },
            {
              type: "tool_result",
              text: "export const ready = true;",
              toolCallId: "tool-1",
              timestamp: "2026-09-04T10:00:02Z",
            },
            {
              type: "message",
              role: "assistant",
              text: "Claude finished the task.",
              timestamp: "2026-09-04T10:00:03Z",
            },
          ],
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a non-Anthropic protocol before starting Claude Code", async () => {
    await expect(
      execFileAsync("bash", [ENTRYPOINT], {
        env: {
          ...process.env,
          ARCHESTRA_LLM_PROXY_PROTOCOL: "openai_responses",
        },
      }),
    ).rejects.toMatchObject({ code: 78 });
  });
});

async function writeExecutable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, "utf8");
  await chmod(file, 0o755);
}
