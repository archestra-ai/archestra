import {
  CLAUDE_CODE_GUARD_MARKER_START,
  CLAUDE_CODE_GUARD_SCRIPT_RELPATH,
} from "@archestra/shared";
import { describe, expect, it } from "vitest";
import { getDisconnectSteps } from "./disconnect";

describe("getDisconnectSteps", () => {
  it("gives Claude Code the local mcp-remove command plus the settings.json revert", () => {
    const steps = getDisconnectSteps("claude-code", {
      serverName: "my_gateway",
      appName: "Archestra",
    });
    expect(steps[0].command).toBe("claude mcp remove my_gateway");
    expect(
      steps.some((step) => step.body?.includes("ANTHROPIC_BASE_URL")),
    ).toBe(true);
  });

  it("gives Claude Code a one-liner that removes the startup guard and its profile hook", () => {
    const steps = getDisconnectSteps("claude-code", {
      serverName: "my_gateway",
      appName: "Archestra",
    });
    const guardStep = steps.find((step) =>
      step.title.includes("startup guard"),
    );
    expect(guardStep?.command).toContain(CLAUDE_CODE_GUARD_MARKER_START);
    expect(guardStep?.command).toContain(
      `rm -f ~/${CLAUDE_CODE_GUARD_SCRIPT_RELPATH}`,
    );
  });

  it("gives every CLI client an mcp-remove command scoped to the server name", () => {
    const cases: Array<[string, string]> = [
      ["codex", "codex mcp remove my_gateway"],
      ["copilot-cli", "copilot mcp remove my_gateway"],
    ];
    for (const [clientId, command] of cases) {
      const steps = getDisconnectSteps(clientId, {
        serverName: "my_gateway",
        appName: "Archestra",
      });
      expect(steps.some((step) => step.command === command)).toBe(true);
    }
  });

  it("always returns at least one step, even for an unknown client", () => {
    const steps = getDisconnectSteps("something-else", {
      serverName: "gw",
      appName: "Archestra",
    });
    expect(steps.length).toBeGreaterThan(0);
  });
});
