// @vitest-environment node
import { expect, test } from "vitest";
import {
  resolveOpenAppaBatteryChangesPrompt,
  resolveOpenAppaBatteryPrompt,
  resolveOpenAppaLaunchPrompt,
} from "./openappa-chat-prompts";

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

const github = {
  name: "github",
  entry: "batteries/github/appa.toml",
  namespaces: ["github"],
};

test("a battery change names the exact battery, its include entry and the server", () => {
  const prompt = resolveOpenAppaBatteryPrompt({
    promptKey: "detachBattery",
    battery: github,
    server: { id: "catalog-1", name: "GitHub", toolPrefix: "code" },
  });
  expect(prompt).toMatch(
    /^Detach the battery "github" from the MCP server "GitHub"/,
  );
  for (const line of [
    "Include entry: batteries/github/appa.toml",
    "Namespaces: github",
    "Target type: mcp_server",
    "Target ID: catalog-1",
    "Tool prefix: code",
  ])
    expect(prompt).toContain(line);
});

test("a credential line's removal names the variable, and no server", () => {
  const prompt = resolveOpenAppaBatteryPrompt({
    promptKey: "removeCredentialLine",
    battery: github,
    variable: "APPA_PROVIDER_GITHUB_TOKEN",
  });
  expect(prompt).toContain("Credential variable: APPA_PROVIDER_GITHUB_TOKEN");
  expect(prompt).not.toContain("Target ID");
});

test("the changes a dialog saves together are asked for as one: a single change reads as it does alone, several name each server with its own lines", () => {
  const detach = {
    promptKey: "detachBattery" as const,
    battery: github,
    server: { id: "catalog-1", name: "GitHub", toolPrefix: "code" },
  };
  expect(resolveOpenAppaBatteryChangesPrompt([])).toBeUndefined();
  expect(resolveOpenAppaBatteryChangesPrompt([detach])).toBe(
    resolveOpenAppaBatteryPrompt(detach),
  );
  const prompt = resolveOpenAppaBatteryChangesPrompt([
    {
      promptKey: "attachBattery",
      battery: github,
      server: { id: "catalog-2", name: "Docs" },
    },
    detach,
  ]);
  expect(prompt).toMatch(
    /^Make these changes to the battery "github" in my OpenAPPA policy, as one change in one pull request:\n- Attach it to the MCP server "Docs"\.\n- Detach it from the MCP server "GitHub"\.\n/,
  );
  for (const line of [
    "Include entry: batteries/github/appa.toml",
    "Change: attach\nServer: Docs\nTarget type: mcp_server\nTarget ID: catalog-2",
    "Change: detach\nServer: GitHub\nTarget type: mcp_server\nTarget ID: catalog-1\nTool prefix: code",
  ])
    expect(prompt).toContain(line);
  // A server's editor says what they may change, so the agent proposes the
  // servers' batteries and not a policy change they cannot publish.
  expect(prompt).not.toContain("I may edit");
  expect(
    resolveOpenAppaBatteryChangesPrompt([detach], { serverEditor: true }),
  ).toMatch(
    /I may edit this server in the MCP registry, but I may not update the organization's guardrails\. Propose it as a change to the server's batteries\.$/,
  );
  expect(
    resolveOpenAppaBatteryChangesPrompt(
      [detach, { ...detach, server: { id: "catalog-2", name: "Docs" } }],
      { serverEditor: true },
    ),
  ).toMatch(/I may edit these servers .* the servers' batteries\.$/);
});
