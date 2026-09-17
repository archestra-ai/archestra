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
const EVENTS = path.resolve(
  import.meta.dirname,
  "../../../../agent_images/bin/archestra-codex-events",
);

describe("Codex image entrypoint", () => {
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
      expect(config.includes("notify = [")).toBe(true);
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

  test("settles a native authentication failure for the current one-shot turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-codex-auth-"));
    try {
      const bin = path.join(root, "bin");
      const runtime = path.join(root, "runtime");
      await mkdir(bin, { recursive: true });
      await writeExecutable(
        path.join(bin, "codex"),
        `#!/bin/sh
transcript="$ARCHESTRA_AGENT_RUNTIME_DIR/codex-transcript.jsonl"
printf '%s\n' \
  '{"timestamp":"2026-09-04T10:00:00Z","type":"session_meta","payload":{"id":"main-session"}}' \
  '{"timestamp":"2026-09-04T10:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Run the task."}]}}' \
  > "$transcript"
transcript_script="$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$CODEX_HOME/hooks.json")"
printf '{"hook_event_name":"SessionStart","session_id":"main-session","transcript_path":"%s"}' "$transcript" | "$transcript_script"
generation_before="$(cat "$ARCHESTRA_AGENT_RUNTIME_DIR/codex-turn-generation")"
printf '{"hook_event_name":"SessionStart","session_id":"child-session","transcript_path":"%s"}' "$transcript" | "$transcript_script"
test "$(cat "$ARCHESTRA_AGENT_RUNTIME_DIR/codex-turn-generation")" = "$generation_before"
notify_script="$(awk -F'"' '/^notify =/ { print $2 }' "$CODEX_HOME/config.toml")"
"$notify_script" '{"type":"task_complete","turn_id":"child-turn","session_id":"child-session","error":{"message":"unexpected status 401 Unauthorized: child","codex_error_info":"other"}}'
"$notify_script" '{"type":"task_started","turn_id":"child-turn"}'
"$notify_script" '{"type":"task_complete","turn_id":"child-turn","error":{"message":"unexpected status 401 Unauthorized: child","codex_error_info":"other"}}'
test ! -e "$ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX.failure"
test ! -e "$ARCHESTRA_AGENT_RUNTIME_DIR/codex-current-turn"
prompt_script="$(jq -r '.hooks.UserPromptSubmit[0].hooks[0].command' "$CODEX_HOME/hooks.json")"
printf '{"hook_event_name":"UserPromptSubmit","session_id":"main-session","turn_id":"main-turn","transcript_path":"%s"}' "$transcript" | "$prompt_script"
printf '%s\n' \
  '{"timestamp":"2026-09-04T10:00:01Z","type":"event_msg","payload":{"type":"task_started","turn_id":"main-turn"}}' \
  >> "$transcript"
printf '%s' \
  '{"timestamp":"2026-09-04T10:00:02Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"main-turn","last_agent_message":null,"error":{"message":"unexpected status 401 Unauthorized: provider","codex_error_info":"other"}}}' \
  >> "$transcript"
sleep 0.3
test ! -e "$ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX.failure"
printf '\n' >> "$transcript"
for attempt in $(seq 1 50); do
  if test -e "$ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX.failure"; then break; fi
  sleep 0.1
done
test -e "$ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX.failure"
trap 'exit 0' TERM
while :; do sleep 1; done
`,
      );
      const result = await execFileAsync("bash", [ENTRYPOINT], {
        cwd: root,
        timeout: 15000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ARCHESTRA_LLM_PROXY_PROTOCOL: "openai_responses",
          ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
          ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "test-model",
          ARCHESTRA_AGENT_RUNTIME_TASK_ID:
            "12345678-abcd-4000-8000-123456789abc",
          ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: path.join(root, "turn"),
          ARCHESTRA_AGENT_RUNTIME_TASK: "Run the task.",
          ARCHESTRA_AGENT_RUNTIME_MODE: "one_shot",
          ARCHESTRA_AGENT_RUNTIME_PLAIN: "0",
          ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/test",
          ARCHESTRA_MCP_GATEWAY_TOKEN: "test-token",
          OPENAI_API_KEY: "test-key",
          OPENAI_BASE_URL: "http://localhost:9000/v1/model-router/test",
        },
      }).catch((error) => error);

      expect(result.code).toBe(1);
      const failure = JSON.parse(
        await readFile(path.join(root, "turn.failure"), "utf8"),
      );
      expect(failure).toMatchObject({
        version: 1,
        code: "provider_credential_rejected",
      });
      expect(failure.message).toContain("provider credential was rejected");
      expect(
        await readFile(path.join(runtime, "final-answer.txt"), "utf8"),
      ).toBe(`${failure.message}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits an interactive diagnostic and clears attention on the next turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-codex-events-"));
    try {
      const runtime = path.join(root, "runtime");
      const prefix = path.join(root, "turn");
      const context = `${prefix}.events/context.json`;
      const taskId = "12345678-abcd-4000-8000-123456789abc";
      const attemptId = "22345678-abcd-4000-8000-123456789abc";
      await mkdir(path.dirname(context), { recursive: true });
      await mkdir(runtime, { recursive: true });
      await writeFile(
        context,
        JSON.stringify({ version: 1, taskId, attemptId }),
      );
      await writeFile(
        path.join(runtime, "codex-dispatch.json"),
        JSON.stringify({ version: 1, task_id: taskId, turn_prefix: prefix }),
      );
      const env = {
        ...process.env,
        PATH: `${path.dirname(EVENTS)}:${process.env.PATH}`,
        ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
        ARCHESTRA_AGENT_RUNTIME_TASK_ID: taskId,
        ARCHESTRA_AGENT_RUNTIME_ATTEMPT_ID: attemptId,
        ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: prefix,
        ARCHESTRA_AGENT_RUNTIME_MODE: "interactive",
        ARCHESTRA_CODEX_NATIVE_OBSERVER: "1",
      };

      await execFileAsync(
        "bash",
        [
          EVENTS,
          JSON.stringify({ type: "task_started", turn_id: "first-turn" }),
        ],
        { env },
      );
      await execFileAsync(
        "bash",
        [
          EVENTS,
          JSON.stringify({
            type: "task_complete",
            turn_id: "first-turn",
            error: {
              message: "unexpected status 401 Unauthorized: provider",
              codex_error_info: "other",
            },
          }),
        ],
        { env },
      );
      await rm(path.join(runtime, "codex-current-turn"));
      await execFileAsync(
        "bash",
        [
          EVENTS,
          JSON.stringify({ type: "task_started", turn_id: "second-turn" }),
        ],
        { env },
      );
      await execFileAsync(
        "bash",
        [
          EVENTS,
          JSON.stringify({
            type: "task_complete",
            turn_id: "second-turn",
            last_agent_message: "Recovered.",
          }),
        ],
        { env },
      );

      const events = JSON.parse(
        (
          await execFileAsync(
            "archestra-agent-event",
            ["read", "--task", taskId, "--context", context],
            { env },
          )
        ).stdout,
      ).events as Array<Record<string, unknown>>;
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "diagnostic",
            source: "native-codex",
            error: expect.objectContaining({
              code: "provider_credential_rejected",
            }),
          }),
          expect.objectContaining({
            type: "agent.status",
            source: "native-codex",
            status: "working",
            attention: null,
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rotates the native observer generation between interactive prompts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-codex-turns-"));
    try {
      const bin = path.join(root, "bin");
      const runtime = path.join(root, "runtime");
      await mkdir(bin, { recursive: true });
      const attentionCommand = path.join(bin, "attention");
      await writeExecutable(
        attentionCommand,
        `#!/bin/sh
printf '%s\n' "$*" >> "$ARCHESTRA_AGENT_RUNTIME_DIR/attention-calls"
`,
      );
      await writeExecutable(
        path.join(bin, "codex"),
        [
          "#!/bin/sh",
          'transcript="$ARCHESTRA_AGENT_RUNTIME_DIR/codex-transcript.jsonl"',
          `printf '%s\\n' '{"timestamp":"2026-09-04T10:00:00Z","type":"session_meta","payload":{"id":"main-session"}}' > "$transcript"`,
          `transcript_script="$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$CODEX_HOME/hooks.json")"`,
          `prompt_script="$(jq -r '.hooks.UserPromptSubmit[0].hooks[0].command' "$CODEX_HOME/hooks.json")"`,
          `printf '{"hook_event_name":"SessionStart","session_id":"main-session","transcript_path":"%s"}' "$transcript" | "$transcript_script"`,
          `printf '{"hook_event_name":"UserPromptSubmit","session_id":"main-session","turn_id":"first-turn","transcript_path":"%s"}' "$transcript" | "$prompt_script"`,
          'generation_one="$(cat "$ARCHESTRA_AGENT_RUNTIME_DIR/codex-turn-generation")"',
          `printf '%s\\n' '{"type":"event_msg","payload":{"type":"task_started","turn_id":"first-turn"}}' >> "$transcript"`,
          `for attempt in $(seq 1 30); do if test "$(cat "$ARCHESTRA_AGENT_RUNTIME_DIR/codex-current-turn" 2>/dev/null || true)" = first-turn; then break; fi; sleep 0.1; done`,
          'test "$(cat "$ARCHESTRA_AGENT_RUNTIME_DIR/codex-current-turn")" = first-turn',
          `notify_script="$(awk -F'"' '/^notify =/ { print $2 }' "$CODEX_HOME/config.toml")"`,
          `"$notify_script" '{"type":"agent-turn-complete","input-messages":["Run the task."],"last-assistant-message":"First turn complete."}'`,
          `test ! -e "$ARCHESTRA_AGENT_RUNTIME_DIR/turn-complete"`,
          "sleep 0.01",
          `printf '{"hook_event_name":"UserPromptSubmit","session_id":"main-session","turn_id":"second-turn","transcript_path":"%s"}' "$transcript" | "$prompt_script"`,
          'generation_two="$(cat "$ARCHESTRA_AGENT_RUNTIME_DIR/codex-turn-generation")"',
          'test "$generation_one" != "$generation_two"',
          `printf '%s\\n' '{"type":"event_msg","payload":{"type":"task_started","turn_id":"second-turn"}}' >> "$transcript"`,
          `for attempt in $(seq 1 30); do if test "$(cat "$ARCHESTRA_AGENT_RUNTIME_DIR/codex-current-turn" 2>/dev/null || true)" = second-turn; then break; fi; sleep 0.1; done`,
          'test "$(cat "$ARCHESTRA_AGENT_RUNTIME_DIR/codex-current-turn")" = second-turn',
          `printf '%s\\n' '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"second-turn","error":{"message":"unexpected status 401 Unauthorized: provider","codex_error_info":"other"}}}' >> "$transcript"`,
          `for attempt in $(seq 1 30); do if grep -q 'Authentication needed' "$ARCHESTRA_AGENT_RUNTIME_DIR/attention-calls" 2>/dev/null; then break; fi; sleep 0.1; done`,
          `grep -q 'Authentication needed' "$ARCHESTRA_AGENT_RUNTIME_DIR/attention-calls"`,
          `printf '{"hook_event_name":"SessionEnd","session_id":"main-session","transcript_path":"%s"}' "$transcript" | "$transcript_script"`,
        ].join("\n"),
      );
      await execFileAsync("bash", [ENTRYPOINT], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ARCHESTRA_LLM_PROXY_PROTOCOL: "openai_responses",
          ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
          ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "test-model",
          ARCHESTRA_AGENT_RUNTIME_TASK_ID:
            "12345678-abcd-4000-8000-123456789abc",
          ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: path.join(root, "turn"),
          ARCHESTRA_AGENT_RUNTIME_TASK: "Run the task.",
          ARCHESTRA_AGENT_RUNTIME_MODE: "interactive",
          ARCHESTRA_AGENT_RUNTIME_PLAIN: "0",
          ARCHESTRA_AGENT_ATTENTION_COMMAND: attentionCommand,
          ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/test",
          ARCHESTRA_MCP_GATEWAY_TOKEN: "test-token",
          OPENAI_API_KEY: "test-key",
          OPENAI_BASE_URL: "http://localhost:9000/v1/model-router/test",
        },
      });
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
