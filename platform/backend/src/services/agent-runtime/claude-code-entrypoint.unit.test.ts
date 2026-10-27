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
import { makeFastImageEntrypoint } from "@/test/subprocess-entrypoint";

const execFileAsync = promisify(execFile);
const ENTRYPOINT = path.resolve(
  import.meta.dirname,
  "../../../../docker_images/agent/bin/archestra-claude-code",
);

describe("Claude Code image entrypoint", () => {
  test.each([
    ["authentication_failed", "claude_authentication", "one_shot"],
    ["authentication_failed", "claude_authentication", "interactive"],
    ["rate_limit", "claude_rate_limit", "one_shot"],
    ["billing_error", "claude_billing", "one_shot"],
    ["unrecognized-secret", "claude_api_error", "one_shot"],
  ])("handles API failure %s (%s) in %s mode", async (error, code, mode) => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-stop-failure-"));
    try {
      const entrypoint = await makeFastImageEntrypoint(
        root,
        "archestra-claude-code",
      );
      const bin = path.join(root, "bin");
      const runtime = path.join(root, "runtime");
      await mkdir(bin);
      await mkdir(runtime);
      await writeExecutable(
        path.join(bin, "archestra-agent-attention"),
        `#!/bin/sh
printf '%s\\n' "$*" > "$ARCHESTRA_AGENT_RUNTIME_DIR/attention"
`,
      );
      await writeExecutable(
        path.join(bin, "claude"),
        `#!/bin/sh
previous=""
for argument in "$@"; do
  if [ "$previous" = "--settings" ]; then settings="$argument"; fi
  previous="$argument"
done
hook="$(jq -r '.hooks.StopFailure[0].hooks[0].command' "$settings")"
printf '%s' "$TEST_FAILURE_PAYLOAD" | "$hook"
if [ "$ARCHESTRA_AGENT_RUNTIME_MODE" = "interactive" ]; then exit 0; fi
trap 'exit 0' TERM
while :; do sleep 0.1; done
`,
      );
      const result = await execFileAsync("bash", [entrypoint], {
        cwd: root,
        timeout: 15000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: root,
          ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
          ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: path.join(runtime, "test-turn"),
          ARCHESTRA_AGENT_RUNTIME_MODE: mode,
          ARCHESTRA_LLM_PROXY_PROTOCOL: "anthropic",
          ARCHESTRA_AGENT_RUNTIME_TASK: "Example task",
          ARCHESTRA_AGENT_RUNTIME_TASK_ID: "test-task",
          ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "test-model",
          ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/example",
          ARCHESTRA_MCP_GATEWAY_TOKEN: "example-gateway-token",
          TEST_FAILURE_PAYLOAD: JSON.stringify({
            hook_event_name: "StopFailure",
            error,
            error_details: "synthetic-secret-do-not-forward",
            last_assistant_message: "synthetic-secret-do-not-forward",
          }),
        },
      })
        .then((output) => ({ ...output, code: 0, killed: false }))
        .catch((failure) => failure);
      if (mode === "interactive") {
        expect(result.code).toBe(0);
        expect(
          await readFile(path.join(runtime, "attention"), "utf8"),
        ).toContain("API error: check terminal");
        await expect(
          readFile(path.join(runtime, "turn-complete")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          readFile(path.join(runtime, "test-turn.failure")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      expect(result.code).toBe(1);
      expect(result.killed).not.toBe(true);
      const failure = JSON.parse(
        await readFile(path.join(runtime, "test-turn.failure"), "utf8"),
      );
      expect(failure).toMatchObject({ version: 1, code });
      expect(failure.message).toContain("Claude Code");
      expect(JSON.stringify(failure)).not.toContain("synthetic-secret");
      expect(JSON.stringify(failure)).not.toContain("unrecognized-secret");
      expect(result.stdout).not.toContain("synthetic-secret");
      expect(result.stderr).not.toContain("synthetic-secret");
      expect(result.stdout).toContain(failure.message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    "subscription",
    "provider",
  ])("isolates %s authentication at CLI startup", async (authentication) => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-auth-env-"));
    try {
      const entrypoint = await makeFastImageEntrypoint(
        root,
        "archestra-claude-code",
      );
      const bin = path.join(root, "bin");
      const runtime = path.join(root, "runtime");
      await mkdir(bin);
      await mkdir(runtime);
      await writeExecutable(
        path.join(bin, "claude"),
        `#!/usr/bin/env python3
import json, os
from pathlib import Path
Path(os.environ["ARCHESTRA_AGENT_RUNTIME_DIR"], "captured-env").write_text(json.dumps(dict(os.environ)))
`,
      );
      await execFileAsync("bash", [entrypoint], {
        cwd: root,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: root,
          ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
          ARCHESTRA_AGENT_RUNTIME_MODE: "interactive",
          ARCHESTRA_AGENT_RUNTIME_CLAUDE_AUTH: authentication,
          ARCHESTRA_LLM_PROXY_PROTOCOL: "anthropic",
          ARCHESTRA_AGENT_RUNTIME_TASK: "Example task",
          ARCHESTRA_AGENT_RUNTIME_TASK_ID: "test-task",
          ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "test-model",
          ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/example",
          ARCHESTRA_MCP_GATEWAY_TOKEN: "example-gateway-token",
          CLAUDE_CODE_OAUTH_TOKEN: "example-subscription-token",
          ANTHROPIC_AUTH_TOKEN: "example-proxy-token",
          ANTHROPIC_API_KEY: "example-api-key",
          ANTHROPIC_BASE_URL: "http://localhost:9000/example",
          ANTHROPIC_CUSTOM_HEADERS:
            "X-Archestra-Virtual-Key: example-passthrough-token",
          CLAUDE_CODE_USE_VERTEX: "1",
        },
      });
      const captured = JSON.parse(
        await readFile(path.join(runtime, "captured-env"), "utf8"),
      );
      if (authentication === "subscription") {
        expect(captured.CLAUDE_CODE_OAUTH_TOKEN).toBe(
          "example-subscription-token",
        );
        for (const key of [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_USE_VERTEX",
        ])
          expect(captured).not.toHaveProperty(key);
        expect(captured.ANTHROPIC_BASE_URL).toBe(
          "http://localhost:9000/example",
        );
      } else {
        expect(captured).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
        expect(captured.ANTHROPIC_AUTH_TOKEN).toBe("example-proxy-token");
      }
      // Without a workspace, the task names the session.
      expect(captured.ANTHROPIC_CUSTOM_HEADERS).toBe(
        "X-Archestra-Virtual-Key: example-passthrough-token\nX-Archestra-Session-Id: test-task\nX-Appa-Session-ID: test-task",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    "one_shot",
    "interactive",
  ] as const)("configures and starts %s run in the native TUI", async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-claude-code-"));
    try {
      const entrypoint = await makeFastImageEntrypoint(
        root,
        "archestra-claude-code",
      );
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
  printf '{"hook_event_name":"Stop","transcript_path":"%s","background_tasks":[],"session_crons":[]}' "$transcript" | "$hook_script"
  trap 'exit 0' TERM
  while :; do sleep 1; done
fi
`,
      );

      const result = await execFileAsync("bash", [entrypoint], {
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
          ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID: "agent-run-claude-12345678",
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
      // The workspace outlives a follow-up's new task, so OpenAPPA keeps one
      // root for the whole conversation.
      expect(mcpConfig.mcpServers.archestra.headers).toMatchObject({
        "X-Archestra-Run-Id": "12345678-abcd-4000-8000-123456789abc",
        "X-Archestra-Session-Id": "agent-run-claude-12345678",
        "X-Appa-Session-ID": "agent-run-claude-12345678",
      });

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

      // Capture identity at startup, before a first response can be cancelled.
      for (const sessionId of ["original-session", "unrelated-session"]) {
        await execFileAsync(
          "bash",
          [
            "-c",
            'printf "%s" "$TEST_HOOK_PAYLOAD" | "$1"',
            "hook-test",
            settings.hooks.SessionStart[0].hooks[0].command,
          ],
          {
            env: {
              ...process.env,
              ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
              TEST_HOOK_PAYLOAD: JSON.stringify({
                hook_event_name: "SessionStart",
                session_id: sessionId,
              }),
            },
          },
        );
        expect(
          (
            await readFile(path.join(runtime, "claude-session-id"), "utf8")
          ).trim(),
        ).toBe("original-session");
      }

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
      // The native transcript is flushed asynchronously. A Stop payload must
      // preserve its final response even when the JSONL ends at a tool result.
      const laggingTranscript = path.join(runtime, "lagging.jsonl");
      const finalText = "Final response from hook payload.";
      for (const flushed of [false, true]) {
        await rm(path.join(runtime, "turn-complete"), { force: true });
        await writeFile(
          laggingTranscript,
          `${[
            JSON.stringify({
              type: "user",
              message: { content: "Finish the task." },
            }),
            ...(flushed
              ? [
                  JSON.stringify({
                    type: "assistant",
                    message: { content: finalText },
                  }),
                ]
              : []),
          ].join("\n")}\n`,
        );
        await execFileAsync(
          "bash",
          [
            "-c",
            'printf "%s" "$TEST_HOOK_PAYLOAD" | "$1"',
            "hook-test",
            path.join(runtime, "transcript-hook.sh"),
          ],
          {
            env: {
              ...process.env,
              ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
              ARCHESTRA_AGENT_RUNTIME_MODE: mode,
              TEST_HOOK_PAYLOAD: JSON.stringify({
                hook_event_name: "Stop",
                transcript_path: laggingTranscript,
                last_assistant_message: finalText,
                background_tasks: [],
                session_crons: [],
              }),
            },
          },
        );
        const readable = JSON.parse(
          await readFile(
            path.join(runtime, "readable-transcript.json"),
            "utf8",
          ),
        );
        expect(readable.entries).toEqual([
          { type: "message", role: "user", text: "Finish the task." },
          { type: "message", role: "assistant", text: finalText },
        ]);
        if (mode === "one_shot") {
          expect(
            (
              await readFile(path.join(runtime, "final-answer.txt"), "utf8")
            ).trim(),
          ).toBe(finalText);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["shell", "one_shot"],
    ["unknown-native-task", "one_shot"],
    ["cron", "one_shot"],
    ["subagent", "interactive"],
  ] as const)("keeps the run open while a background %s runs in %s mode", async (type, mode) => {
    await withClaudeHookSequence({
      mode,
      // A marker left by a killed run must not hold a later turn.
      initialFiles: ["turn-waiting-background"],
      payloads: {
        TEST_WAITING_PAYLOAD: {
          hook_event_name: "Stop",
          last_assistant_message: "Waiting for the background agent.",
          background_tasks:
            type === "cron"
              ? []
              : [
                  {
                    id: "agent-1",
                    type,
                    status: "running",
                    description: "Review the change",
                  },
                ],
          session_crons:
            type === "cron"
              ? [
                  {
                    id: "cron-1",
                    schedule: "* * * * *",
                    recurring: true,
                    prompt: "Check review progress",
                  },
                ]
              : [],
        },
        TEST_DONE_PAYLOAD: {
          hook_event_name: "Stop",
          last_assistant_message: "All agents reported.",
          background_tasks: [],
          session_crons: [],
        },
      },
      script: `held="$ARCHESTRA_AGENT_RUNTIME_DIR/held"
printf '%s' "$TEST_WAITING_PAYLOAD" | "$stop_hook" >/dev/null
for marker in turn-complete final-answer.txt; do
  if [ -e "$ARCHESTRA_AGENT_RUNTIME_DIR/$marker" ]; then echo "$marker" >> "$held"; fi
done
: > "$ARCHESTRA_AGENT_RUNTIME_DIR/attention"
printf '%s' '{"hook_event_name":"Notification","notification_type":"idle_prompt"}' | "$attention_hook"
cp "$ARCHESTRA_AGENT_RUNTIME_DIR/attention" "$ARCHESTRA_AGENT_RUNTIME_DIR/attention-while-waiting"
printf '%s' "$TEST_DONE_PAYLOAD" | "$stop_hook" >/dev/null`,
      verify: async ({ runtime, result }) => {
        expect(result.code).toBe(0);
        expect(result.killed).not.toBe(true);
        const attention = await readFile(
          path.join(runtime, "attention-while-waiting"),
          "utf8",
        );
        if (mode === "interactive") {
          // Interactive turns never complete the run, and an idle session waits
          // for a person.
          expect(attention.trim()).toBe("set Waiting for input");
          for (const file of ["turn-complete", "final-answer.txt", "held"]) {
            await expect(
              readFile(path.join(runtime, file)),
            ).rejects.toMatchObject({ code: "ENOENT" });
          }
          return;
        }
        await expect(
          readFile(path.join(runtime, "held")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(attention.trim()).toBe("clear");
        const answer = result.stdout
          .split("===ARCHESTRA-FINAL-ANSWER===\n")[1]
          ?.split("\n===ARCHESTRA-FINAL-ANSWER-END===")[0];
        expect(answer?.trim()).toBe("All agents reported.");
        await expect(
          readFile(path.join(runtime, "turn-waiting-background")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      },
    });
  });

  test.each([
    ["background inventory missing", { session_crons: [] }],
    ["schedule inventory missing", { background_tasks: [] }],
    [
      "malformed background inventory",
      { background_tasks: {}, session_crons: [] },
    ],
    [
      "malformed schedule inventory",
      { background_tasks: [], session_crons: null },
    ],
  ])("fails explicitly when %s", async (_name, inventory) => {
    await withClaudeHookSequence({
      payloads: {
        TEST_STOP_PAYLOAD: {
          hook_event_name: "Stop",
          last_assistant_message: "This must not be reported as success.",
          ...inventory,
        },
      },
      script: `printf '%s' "$TEST_STOP_PAYLOAD" | "$stop_hook"`,
      verify: async ({ runtime, result }) => {
        expect(result.code).toBe(1);
        expect(result.killed).not.toBe(true);
        const failure = JSON.parse(
          await readFile(path.join(runtime, "test-turn.failure"), "utf8"),
        );
        expect(failure).toMatchObject({
          version: 1,
          code: "background_state_unavailable",
        });
        expect(result.stdout).toContain(failure.message);
        expect(result.stdout).not.toContain(
          "This must not be reported as success.",
        );
      },
    });
  });

  test("reports permission requests and API failure while background work is pending", async () => {
    await withClaudeHookSequence({
      payloads: {
        TEST_WAITING_PAYLOAD: {
          hook_event_name: "Stop",
          last_assistant_message: "Waiting for the review.",
          background_tasks: [
            { id: "review-1", type: "shell", status: "running" },
          ],
          session_crons: [],
        },
      },
      script: `printf '%s' "$TEST_WAITING_PAYLOAD" | "$stop_hook"
if [ -e "$ARCHESTRA_AGENT_RUNTIME_DIR/turn-complete" ]; then
  touch "$ARCHESTRA_AGENT_RUNTIME_DIR/premature-completion"
fi
printf '%s' '{"hook_event_name":"Notification","notification_type":"permission_prompt"}' | "$attention_hook"
printf '%s' '{"hook_event_name":"StopFailure","error":"rate_limit"}' | "$failure_hook"`,
      verify: async ({ runtime, result }) => {
        expect(result.code).toBe(1);
        expect(result.killed).not.toBe(true);
        await expect(
          readFile(path.join(runtime, "premature-completion")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          await readFile(path.join(runtime, "attention"), "utf8"),
        ).toContain("set Permission needed");
        expect(
          JSON.parse(
            await readFile(path.join(runtime, "test-turn.failure"), "utf8"),
          ),
        ).toMatchObject({ version: 1, code: "claude_rate_limit" });
        expect(result.stdout).toContain("Claude Code reached a rate limit.");
        expect(result.stdout).not.toContain("Waiting for the review.");
      },
    });
  });

  test("ignores a foreign subagent Stop before the main session completes", async () => {
    await withClaudeHookSequence({
      payloads: {},
      script: `printf '%s' '{"hook_event_name":"SessionStart","session_id":"main-session"}' | "$session_hook"
printf '%s' '{"hook_event_name":"Stop","session_id":"child-session","last_assistant_message":"Child finished."}' | "$stop_hook"
for marker in turn-complete final-answer.txt test-turn.failure; do
  if [ -e "$ARCHESTRA_AGENT_RUNTIME_DIR/$marker" ]; then
    touch "$ARCHESTRA_AGENT_RUNTIME_DIR/premature-completion"
  fi
done
printf '%s' '{"hook_event_name":"Stop","session_id":"main-session","last_assistant_message":"Main session finished.","background_tasks":[],"session_crons":[]}' | "$stop_hook"`,
      verify: async ({ runtime, result }) => {
        expect(result.code).toBe(0);
        expect(result.killed).not.toBe(true);
        await expect(
          readFile(path.join(runtime, "premature-completion")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(result.stdout).toContain("Main session finished.");
        expect(result.stdout).not.toContain("Child finished.");
      },
    });
  });

  test.each([
    ["Bash", { backgroundTaskId: "review-1" }],
    ["Agent", { isAsync: true, agentId: "review-1" }],
  ])("waits for %s result delivery and a fresh answer after its inventory becomes empty", async (toolName, toolResponse) => {
    await withClaudeHookSequence({
      payloads: {
        TEST_LAUNCH_PAYLOAD: {
          hook_event_name: "PostToolUse",
          tool_name: toolName,
          tool_response: toolResponse,
        },
        TEST_WAITING_PAYLOAD: {
          hook_event_name: "Stop",
          last_assistant_message: "The result has not reached me yet.",
          background_tasks: [],
          session_crons: [],
        },
        TEST_UNRELATED_INPUT: {
          hook_event_name: "UserPromptSubmit",
          prompt:
            "<task-notification><task-id>other-job</task-id></task-notification>",
        },
        TEST_RESULT_INPUT: {
          hook_event_name: "UserPromptSubmit",
          prompt:
            "<task-notification><task-id>review-1</task-id><summary>Review complete.</summary></task-notification>",
        },
      },
      script: `run_hook "$TEST_LAUNCH_PAYLOAD"
run_hook "$TEST_WAITING_PAYLOAD"
if [ -e "$ARCHESTRA_AGENT_RUNTIME_DIR/turn-complete" ]; then
  touch "$ARCHESTRA_AGENT_RUNTIME_DIR/premature-completion"
fi
run_hook "$TEST_UNRELATED_INPUT"
run_hook "$TEST_WAITING_PAYLOAD"
if [ -e "$ARCHESTRA_AGENT_RUNTIME_DIR/turn-complete" ]; then
  touch "$ARCHESTRA_AGENT_RUNTIME_DIR/premature-completion"
fi
run_hook "$TEST_RESULT_INPUT"
if [ -e "$ARCHESTRA_AGENT_RUNTIME_DIR/turn-complete" ]; then
  touch "$ARCHESTRA_AGENT_RUNTIME_DIR/premature-completion"
fi
run_hook '{"hook_event_name":"Stop","last_assistant_message":"I handled the completed review.","background_tasks":[],"session_crons":[]}'`,
      verify: async ({ runtime, result }) => {
        expect(result.code).toBe(0);
        expect(result.killed).not.toBe(true);
        await expect(
          readFile(path.join(runtime, "premature-completion")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(result.stdout).toContain("I handled the completed review.");
        expect(result.stdout).not.toContain(
          "The result has not reached me yet.",
        );
      },
    });
  });

  test("waits for a fresh answer after Claude acknowledges stopping a background task", async () => {
    await withClaudeHookSequence({
      payloads: {
        TEST_STOPPED_PAYLOAD: {
          hook_event_name: "PostToolUse",
          tool_name: "TaskStop",
          tool_response: {
            message: "Successfully stopped task: review-1",
            task_id: "review-1",
            task_type: "local_bash",
            command: "sleep 600",
          },
        },
      },
      script: `run_hook '{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_response":{"backgroundTaskId":"review-1"}}'
run_hook '{"hook_event_name":"Stop","last_assistant_message":"Review still pending.","background_tasks":[],"session_crons":[]}'
if [ -e "$ARCHESTRA_AGENT_RUNTIME_DIR/turn-complete" ]; then
  touch "$ARCHESTRA_AGENT_RUNTIME_DIR/premature-completion"
fi
run_hook "$TEST_STOPPED_PAYLOAD"
if [ -e "$ARCHESTRA_AGENT_RUNTIME_DIR/turn-complete" ]; then
  touch "$ARCHESTRA_AGENT_RUNTIME_DIR/premature-completion"
fi
run_hook '{"hook_event_name":"Stop","last_assistant_message":"I stopped the review as requested.","background_tasks":[],"session_crons":[]}'`,
      verify: async ({ runtime, result }) => {
        expect(result.code).toBe(0);
        expect(result.killed).not.toBe(true);
        await expect(
          readFile(path.join(runtime, "premature-completion")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(result.stdout).toContain("I stopped the review as requested.");
        expect(result.stdout).not.toContain("Review still pending.");
      },
    });
  });

  test.each([
    false,
    true,
  ])("waits for nested results and fresh parent reports (repeated report: %s)", async (repeat) => {
    await withClaudeHookSequence({
      payloads: {
        TEST_CHILD_LAUNCH: {
          hook_event_name: "PostToolUse",
          agent_id: "parent-agent",
          tool_name: repeat ? "Agent" : "Bash",
          tool_response: repeat
            ? { isAsync: true, agentId: "child-job" }
            : { backgroundTaskId: "child-job" },
        },
        TEST_REPORT: {
          hook_event_name: "UserPromptSubmit",
          prompt:
            "<task-notification><task-id>parent-agent</task-id></task-notification>",
        },
      },
      script: `child_transcript="$ARCHESTRA_AGENT_RUNTIME_DIR/child.jsonl"
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"launch-child-job"}]}}' > "$child_transcript"
child_stop() {
  run_hook "$(jq -n --arg file "$child_transcript" '{hook_event_name:"SubagentStop",agent_id:"parent-agent",agent_transcript_path:$file}')"
}
assert_pending() {
  run_hook '{"hook_event_name":"Stop","last_assistant_message":"An intermediate answer.","background_tasks":[],"session_crons":[]}'
  if [ -e "$ARCHESTRA_AGENT_RUNTIME_DIR/turn-complete" ]; then touch "$ARCHESTRA_AGENT_RUNTIME_DIR/premature-completion"; fi
}
run_hook '{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_response":{"isAsync":true,"agentId":"parent-agent"}}'
run_hook "$TEST_CHILD_LAUNCH"
child_stop
run_hook "$TEST_REPORT"
assert_pending
printf '%s\\n' '{"uuid":"report-1","type":"user","message":{"content":"<task-notification><task-id>child-job</task-id></task-notification>"}}' >> "$child_transcript"
child_stop
assert_pending
${
  repeat
    ? `run_hook "$TEST_REPORT"
: > "$ARCHESTRA_AGENT_RUNTIME_DIR/grandchild.jsonl"
run_hook "$(jq -n --arg file "$ARCHESTRA_AGENT_RUNTIME_DIR/grandchild.jsonl" '{hook_event_name:"SubagentStop",agent_id:"child-job",agent_transcript_path:$file}')"
child_stop
run_hook "$TEST_REPORT"
assert_pending
printf '%s\\n' '{"uuid":"report-2","type":"user","message":{"content":"<task-notification><task-id>child-job</task-id></task-notification>"}}' >> "$child_transcript"
child_stop
assert_pending`
    : ""
}
run_hook "$TEST_REPORT"
run_hook '{"hook_event_name":"Stop","last_assistant_message":"The parent handled the final nested result.","background_tasks":[],"session_crons":[]}'`,
      verify: async ({ runtime, result }) => {
        expect(result.code).toBe(0);
        await expect(
          readFile(path.join(runtime, "premature-completion")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(result.stdout).toContain(
          "The parent handled the final nested result.",
        );
        expect(result.stdout).not.toContain("An intermediate answer.");
      },
    });
  });

  test("ignores unrelated internal agents and cancels a stopped agent's descendants", async () => {
    await withClaudeHookSequence({
      payloads: {},
      script: `run_hook '{"hook_event_name":"SubagentStop","agent_id":"prompt-suggestion"}'
run_hook '{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_response":{"isAsync":true,"agentId":"parent-agent"}}'
run_hook '{"hook_event_name":"PostToolUse","agent_id":"parent-agent","tool_name":"Bash","tool_response":{"backgroundTaskId":"child-job"}}'
run_hook '{"hook_event_name":"PostToolUse","tool_name":"TaskStop","tool_response":{"task_id":"parent-agent"}}'
: > "$ARCHESTRA_AGENT_RUNTIME_DIR/child.jsonl"
run_hook "$(jq -n --arg file "$ARCHESTRA_AGENT_RUNTIME_DIR/child.jsonl" '{hook_event_name:"SubagentStop",agent_id:"parent-agent",agent_transcript_path:$file}')"
run_hook '{"hook_event_name":"Stop","last_assistant_message":"The delegated work was canceled.","background_tasks":[],"session_crons":[]}'`,
      verify: async ({ result }) => {
        expect(result.code).toBe(0);
        expect(result.killed).not.toBe(true);
        expect(result.stdout).toContain("The delegated work was canceled.");
      },
    });
  });

  test.each([
    "untracked",
    "canceled",
    "canceled owner",
  ])("waits for a resumed agent report (%s)", async (previousState) => {
    await withClaudeHookSequence({
      payloads: {},
      script: `${
        previousState === "canceled owner"
          ? `run_hook '{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_response":{"isAsync":true,"agentId":"owner-agent"}}'
run_hook '{"hook_event_name":"PostToolUse","agent_id":"owner-agent","tool_name":"Agent","tool_response":{"isAsync":true,"agentId":"resumed-agent"}}'
run_hook '{"hook_event_name":"PostToolUse","tool_name":"TaskStop","tool_response":{"task_id":"owner-agent"}}'`
          : previousState === "canceled"
            ? `run_hook '{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_response":{"isAsync":true,"agentId":"resumed-agent"}}'
run_hook '{"hook_event_name":"PostToolUse","tool_name":"TaskStop","tool_response":{"task_id":"resumed-agent"}}'`
            : ""
      }
run_hook '{"hook_event_name":"PostToolUse","tool_name":"SendMessage","tool_response":{"success":true,"resumedAgentId":"resumed-agent"}}'
: > "$ARCHESTRA_AGENT_RUNTIME_DIR/resumed.jsonl"
run_hook "$(jq -n --arg file "$ARCHESTRA_AGENT_RUNTIME_DIR/resumed.jsonl" '{hook_event_name:"SubagentStop",agent_id:"resumed-agent",agent_transcript_path:$file}')"
run_hook '{"hook_event_name":"Stop","last_assistant_message":"Waiting for the resumed agent.","background_tasks":[],"session_crons":[]}'
if [ -e "$ARCHESTRA_AGENT_RUNTIME_DIR/turn-complete" ]; then touch "$ARCHESTRA_AGENT_RUNTIME_DIR/premature-completion"; fi
run_hook '{"hook_event_name":"UserPromptSubmit","prompt":"<task-notification><task-id>resumed-agent</task-id></task-notification>"}'
run_hook '{"hook_event_name":"Stop","last_assistant_message":"I handled the resumed agent report.","background_tasks":[],"session_crons":[]}'`,
      verify: async ({ runtime, result }) => {
        expect(result.code).toBe(0);
        expect(result.killed).not.toBe(true);
        await expect(
          readFile(path.join(runtime, "premature-completion")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(result.stdout).toContain("I handled the resumed agent report.");
        expect(result.stdout).not.toContain("Waiting for the resumed agent.");
      },
    });
  });

  test("ignores historical nested reports after resuming an agent", async () => {
    await withClaudeHookSequence({
      payloads: {},
      script: `parent_transcript="$ARCHESTRA_AGENT_RUNTIME_DIR/parent.jsonl"
cat > "$parent_transcript" <<'TRANSCRIPT'
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"old-child-launch"}]}}
{"uuid":"old-report","type":"user","message":{"content":"<task-notification><task-id>child-agent</task-id></task-notification>"}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"new-child-resume"}]}}
TRANSCRIPT
run_hook '{"hook_event_name":"PostToolUse","tool_name":"SendMessage","tool_response":{"success":true,"resumedAgentId":"parent-agent"}}'
run_hook '{"hook_event_name":"PostToolUse","agent_id":"parent-agent","tool_name":"SendMessage","tool_use_id":"new-child-resume","tool_response":{"success":true,"resumedAgentId":"child-agent"}}'
parent_stop() {
  run_hook "$(jq -n --arg file "$parent_transcript" '{hook_event_name:"SubagentStop",agent_id:"parent-agent",agent_transcript_path:$file}')"
}
parent_stop
run_hook '{"hook_event_name":"UserPromptSubmit","prompt":"<task-notification><task-id>parent-agent</task-id></task-notification>"}'
run_hook '{"hook_event_name":"Stop","last_assistant_message":"Waiting for the new child report.","background_tasks":[],"session_crons":[]}'
if [ -e "$ARCHESTRA_AGENT_RUNTIME_DIR/turn-complete" ]; then touch "$ARCHESTRA_AGENT_RUNTIME_DIR/premature-completion"; fi
printf '%s\\n' '{"uuid":"new-report","type":"user","message":{"content":"<task-notification><task-id>child-agent</task-id></task-notification>"}}' >> "$parent_transcript"
parent_stop
run_hook '{"hook_event_name":"UserPromptSubmit","prompt":"<task-notification><task-id>parent-agent</task-id></task-notification>"}'
run_hook '{"hook_event_name":"Stop","last_assistant_message":"The new child report was handled.","background_tasks":[],"session_crons":[]}'`,
      verify: async ({ runtime, result }) => {
        expect(result.code).toBe(0);
        expect(result.killed).not.toBe(true);
        await expect(
          readFile(path.join(runtime, "premature-completion")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(result.stdout).toContain("The new child report was handled.");
        expect(result.stdout).not.toContain(
          "Waiting for the new child report.",
        );
      },
    });
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

async function withClaudeHookSequence(params: {
  mode?: "one_shot" | "interactive";
  initialFiles?: string[];
  payloads: Record<string, unknown>;
  script: string;
  verify: (fixture: {
    runtime: string;
    result: {
      code: number | string;
      killed: boolean;
      stdout: string;
      stderr: string;
    };
  }) => Promise<void>;
}): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "claude-hook-sequence-"));
  try {
    const entrypoint = await makeFastImageEntrypoint(
      root,
      "archestra-claude-code",
    );
    const bin = path.join(root, "bin");
    const runtime = path.join(root, "runtime");
    await Promise.all([mkdir(bin), mkdir(runtime)]);
    await Promise.all(
      (params.initialFiles ?? []).map((file) =>
        writeFile(path.join(runtime, file), ""),
      ),
    );
    await writeExecutable(
      path.join(bin, "archestra-agent-attention"),
      `#!/bin/sh
