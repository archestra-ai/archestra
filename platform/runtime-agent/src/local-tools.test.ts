import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadLocalWorkspaceTools } from "./local-tools.js";

describe("local workspace tools", () => {
  it("runs a command in the run workspace and returns its status", async () => {
    const command = loadLocalWorkspaceTools().archestra_workspace__run_command;
    if (!command?.execute)
      throw new Error("run command tool is not executable");

    const result = await command.execute(
      { command: "pwd && printf workspace-ready" },
      {
        toolCallId: "test",
        messages: [],
        abortSignal: undefined,
      },
    );

    expect(result).toContain("Command exited with code 0.");
    expect(result).toContain(process.cwd());
    expect(result).toContain("workspace-ready");
  });

  it("returns command failures to the model", async () => {
    const command = loadLocalWorkspaceTools().archestra_workspace__run_command;
    if (!command?.execute)
      throw new Error("run command tool is not executable");

    const result = await command.execute(
      { command: "printf failed >&2; exit 7" },
      {
        toolCallId: "test",
        messages: [],
        abortSignal: undefined,
      },
    );

    expect(result).toBe("Command exited with code 7.\nfailed");
  });
});

describe("renewable command credentials", () => {
  it("rereads rotated tokens without restarting the agent and refuses expired values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runtime-credentials-"));
    const file = join(directory, "current.json");
    const taskId = "credential-test-task";
    const tool = loadLocalWorkspaceTools().archestra_workspace__run_command;
    if (!tool?.execute) throw new Error("missing tool");
    vi.stubEnv("ARCHESTRA_AGENT_RUNTIME_CREDENTIALS_FILE", file);
    vi.stubEnv("ARCHESTRA_AGENT_RUNTIME_TASK_ID", taskId);
    vi.stubEnv("GITHUB_TOKEN", "stale-startup-token");
    const run = tool.execute;
    const execute = (command: string) =>
      run({ command }, { toolCallId: "test", messages: [] });
    const publish = (value: string, expiresAt = Date.now() + 60_000) =>
      writeFile(
        file,
        JSON.stringify({
          taskId,
          credentials: { GITHUB_TOKEN: { value, expiresAt } },
        }),
      );
    try {
      await publish("first-token");
      expect(
        await execute(
          'test "$GITHUB_TOKEN" = first-token && test "$GH_TOKEN" = first-token && printf matched',
        ),
      ).toContain("matched");
      await publish("second-token");
      expect(
        await execute(
          'test "$GITHUB_TOKEN" = second-token && test "$GH_TOKEN" = second-token && printf rotated',
        ),
      ).toContain("rotated");
      await publish("expired-token", Date.now() - 1);
      expect(await execute("printf should-not-run")).toBe(
        "Command could not start: renewable credentials are unavailable or expired. Retry after credential refresh.",
      );
      await writeFile(
        file,
        JSON.stringify({ taskId: "another-task", credentials: {} }),
      );
      expect(await execute("printf should-not-run")).not.toContain(
        "should-not-run",
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
