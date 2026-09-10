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
  ] as const)("configures and starts %s run through the native session protocol", async (mode) => {
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
      // The native session bridge is the subprocess boundary; provider protocol
      // behavior is exercised by the runtime package and image integration tests.
      await writeExecutable(
        path.join(bin, "archestra-agent-session"),
        `#!/bin/sh
printf '%s\n' "$@" > "$ARCHESTRA_AGENT_RUNTIME_DIR/captured-args"
env > "$ARCHESTRA_AGENT_RUNTIME_DIR/captured-env"
`,
      );

      await execFileAsync("bash", [ENTRYPOINT], {
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
      expect(args.slice(0, 2)).toEqual(["claude-code", "claude"]);
      expect(args).toContain("--print");
      expect(args).toContain("stream-json");
      const settings = JSON.parse(
        await readFile(path.join(runtime, "claude-settings.json"), "utf8"),
      );
      expect(settings.hooks.Stop[0].hooks[0].command).toBe(
        path.join(runtime, "transcript-hook.sh"),
      );

      // The native transcript is flushed asynchronously. A Stop payload must
      // preserve its final response even when the JSONL ends at a tool result.
      const laggingTranscript = path.join(runtime, "lagging.jsonl");
      const finalText = "Final response from hook payload.";
      for (const flushed of [false, true]) {
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
                transcript_path: laggingTranscript,
                last_assistant_message: finalText,
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
