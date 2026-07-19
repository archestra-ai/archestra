import { describe, expect, test } from "vitest";
import { AGENT_TOOL_PREFIX, isAgentTool } from "./agents";

describe("agent tool helpers", () => {
  test("identifies delegation tools by prefix", () => {
    expect(isAgentTool(`${AGENT_TOOL_PREFIX}delegate_to_researcher`)).toBe(
      true,
    );
    expect(isAgentTool("archestra__todo_write")).toBe(false);
  });
});
