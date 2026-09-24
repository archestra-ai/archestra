import { describe, expect, test } from "vitest";
import {
  openAppaTargetChatTitle,
  openAppaTargetInitialPrompt,
  openAppaTargetSuggestedPrompts,
} from "./built-in-agents";

describe("openAppaTargetChatTitle", () => {
  test("names the policy target", () => {
    expect(openAppaTargetChatTitle("GitHub")).toBe(
      "What should the policy do for GitHub?",
    );
  });
});

describe("openAppaTargetInitialPrompt", () => {
  test.each([
    ["agent", "Research assistant", 'the agent "Research assistant"'],
    ["mcp_gateway", "Prod gateway", 'the MCP gateway "Prod gateway"'],
    ["mcp_server", "GitHub", 'the MCP server "GitHub"'],
  ] as const)("scopes the prompt to %s %s", (kind, name, phrase) => {
    expect(openAppaTargetInitialPrompt(kind, name)).toContain(phrase);
  });
});

describe("openAppaTargetSuggestedPrompts", () => {
  test("returns three prompts that all name the target", () => {
    const prompts = openAppaTargetSuggestedPrompts("mcp_server", "GitHub");
    expect(prompts).toHaveLength(3);
    for (const { summaryTitle, prompt } of prompts) {
      expect(summaryTitle).toContain("GitHub");
      expect(prompt).toContain('the MCP server "GitHub"');
    }
  });
});
