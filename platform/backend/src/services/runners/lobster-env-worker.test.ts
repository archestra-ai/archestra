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
const BIN_DIR = path.resolve(
  import.meta.dirname,
  "../../../../agent_images/bin",
);

describe("Lobster Env worker bootstrap", () => {
  test("prepares the private-mirror branch and hands the combined task contract to the selected client", async () => {
    const fixture = await makeFixture();
    try {
      await execFileAsync(
        "bash",
        [path.join(BIN_DIR, "archestra-lobster-worker")],
        {
          env: {
            ...process.env,
            HOME: fixture.home,
            PATH: `${fixture.bin}:${process.env.PATH}`,
            LOBSTER_TEST_GIT_LOG: fixture.gitLog,
            LOBSTER_TEST_OUTPUT_DIR: fixture.output,
            ARCHESTRA_AGENT_BACKGROUND_EXECUTION_RUNTIME_DIR: fixture.runtime,
            ARCHESTRA_LOBSTER_ENV_CLIENT: "archestra-hermes",
            ARCHESTRA_LOBSTER_ENV_REPOSITORY_DIR: fixture.repository,
            ARCHESTRA_LOBSTER_ENV_SYSTEM_PROMPT_FILE: fixture.prompt,
            ARCHESTRA_AGENT_BACKGROUND_EXECUTION_TASK_ID:
              "12345678-abcd-4000-8000-123456789abc",
            ARCHESTRA_AGENT_BACKGROUND_EXECUTION_SYSTEM_PROMPT:
              "Operator-specific constraints.",
          },
        },
      );

      expect(await readFile(path.join(fixture.output, "client"), "utf8")).toBe(
        "archestra-hermes",
      );
      expect(await readFile(path.join(fixture.output, "cwd"), "utf8")).toBe(
        path.join(fixture.repository, "platform"),
      );
      expect(
        await readFile(path.join(fixture.output, "system-prompt"), "utf8"),
      ).toBe("Baked worker contract.\n\nOperator-specific constraints.");

      const gitLog = await readFile(fixture.gitLog, "utf8");
      expect(gitLog).toContain("fetch --quiet origin main");
      expect(gitLog).toContain("fetch --quiet --filter=blob:none private main");
      expect(gitLog).toContain(
        "checkout --quiet -B agent/lobster-12345678 origin/main",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test.each([
    ["archestra-lobster-env", "archestra-codex"],
    ["archestra-lobster-claude-code", "archestra-claude-code"],
    ["archestra-lobster-hermes", "archestra-hermes"],
    ["archestra-lobster-openclaw", "archestra-openclaw"],
  ])("%s dispatches to %s", async (entrypoint, expectedClient) => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-lobster-entry-"));
    try {
      const bin = path.join(root, "bin");
      const output = path.join(root, "selected-client");
      await mkdir(bin);
      await writeExecutable(
        path.join(bin, "archestra-lobster-worker"),
        `#!/bin/sh\nprintf '%s' "$ARCHESTRA_LOBSTER_ENV_CLIENT" > "$LOBSTER_TEST_SELECTED_CLIENT"\n`,
      );

      await execFileAsync("bash", [path.join(BIN_DIR, entrypoint)], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          LOBSTER_TEST_SELECTED_CLIENT: output,
        },
      });

      expect(await readFile(output, "utf8")).toBe(expectedClient);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses a blob-filtered main-branch clone in a fresh task pod", async () => {
    const fixture = await makeFixture({ existingRepository: false });
    try {
      await execFileAsync(
        "bash",
        [path.join(BIN_DIR, "archestra-lobster-worker")],
        {
          env: {
            ...process.env,
            HOME: fixture.home,
            PATH: `${fixture.bin}:${process.env.PATH}`,
            LOBSTER_TEST_GIT_LOG: fixture.gitLog,
            LOBSTER_TEST_OUTPUT_DIR: fixture.output,
            ARCHESTRA_AGENT_BACKGROUND_EXECUTION_RUNTIME_DIR: fixture.runtime,
            ARCHESTRA_LOBSTER_ENV_CLIENT: "archestra-hermes",
            ARCHESTRA_LOBSTER_ENV_REPOSITORY_DIR: fixture.repository,
            ARCHESTRA_LOBSTER_ENV_SYSTEM_PROMPT_FILE: fixture.prompt,
            ARCHESTRA_AGENT_BACKGROUND_EXECUTION_TASK_ID:
              "12345678-abcd-4000-8000-123456789abc",
          },
        },
      );

      const gitLog = await readFile(fixture.gitLog, "utf8");
      expect(gitLog).toContain(
        `clone --quiet --filter=blob:none --single-branch --branch main --origin origin https://github.com/archestra-ai/archestra.git ${fixture.repository}`,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("refuses an unknown native client before touching the repository", async () => {
    const fixture = await makeFixture();
    try {
      await expect(
        execFileAsync(
          "bash",
          [path.join(BIN_DIR, "archestra-lobster-worker")],
          {
            env: {
              ...process.env,
              HOME: fixture.home,
              PATH: `${fixture.bin}:${process.env.PATH}`,
              LOBSTER_TEST_GIT_LOG: fixture.gitLog,
              LOBSTER_TEST_OUTPUT_DIR: fixture.output,
              ARCHESTRA_AGENT_BACKGROUND_EXECUTION_RUNTIME_DIR: fixture.runtime,
              ARCHESTRA_LOBSTER_ENV_CLIENT: "arbitrary-command",
              ARCHESTRA_LOBSTER_ENV_REPOSITORY_DIR: fixture.repository,
              ARCHESTRA_LOBSTER_ENV_SYSTEM_PROMPT_FILE: fixture.prompt,
              ARCHESTRA_AGENT_BACKGROUND_EXECUTION_TASK_ID:
                "12345678-abcd-4000-8000-123456789abc",
            },
          },
        ),
      ).rejects.toMatchObject({
        code: 78,
        stderr: expect.stringContaining("unsupported Lobster Env client"),
      });
      await expect(readFile(fixture.gitLog, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test.each([
    ["openai_chat", "openai-completions"],
    ["openai_responses", "openai-responses"],
  ])("configures OpenClaw's %s transport as %s", async (protocol, expectedApi) => {
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

      await execFileAsync("bash", [path.join(BIN_DIR, "archestra-openclaw")], {
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
            "Follow the Lobster worker contract.",
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
      expect(config.logging.level).toBe("error");
      expect(config.logging.consoleLevel).toBe("silent");
      expect(config.agents.defaults.skipBootstrap).toBe(true);
      expect(
        await readFile(path.join(runtime, "captured-soul.md"), "utf8"),
      ).toContain("Follow the Lobster worker contract.");
      await expect(
        readFile(path.join(workspace, "SOUL.md"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function makeFixture(
  params: { existingRepository?: boolean } = {},
): Promise<{
  root: string;
  home: string;
  bin: string;
  repository: string;
  runtime: string;
  prompt: string;
  gitLog: string;
  output: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "archestra-lobster-worker-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const repository = path.join(root, "repository");
  const runtime = path.join(root, "runtime");
  const prompt = path.join(root, "system-prompt.md");
  const gitLog = path.join(root, "git.log");
  const output = path.join(root, "output");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(output, { recursive: true }),
    mkdir(runtime, { recursive: true }),
    writeFile(prompt, "Baked worker contract.", "utf8"),
  ]);
  if (params.existingRepository !== false) {
    await Promise.all([
      mkdir(path.join(repository, ".git"), { recursive: true }),
      mkdir(path.join(repository, "platform"), { recursive: true }),
    ]);
  }

  await writeExecutable(path.join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  await writeExecutable(
    path.join(bin, "git"),
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$LOBSTER_TEST_GIT_LOG"
case "$*" in
  clone*)
    destination="\${!#}"
    mkdir -p "$destination/.git" "$destination/platform"
    ;;
  *"remote get-url private"* | *"ls-remote --exit-code --heads private"*) exit 1 ;;
esac
exit 0
`,
  );
  await writeExecutable(
    path.join(bin, "archestra-hermes"),
    `#!/bin/sh
printf '%s' "$ARCHESTRA_LOBSTER_ENV_CLIENT" > "$LOBSTER_TEST_OUTPUT_DIR/client"
pwd | tr -d '\n' > "$LOBSTER_TEST_OUTPUT_DIR/cwd"
printf '%s' "$ARCHESTRA_AGENT_BACKGROUND_EXECUTION_SYSTEM_PROMPT" > "$LOBSTER_TEST_OUTPUT_DIR/system-prompt"
`,
  );

  return { root, home, bin, repository, runtime, prompt, gitLog, output };
}

async function writeExecutable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, "utf8");
  await chmod(file, 0o755);
}
