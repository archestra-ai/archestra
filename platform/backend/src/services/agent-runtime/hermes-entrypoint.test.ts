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
  test.each([
    "one_shot",
    "interactive",
  ] as const)("configures and starts %s run in the native TUI", async (mode) => {
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
if [ "$ARCHESTRA_AGENT_RUNTIME_MODE" = "one_shot" ]; then
  hook_script="$(jq -r '.hooks.post_llm_call[0].command' "$HERMES_HOME/config.yaml")"
  printf '%s' '{"hook_event_name":"on_session_start","session_id":"main-session","extra":{}}' | "$hook_script"
  printf '%s' '{"hook_event_name":"post_llm_call","session_id":"subagent-session","extra":{"assistant_response":"Ignore this subagent answer."}}' | "$hook_script"
  test ! -e "$ARCHESTRA_AGENT_RUNTIME_DIR/turn-complete"
  python3 - "$HERMES_HOME/state.db" <<'PYTHON'
import sqlite3
import sys

with sqlite3.connect(sys.argv[1]) as database:
    database.execute("CREATE TABLE sessions (id TEXT, source TEXT, parent_session_id TEXT, started_at REAL)")
    database.execute("CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, active INTEGER, finish_reason TEXT)")
    database.execute("INSERT INTO sessions VALUES ('main-session', 'tui', NULL, 1)")
    database.execute("INSERT INTO messages VALUES (1, 'main-session', 'user', 'Run the task.', 1, NULL)")
    database.execute("INSERT INTO messages VALUES (2, 'main-session', 'assistant', 'Hermes finished the task.', 1, 'stop')")
PYTHON
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
          ARCHESTRA_LLM_PROXY_PROTOCOL: "openai_chat",
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
          OPENAI_API_KEY: "test-key",
          OPENAI_BASE_URL: "http://localhost:9000/v1/model-router/test",
        },
      });

      const config = JSON.parse(
        await readFile(path.join(runtime, "hermes", "config.yaml"), "utf8"),
      );
      expect(config.providers.archestra.transport).toBe("openai_chat");
      expect(config.mcp_servers.archestra.headers.Authorization).toBe(
        "Bearer test-token",
      );
      if (mode === "one_shot") {
        expect(config.hooks).toEqual({
          on_session_start: [
            { command: `${runtime}/hermes-completion-hook.sh` },
          ],
          post_llm_call: [{ command: `${runtime}/hermes-completion-hook.sh` }],
        });
        expect(config.hooks_auto_accept).toBe(true);
        expect(result.stdout).toContain("===ARCHESTRA-FINAL-ANSWER===");
        expect(result.stdout).toContain("Hermes finished the task.");
      } else {
        expect(config.hooks).toBeUndefined();
      }

      const args = (await readFile(path.join(runtime, "captured-args"), "utf8"))
        .trim()
        .split("\n");
      expect(args[0]).toBe("chat");
      expect(args).toContain("--tui");
      expect(args.at(-1)).toBe("Run the task.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a non-Chat protocol before starting Hermes", async () => {
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
