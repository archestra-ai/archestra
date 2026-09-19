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
import { agentRuntimeFailureReason } from "./failure-reason";

const execFileAsync = promisify(execFile);
const ENTRYPOINT = path.resolve(
  import.meta.dirname,
  "../../../../agent_images/bin/archestra-codex",
);

describe("Codex image entrypoint", () => {
  test("publishes Unicode errors within the platform decoder limits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-unicode-error-"));
    try {
      await execFileAsync(
        "python3",
        [
          "-c",
          'import runpy, sys; from pathlib import Path; watch = runpy.run_path(sys.argv[1]); watch["publish_failure"](Path(sys.argv[2]), "Authentication failed. " + "x" * 1500 + "\\U0001f99e" * 300)',
          path.join(path.dirname(ENTRYPOINT), "archestra-codex-failure-watch"),
          root,
        ],
        {
          env: {
            ...process.env,
            ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: path.join(root, "turn"),
          },
        },
      );
      const payload = await readFile(path.join(root, "turn.failure"), "utf8");
      const envelope = JSON.parse(payload);
      expect(agentRuntimeFailureReason(`1\n${payload}`)).toBe(
        `${envelope.message} (Runtime exit status 1.)`,
      );
      expect(envelope.message).toMatch(/^Authentication failed\./);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    "one_shot",
    "interactive",
    "isolated",
  ] as const)("configures and starts %s run in the native TUI", async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-codex-"));
    try {
      const bin = path.join(root, "bin");
      const runtime = path.join(root, "runtime");
      const stateDir =
        mode === "isolated" ? path.join(root, "separate-state") : runtime;
      const workspace = path.join(root, 'workspace "quoted" \\ folder');
      await Promise.all([
        mkdir(bin, { recursive: true }),
        mkdir(workspace, { recursive: true }),
      ]);
      await writeExecutable(
        path.join(bin, "codex"),
        `#!/bin/sh
printf '%s\n' "$@" > "$ARCHESTRA_AGENT_RUNTIME_DIR/captured-args"
if [ "$ARCHESTRA_AGENT_RUNTIME_MODE" = "one_shot" ]; then
  transcript="$ARCHESTRA_AGENT_RUNTIME_DIR/codex-transcript.jsonl"
  printf '%s\n' \
    '{"timestamp":"2026-09-04T10:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Inspect the file."}]}}' \
    '{"timestamp":"2026-09-04T10:00:01Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I will inspect it."}]}}' \
    '{"timestamp":"2026-09-04T10:00:02Z","type":"response_item","payload":{"type":"function_call","name":"read_file","arguments":"{\\"path\\":\\"src/app.ts\\"}","call_id":"call-1"}}' \
    '{"timestamp":"2026-09-04T10:00:03Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"export const ready = true;"}}' \
    '{"timestamp":"2026-09-04T10:00:04Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Codex finished the task."}]}}' \
    > "$transcript"
  transcript_script="$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$CODEX_HOME/hooks.json")"
  printf '{"hook_event_name":"SessionStart","session_id":"main-session","transcript_path":"%s"}' "$transcript" | "$transcript_script"
  printf '{"hook_event_name":"Stop","session_id":"subagent-session","transcript_path":"%s"}' "$transcript" | "$transcript_script"
  test ! -e "$ARCHESTRA_AGENT_RUNTIME_DIR/readable-transcript.json"
  printf '{"hook_event_name":"Stop","session_id":"main-session","transcript_path":"%s"}' "$transcript" | "$transcript_script"
  notify_script="$(awk -F'"' '/^notify =/ { print $2 }' "$CODEX_HOME/config.toml")"
  "$notify_script" '{"type":"agent-turn-complete","input-messages":["A subagent task."],"last-assistant-message":"Ignore this subagent answer."}'
  test ! -e "$ARCHESTRA_AGENT_RUNTIME_DIR/turn-complete"
  "$notify_script" '{"type":"agent-turn-complete","input-messages":["Run the task."],"last-assistant-message":"Codex finished the task."}'
  trap 'exit 0' TERM
  while :; do sleep 1; done
fi
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
        ARCHESTRA_AGENT_RUNTIME_MODE:
          mode === "isolated" ? "interactive" : mode,
        ARCHESTRA_AGENT_RUNTIME_NATIVE_STATE_DIR: stateDir,
        ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/test",
        ARCHESTRA_MCP_GATEWAY_TOKEN: "test-token",
        ARCHESTRA_AGENT_ATTENTION_COMMAND: attentionCommand,
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "http://localhost:9000/v1/model-router/test",
      };

      const result = await execFileAsync("bash", [ENTRYPOINT], {
        cwd: workspace,
        env,
      });

      const config = await readFile(
        path.join(stateDir, "codex", "config.toml"),
        "utf8",
      );
      expect(config).toContain('wire_api = "responses"');
      const parsedConfig = JSON.parse(
        (
          await execFileAsync("python3", [
            "-c",
            "import json, sys, tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))",
            path.join(stateDir, "codex", "config.toml"),
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
        await readFile(path.join(stateDir, "codex", "hooks.json"), "utf8"),
      );
      expect(hooks.hooks.PreToolUse[0].matcher).toBe("^request_user_input$");

      const args = (await readFile(path.join(runtime, "captured-args"), "utf8"))
        .trim()
        .split("\n");
      expect(args[0]).toBe("--dangerously-bypass-approvals-and-sandbox");
      expect(args).not.toContain("exec");
      expect(args.at(-1)).toBe("Run the task.");

      if (mode === "one_shot") {
        expect(result.stdout).toContain("===ARCHESTRA-FINAL-ANSWER===");
        expect(result.stdout).toContain("Codex finished the task.");
        expect(
          JSON.parse(
            await readFile(
              path.join(runtime, "readable-transcript.json"),
              "utf8",
            ),
          ),
        ).toEqual({
          version: 1,
          provider: "codex",
          entries: [
            {
              type: "message",
              role: "user",
              text: "Inspect the file.",
              timestamp: "2026-09-04T10:00:00Z",
            },
            {
              type: "message",
              role: "assistant",
              text: "I will inspect it.",
              timestamp: "2026-09-04T10:00:01Z",
            },
            {
              type: "tool_call",
              name: "read_file",
              input: '{"path":"src/app.ts"}',
              toolCallId: "call-1",
              timestamp: "2026-09-04T10:00:02Z",
            },
            {
              type: "tool_result",
              text: "export const ready = true;",
              toolCallId: "call-1",
              timestamp: "2026-09-04T10:00:03Z",
            },
            {
              type: "message",
              role: "assistant",
              text: "Codex finished the task.",
              timestamp: "2026-09-04T10:00:04Z",
            },
          ],
        });
      } else {
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

  test.each([
    "one_shot",
    "interactive",
  ])("surfaces terminal native errors in %s mode without replaying old or child errors", async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-failure-"));
    try {
      const runtime = path.join(root, "runtime");
      const bin = path.join(root, "bin");
      await mkdir(runtime);
      await mkdir(bin);
      const transcript = path.join(runtime, "main.jsonl");
      await writeFile(path.join(runtime, "codex-main-session"), "main");
      await writeFile(path.join(runtime, "codex-main-transcript"), transcript);
      await writeFile(
        transcript,
        `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", error: { message: "old error" } } })}\n`,
      );
      await writeExecutable(
        path.join(bin, "codex"),
        `#!/usr/bin/env python3
import json, os, pathlib, subprocess, time
runtime = pathlib.Path(os.environ["ARCHESTRA_AGENT_RUNTIME_DIR"])
hooks = json.loads((pathlib.Path(os.environ["CODEX_HOME"]) / "hooks.json").read_text())
hook = hooks["hooks"]["SessionStart"][0]["hooks"][0]["command"]
def start(session, transcript):
    subprocess.run([hook], input=json.dumps({"hook_event_name":"SessionStart", "session_id":session, "transcript_path":str(transcript)}), text=True, check=True)
def event(path, kind, message):
    with path.open("a") as f:
        f.write(json.dumps({"type":"event_msg", "payload":{"type":kind, "error":{"message":message}}}) + "\\n")
main = runtime / "main.jsonl"
start("main", main)
child = runtime / "child.jsonl"
start("child", child)
event(child, "task_complete", "child error")
event(main, "stream_error", "retry error")
time.sleep(0.5)
assert not (runtime / "turn-complete").exists(), "old, child or retry error settled main"
event(main, "task_complete", 'Authentication failed. Reconnect your account. token=synthetic-secret url: https://user:secret@example.test/?api_key=secret')
for _ in range(50):
    if (runtime / "turn-complete").exists() or "API error" in (runtime / "attention-calls").read_text():
        break
    time.sleep(0.1)
else:
    raise SystemExit(99)
if os.environ["ARCHESTRA_AGENT_RUNTIME_MODE"] == "one_shot":
    time.sleep(10)
`,
      );
      await writeFile(path.join(runtime, "attention-calls"), "");
      await writeExecutable(
        path.join(bin, "attention"),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ARCHESTRA_AGENT_RUNTIME_DIR/attention-calls"\n',
      );
      const result = await execFileAsync("bash", [ENTRYPOINT], {
        cwd: root,
        timeout: 15000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ARCHESTRA_LLM_PROXY_PROTOCOL: "openai_responses",
          ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
          ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: path.join(root, "turn"),
          ARCHESTRA_AGENT_RUNTIME_MODE: mode,
          ARCHESTRA_AGENT_RUNTIME_CONTINUE: "1",
          ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "test-model",
          ARCHESTRA_AGENT_RUNTIME_TASK_ID: "main",
          ARCHESTRA_AGENT_RUNTIME_TASK: "Complete the task.",
          ARCHESTRA_AGENT_ATTENTION_COMMAND: path.join(bin, "attention"),
          ARCHESTRA_MCP_GATEWAY_URL: "http://localhost/mcp",
          ARCHESTRA_MCP_GATEWAY_TOKEN: "synthetic-token",
          OPENAI_BASE_URL: "http://localhost/v1",
          OPENAI_API_KEY: "synthetic-secret",
        },
      }).catch((error) => error);
      if (mode === "one_shot") {
        expect(result.code).toBe(1);
        const failure = JSON.parse(
          await readFile(path.join(root, "turn.failure"), "utf8"),
        );
        expect(failure).toEqual({
          version: 1,
          code: "codex_turn_failed",
          message:
            "Authentication failed. Reconnect your account. token=[REDACTED] url: [REDACTED]",
        });
        expect(
          await readFile(path.join(runtime, "final-answer.txt"), "utf8"),
        ).toBe(`${failure.message}\n`);
        expect(result.stdout).not.toContain("synthetic-secret");
      } else {
        expect(result.code ?? 0).toBe(0);
        await expect(
          readFile(path.join(root, "turn.failure")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          readFile(path.join(runtime, "turn-complete")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          await readFile(path.join(runtime, "attention-calls"), "utf8"),
        ).toContain("set API error: check terminal");
      }
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
        HOOK_PAYLOAD: JSON.stringify(params.payload),
      },
    },
  );
}
