import { describe, expect, test } from "vitest";
import {
  AGENT_TOOL_PREFIX,
  isAgentTool,
  makeSwapAgentPokeText,
  SWAP_AGENT_POKE_PREFIX,
} from "./agents";
import { TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME } from "./archestra-mcp-server";

describe("agent tool helpers", () => {
  test("identifies delegation tools by prefix", () => {
    expect(isAgentTool(`${AGENT_TOOL_PREFIX}delegate_to_researcher`)).toBe(
      true,
    );
    expect(isAgentTool("archestra__swap_agent")).toBe(false);
  });

  test("builds swap poke text using the shared swap-to-default tool name", () => {
    const text = makeSwapAgentPokeText("Research Agent");
    expect(text.startsWith(`${SWAP_AGENT_POKE_PREFIX}Research Agent`)).toBe(
      true,
    );
    expect(text).toContain(TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME);
  });
});
