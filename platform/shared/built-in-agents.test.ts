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
  const targetId = "e8340e76-19fc-444d-ac4e-a817c1e78c3c";
  test.each([
    ["agent", "the agent"],
    ["mcp_gateway", "the MCP gateway"],
    ["mcp_server", "the MCP server"],
  ] as const)("scopes the context to %s", (kind, phrase) => {
    expect(openAppaTargetScopeContext(kind, targetId)).toContain(
      `${phrase} with ID ${targetId}`,
    );
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
