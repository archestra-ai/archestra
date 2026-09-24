import { describe, expect, test } from "vitest";
import {
  openAppaTargetChatSubtitle,
  openAppaTargetChatTitle,
  openAppaTargetScopeContext,
  openAppaTargetSuggestedPrompts,
} from "./built-in-agents";

describe("openAppaTargetChatTitle", () => {
  test("names the policy target", () => {
    expect(openAppaTargetChatTitle("GitHub")).toBe(
      "What should the policy do for GitHub?",
    );
  });
});

describe("openAppaTargetChatSubtitle", () => {
  test.each([
    ["agent", "Research assistant", 'the agent "Research assistant"'],
    ["mcp_gateway", "Prod gateway", 'the MCP gateway "Prod gateway"'],
    ["mcp_server", "GitHub", 'the MCP server "GitHub"'],
  ] as const)("scopes the subtitle to %s %s", (kind, name, phrase) => {
    expect(openAppaTargetChatSubtitle(kind, name)).toContain(phrase);
  });
});

describe("openAppaTargetScopeContext", () => {
  test.each([
    ["agent", "Research assistant", 'the agent "Research assistant"'],
    ["mcp_gateway", "Prod gateway", 'the MCP gateway "Prod gateway"'],
    ["mcp_server", "GitHub", 'the MCP server "GitHub"'],
  ] as const)("scopes the context to %s %s", (kind, name, phrase) => {
    expect(openAppaTargetScopeContext(kind, name)).toContain(phrase);
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
