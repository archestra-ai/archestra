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
