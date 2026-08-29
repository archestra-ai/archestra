import { describe, expect, it } from "vitest";
import { loadLocalWorkspaceTools } from "./local-tools.js";

describe("local workspace tools", () => {
  it("runs a command in the execution workspace and returns its status", async () => {
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