printf '%s\n' "$*" >> "$ARCHESTRA_AGENT_RUNTIME_DIR/attention"
`,
    );
    await writeExecutable(
      path.join(bin, "claude"),
      `#!/bin/sh
previous=""
for argument in "$@"; do
  if [ "$previous" = "--settings" ]; then settings="$argument"; fi
  previous="$argument"
done
session_hook="$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$settings")"
stop_hook="$(jq -r '.hooks.Stop[0].hooks[0].command' "$settings")"
failure_hook="$(jq -r '.hooks.StopFailure[0].hooks[0].command' "$settings")"
attention_hook="$(jq -r '.hooks.Notification[0].hooks[0].command' "$settings")"
run_hook() {
  payload="$(printf '%s' "$1" | jq -c '. + {tool_use_id:(.tool_use_id // ("launch-" + (.tool_response.backgroundTaskId // .tool_response.agentId // .tool_response.resumedAgentId // "")))}')"
  event="$(printf '%s' "$payload" | jq -r '.hook_event_name')"
  jq -r --arg event "$event" '.hooks[$event][]?.hooks[]?.command' "$settings" |
    while IFS= read -r command; do printf '%s' "$payload" | "$command"; done
}
${params.script}
if [ "$ARCHESTRA_AGENT_RUNTIME_MODE" = "interactive" ]; then exit 0; fi
trap 'exit 0' TERM
while :; do sleep 0.1; done
`,
    );
    const result = await execFileAsync("bash", [entrypoint], {
      cwd: root,
      timeout: 15000,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
        ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX: path.join(runtime, "test-turn"),
        ARCHESTRA_AGENT_RUNTIME_MODE: params.mode ?? "one_shot",
        ARCHESTRA_LLM_PROXY_PROTOCOL: "anthropic",
        ARCHESTRA_AGENT_RUNTIME_TASK: "Example task",
        ARCHESTRA_AGENT_RUNTIME_TASK_ID: "test-task",
        ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "test-model",
        ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/example",
        ARCHESTRA_MCP_GATEWAY_TOKEN: "example-gateway-token",
        ...Object.fromEntries(
          Object.entries(params.payloads).map(([key, value]) => [
            key,
            JSON.stringify(value),
          ]),
        ),
      },
    })
      .then((output) => ({ ...output, code: 0, killed: false }))
      .catch((failure) => failure);
    await params.verify({ runtime, result });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeExecutable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, "utf8");
  await chmod(file, 0o755);
}
