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
    ["one_shot", ["--auto", "--model"]],
    ["interactive", ["--auto", "--model"]],
  ] as const)("configures and starts %s run", async (mode, prefix) => {
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
printf '%s\n' "$@" > "$ARCHESTRA_AGENT_RUNTIME_DIR/captured-args"
env > "$ARCHESTRA_AGENT_RUNTIME_DIR/captured-env"
if [ "$ARCHESTRA_AGENT_RUNTIME_MODE" = "one_shot" ]; then
  plugin_path="$(jq -r '.plugin[] | select(contains("opencode-completion")) | sub("^file://"; "")' "$OPENCODE_CONFIG")"
  PLUGIN_PATH="$plugin_path" node --input-type=module <<'JS'
const plugin = await import("file://" + process.env.PLUGIN_PATH);
const { access } = await import("node:fs/promises");
const hooks = await plugin.ArchestraCompletion({
  client: {
    session: {
      get: async ({ path }) => ({
        data: path.id === "subagent-session" ? { id: path.id, parentID: "session-1" } : { id: path.id },
      }),
      messages: async () => ({
        data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "OpenCode finished the task." }] }],
      }),
    },
  },
  directory: process.cwd(),
});
await hooks.event({ event: { type: "session.idle", properties: { sessionID: "subagent-session" } } });
try {
  await access(process.env.ARCHESTRA_AGENT_RUNTIME_DIR + "/turn-complete");
  throw new Error("subagent completion settled the run");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
JS
  trap 'exit 0' TERM
  while :; do sleep 1; done
fi
`,
      );

      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ARCHESTRA_LLM_PROXY_PROTOCOL: "openai_responses",
        ARCHESTRA_AGENT_RUNTIME_DIR: runtime,
        ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "test-model",
        ARCHESTRA_AGENT_RUNTIME_MODEL_CONTEXT_LENGTH: "200000",
        ARCHESTRA_AGENT_RUNTIME_MODEL_OUTPUT_LENGTH: "32000",
        ARCHESTRA_AGENT_RUNTIME_TASK_ID: "12345678-abcd-4000-8000-123456789abc",
        ARCHESTRA_AGENT_RUNTIME_TASK: "Run the task.",
        ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT:
          "Follow the configured Agent instructions.",
        ARCHESTRA_AGENT_RUNTIME_MODE: mode,
        ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/test",
        ARCHESTRA_MCP_GATEWAY_TOKEN: "test-token",
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "http://localhost:9000/v1/model-router/test",
      };
      const result = await execFileAsync("bash", [ENTRYPOINT], {
        cwd: workspace,
        env,
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
                "X-Archestra-Run-Id": "12345678-abcd-4000-8000-123456789abc",
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
              "X-Archestra-Run-Id": "12345678-abcd-4000-8000-123456789abc",
              "X-Archestra-Session-Id": "12345678-abcd-4000-8000-123456789abc",
            },
          },
        },
      });
      if (mode === "one_shot") {
        expect(config.plugin).toEqual([
          path.join(runtime, "opencode-attention.js"),
          `file://${runtime}/opencode-completion.js`,
        ]);
        expect(result.stdout).toContain("===ARCHESTRA-FINAL-ANSWER===");
        expect(result.stdout).toContain("OpenCode finished the task.");
      } else {
        expect(config.plugin).toEqual([
          path.join(runtime, "opencode-attention.js"),
        ]);
      }
      expect(
        await readFile(path.join(runtime, "opencode-instructions.md"), "utf8"),
      ).toBe("Follow the configured Agent instructions.\n");

      const args = (await readFile(path.join(runtime, "captured-args"), "utf8"))
        .trim()
        .split("\n");
      expect(args.slice(0, prefix.length)).toEqual(prefix);
      expect(args).not.toContain("--pure");
      expect(args).toContain("archestra/test-model");
      expect(args.at(-1)).toBe("Run the task.");

      const capturedEnv = await readFile(
        path.join(runtime, "captured-env"),
        "utf8",
      );
      expect(capturedEnv).toContain("OPENCODE_DISABLE_PROJECT_CONFIG=1");
      expect(capturedEnv).toContain(`OPENCODE_CONFIG=${runtime}/opencode.json`);
      expect(capturedEnv).not.toContain("OPENCODE_PURE=");

      if (mode === "interactive") {
        const attentionCommand = path.join(bin, "attention");
        await writeExecutable(
          attentionCommand,
          `#!/bin/sh
printf '%s\n' "$*" >> "$ARCHESTRA_AGENT_RUNTIME_DIR/attention-calls"
`,
        );
        await execFileAsync(
          "node",
          [
            "-e",
            `const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
globalThis.Bun = {
  spawn(argv) {
    execFileSync(argv[0], argv.slice(1), { env: process.env, stdio: "ignore" });
    return { exited: Promise.resolve(0) };
  },
};
(async () => {
  const mod = await import(pathToFileURL(process.argv[1]).href);
  const plugin = Object.values(mod).find((value) => typeof value === "function");
  const hooks = await plugin();
  const send = (event) => hooks.event({ event });
  await send({ type: "session.status", properties: { sessionID: "main", status: { type: "busy" } } });
  await send({ type: "question.asked", properties: { sessionID: "main" } });
  await send({ type: "question.replied", properties: { sessionID: "main" } });
  await send({ type: "permission.asked", properties: { sessionID: "main" } });
  await send({ type: "permission.replied", properties: { sessionID: "main" } });
  await send({ type: "session.status", properties: { sessionID: "main", status: { type: "idle" } } });
})();`,
            config.plugin[0],
          ],
          {
            env: {
              ...env,
              ARCHESTRA_AGENT_ATTENTION_COMMAND: attentionCommand,
            },
          },
        );
        expect(
          await readFile(path.join(runtime, "attention-calls"), "utf8"),
        ).toBe(
          "clear\nset Input requested\nclear\nset Permission needed\nclear\nset Waiting for input\n",
        );
      }
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
