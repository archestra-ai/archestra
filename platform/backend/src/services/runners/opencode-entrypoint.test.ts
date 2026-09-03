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
  "../../../../agent_images/bin/archestra-opencode",
);

describe("OpenCode image entrypoint", () => {
  test.each([
    ["one_shot", ["run", "--pure", "--auto"]],
    ["interactive", ["--pure", "--auto"]],
  ] as const)("configures and starts %s execution", async (mode, prefix) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-opencode-"));
    try {
      const bin = path.join(root, "bin");
      const runtime = path.join(root, "runtime");
      const workspace = path.join(root, "workspace");
      await Promise.all([
        mkdir(bin, { recursive: true }),
        mkdir(workspace, { recursive: true }),
      ]);
      await writeExecutable(
        path.join(bin, "opencode"),
        `#!/bin/sh
printf '%s\n' "$@" > "$ARCHESTRA_AGENT_BACKGROUND_EXECUTION_RUNTIME_DIR/captured-args"
env > "$ARCHESTRA_AGENT_BACKGROUND_EXECUTION_RUNTIME_DIR/captured-env"
`,
      );

      await execFileAsync("bash", [ENTRYPOINT], {
        cwd: workspace,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ARCHESTRA_LLM_PROXY_PROTOCOL: "openai_responses",
          ARCHESTRA_AGENT_BACKGROUND_EXECUTION_RUNTIME_DIR: runtime,
          ARCHESTRA_AGENT_BACKGROUND_EXECUTION_NATIVE_MODEL: "test-model",
          ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MODEL_CONTEXT_LENGTH: "200000",
          ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MODEL_OUTPUT_LENGTH: "32000",
          ARCHESTRA_AGENT_BACKGROUND_EXECUTION_TASK_ID:
            "12345678-abcd-4000-8000-123456789abc",
          ARCHESTRA_AGENT_BACKGROUND_EXECUTION_TASK: "Run the task.",
          ARCHESTRA_AGENT_BACKGROUND_EXECUTION_SYSTEM_PROMPT:
            "Follow the configured Agent instructions.",
          ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MODE: mode,
          ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/test",
          ARCHESTRA_MCP_GATEWAY_TOKEN: "test-token",
          OPENAI_API_KEY: "test-key",
          OPENAI_BASE_URL: "http://localhost:9000/v1/model-router/test",
        },
      });

      const config = JSON.parse(
        await readFile(path.join(runtime, "opencode.json"), "utf8"),
      );
      expect(config).toMatchObject({
        model: "archestra/test-model",
        permission: "allow",
        provider: {
          archestra: {
            npm: "@ai-sdk/openai",
            options: {
              baseURL: "http://localhost:9000/v1/model-router/test",
              apiKey: "{env:OPENAI_API_KEY}",
              headers: {
                "X-Archestra-Execution-Id":
                  "12345678-abcd-4000-8000-123456789abc",
                "X-Archestra-Session-Id":
                  "12345678-abcd-4000-8000-123456789abc",
              },
            },
            models: {
              "test-model": {
                tool_call: true,
                limit: { context: 200000, output: 32000 },
              },
            },
          },
        },
        mcp: {
          archestra: {
            type: "remote",
            url: "http://localhost:9000/v1/mcp/test",
            oauth: false,
            headers: {
              Authorization: "Bearer test-token",
              "X-Archestra-Execution-Id":
                "12345678-abcd-4000-8000-123456789abc",
              "X-Archestra-Session-Id": "12345678-abcd-4000-8000-123456789abc",
            },
          },
        },
      });
      expect(
        await readFile(path.join(runtime, "opencode-instructions.md"), "utf8"),
      ).toBe("Follow the configured Agent instructions.\n");

      const args = (await readFile(path.join(runtime, "captured-args"), "utf8"))
        .trim()
        .split("\n");
      expect(args.slice(0, prefix.length)).toEqual(prefix);
      expect(args).toContain("archestra/test-model");
      expect(args.at(-1)).toBe("Run the task.");

      const capturedEnv = await readFile(
        path.join(runtime, "captured-env"),
        "utf8",
      );
      expect(capturedEnv).toContain("OPENCODE_DISABLE_PROJECT_CONFIG=1");
      expect(capturedEnv).toContain(`OPENCODE_CONFIG=${runtime}/opencode.json`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a non-Responses protocol before starting OpenCode", async () => {
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
