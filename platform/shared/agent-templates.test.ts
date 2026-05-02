import { describe, expect, test } from "vitest";
import { getTemplateRequiredMcpServers, isWildcardTool, TOOL_WILDCARD } from "./agent-templates";

describe("getTemplateRequiredMcpServers", () => {
  test("returns empty for built-in archestra tools", () => {
    const tools = ["archestra__list_agents", "archestra__get_mcp_servers"];
    expect(getTemplateRequiredMcpServers(tools)).toEqual([]);
  });

  test("returns display name for known external MCP", () => {
    const tools = ["github__search_repositories", "github__list_issues"];
    expect(getTemplateRequiredMcpServers(tools)).toEqual(["Github"]);
  });

  test("returns server name raw when no display mapping", () => {
    const tools = ["custom-server__some_tool"];
    expect(getTemplateRequiredMcpServers(tools)).toEqual(["Custom-server"]);
  });

  test("deduplicates when multiple tools from same server", () => {
    const tools = [
      "github__search_repositories",
      "github__list_issues",
      "github__get_pull_request",
    ];
    expect(getTemplateRequiredMcpServers(tools)).toEqual(["Github"]);
  });

  test("returns multiple unique MCP servers", () => {
    const tools = ["github__search_repositories", "slack__post_message"];
    expect(getTemplateRequiredMcpServers(tools)).toEqual(["Github", "Slack"]);
  });

  test("filters out archestra when mixed with external", () => {
    const tools = ["archestra__list_agents", "github__search_repositories"];
    expect(getTemplateRequiredMcpServers(tools)).toEqual(["Github"]);
  });

  test("returns empty for empty tools array", () => {
    expect(getTemplateRequiredMcpServers([])).toEqual([]);
  });

  test("extracts server name from wildcard tool FQN", () => {
    const tools = ["github__*"];
    expect(getTemplateRequiredMcpServers(tools)).toEqual(["Github"]);
  });

  test("deduplicates when wildcard and specific tools from same server", () => {
    const tools = ["github__*", "github__list_issues"];
    expect(getTemplateRequiredMcpServers(tools)).toEqual(["Github"]);
  });
});

describe("isWildcardTool", () => {
  test("returns true for wildcard FQN", () => {
    expect(isWildcardTool("github__*")).toBe(true);
  });

  test("returns false for specific tool FQN", () => {
    expect(isWildcardTool("github__search_repositories")).toBe(false);
  });

  test("returns false for built-in tool", () => {
    expect(isWildcardTool("archestra__list_agents")).toBe(false);
  });

  test("returns false for invalid FQN", () => {
    expect(isWildcardTool("no_separator")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isWildcardTool("")).toBe(false);
  });

  test("TOOL_WILDCARD constant is *", () => {
    expect(TOOL_WILDCARD).toBe("*");
  });
});
