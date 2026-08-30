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
  "../../../../agent_images/bin/archestra-openclaw",
);

describe("OpenClaw image entrypoint", () => {
  test.each([
    ["openai_chat", "openai-completions"],
    ["openai_responses", "openai-responses"],
  ])("configures the %s transport as %s", async (protocol, expectedApi) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-openclaw-"));
    try {
      const bin = path.join(root, "bin");
      const runtime = path.join(root, "runtime");
      const workspace = path.join(root, "workspace");
      await Promise.all([
        mkdir(bin, { recursive: true }),
        mkdir(workspace, { recursive: true }),
      ]);
      await writeExecutable(
        path.join(bin, "openclaw"),
        `#!/bin/sh
cp "$PWD/SOUL.md" "$ARCHESTRA_AGENT_BACKGROUND_EXECUTION_RUNTIME_DIR/captured-soul.md"
printf 'OpenClaw test response\\n'
`,
      );

      await execFileAsync("bash", [ENTRYPOINT], {
        cwd: workspace,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ARCHESTRA_LLM_PROXY_PROTOCOL: protocol,
          ARCHESTRA_AGENT_BACKGROUND_EXECUTION_RUNTIME_DIR: runtime,
          ARCHESTRA_AGENT_BACKGROUND_EXECUTION_NATIVE_MODEL: "test-model",
          ARCHESTRA_AGENT_BACKGROUND_EXECUTION_TASK_ID:
            "12345678-abcd-4000-8000-123456789abc",
          ARCHESTRA_AGENT_BACKGROUND_EXECUTION_TASK: "Run the task.",
          ARCHESTRA_AGENT_BACKGROUND_EXECUTION_SYSTEM_PROMPT:
            "Follow the configured Agent instructions.",
          ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MODE: "one_shot",
          ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/test",
          ARCHESTRA_MCP_GATEWAY_TOKEN: "test-token",
          OPENAI_API_KEY: "test-key",
          OPENAI_BASE_URL: "http://localhost:9000/v1/model-router/test",
        },
      });

      const config = JSON.parse(
        await readFile(path.join(runtime, "openclaw.json"), "utf8"),
      );
      expect(config.models.providers.archestra.api).toBe(expectedApi);
      expect(config.logging).toEqual({
        level: "error",
        consoleLevel: "silent",
      });
      expect(config.agents.defaults.skipBootstrap).toBe(true);
      expect(
        await readFile(path.join(runtime, "captured-soul.md"), "utf8"),
      ).toContain("Follow the configured Agent instructions.");
      await expect(
        readFile(path.join(workspace, "SOUL.md"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeExecutable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, "utf8");
  await chmod(file, 0o755);
}
