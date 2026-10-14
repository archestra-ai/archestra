// @vitest-environment node
import { expect, test } from "vitest";
import { resolveOpenAppaLaunchPrompt } from "./openappa-chat-prompts";

const gateway = {
  kind: "mcp_gateway" as const,
  name: "Research",
  id: "gateway-123",
};

test("the coverage review names its target", () => {
  expect(resolveOpenAppaLaunchPrompt("reviewCoverage", gateway)).toMatch(
    /^Review how my OpenAPPA policy governs the MCP gateway "Research"\./,
  );
  expect(resolveOpenAppaLaunchPrompt("reviewCoverage", gateway)).toContain(
    "Target ID: gateway-123",
  );
});

test("a launch key resolves only to a known prompt, and a target prompt only with its target", () => {
  expect(resolveOpenAppaLaunchPrompt("setUpPolicy")).toMatch(/\S/);
  expect(resolveOpenAppaLaunchPrompt("reviewCoverage")).toBeUndefined();
  expect(resolveOpenAppaLaunchPrompt("toString")).toBeUndefined();
  expect(resolveOpenAppaLaunchPrompt("unknown", gateway)).toBeUndefined();
});

const server = {
  kind: "mcp_server" as const,
  name: "GitHub",
  id: "catalog-1",
};

test("a policy prompt given a target keeps its text and narrows to the target", () => {
  const plain = resolveOpenAppaLaunchPrompt("improveCoverage");
  const scoped = resolveOpenAppaLaunchPrompt("improveCoverage", server);
  expect(scoped?.startsWith(`${plain} `)).toBe(true);
  expect(scoped).toContain('Focus on the MCP server "GitHub".');
  expect(scoped).toContain("Target ID: catalog-1");
});

test("a policy prompt given a tool narrows to that tool", () => {
  const scoped = resolveOpenAppaLaunchPrompt("explainPolicy", {
    ...server,
    tool: "create_issue",
  });
  expect(scoped).toContain(
    'Focus on the tool "create_issue" of the MCP server "GitHub".',
  );
  expect(scoped).toContain("Tool: create_issue");
});
