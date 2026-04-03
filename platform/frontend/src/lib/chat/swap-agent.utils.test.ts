import { describe, expect, test } from "vitest";
import {
  extractSwapTargetAgentName,
  getRenderedToolName,
  getSwapToolShortName,
  hasSwapToolErrorInPart,
} from "./swap-agent.utils";

describe("swap-agent utils", () => {
  test("extracts the target agent name from tool input", () => {
    expect(
      extractSwapTargetAgentName({
        type: "tool-archestra__swap_agent",
        input: { agent_name: "Drawing agent" },
      }),
    ).toBe("Drawing agent");
  });

  test("recognizes branded swap tool names", () => {
    expect(getSwapToolShortName({ toolName: "sparky__swap_agent" })).toBe(
      "swap_agent",
    );
    expect(
      getSwapToolShortName({ toolName: "sparky__swap_to_default_agent" }),
    ).toBe("swap_to_default_agent");
  });

  test("extracts a rendered tool name from a tool part type", () => {
    expect(getRenderedToolName({ type: "tool-archestra__swap_agent" })).toBe(
      "archestra__swap_agent",
    );
  });

  test("treats structured MCP errors as swap tool failures", () => {
    expect(
      hasSwapToolErrorInPart({
        type: "tool-archestra__swap_agent",
        output: {
          type: "generic",
          message: "Failed to swap agent",
        },
      }),
    ).toBe(true);
  });
});
