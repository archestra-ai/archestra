import { expect, test } from "vitest";
import { resolveOpenAppaLaunchPrompt } from "./openappa-chat-prompts";

const gateway = { kind: "mcp_gateway" as const, name: "Research" };

test("the coverage review names its target", () => {
  expect(resolveOpenAppaLaunchPrompt("reviewCoverage", gateway)).toMatch(
    /^Review how my OpenAPPA policy governs the MCP gateway "Research"\./,
  );
});

test("a launch key resolves only to a known prompt, and a target prompt only with its target", () => {
  expect(resolveOpenAppaLaunchPrompt("setUpPolicy")).toMatch(/\S/);
  expect(resolveOpenAppaLaunchPrompt("reviewCoverage")).toBeUndefined();
  expect(resolveOpenAppaLaunchPrompt("toString")).toBeUndefined();
  expect(resolveOpenAppaLaunchPrompt("unknown", gateway)).toBeUndefined();
});
