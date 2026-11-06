import { describe, expect, test } from "vitest";
import {
  classifyRuleTarget,
  touchedRuleNames,
  touchedToolMetadata,
} from "./rule-targets";

const INVENTORY = new Set([
  "github__create_issue",
  "github__list_issues",
  "github__get_issue",
  "slack__post_message",
]);

function rule(name: string, delta = "{}") {
  return `[[policy.tool]]\nname = "${name}"\ndelta = ${delta}\n`;
}

function policy(...rules: string[]) {
  return `[policy]\nversion = 2\n${rules.join("")}`;
}

describe("classifyRuleTarget", () => {
  test("an inventory name, or its canonical mcp spelling, is known", () => {
    expect(classifyRuleTarget("github__get_issue", INVENTORY)).toEqual({
      kind: "known",
      rule: "github__get_issue",
      tool: "github__get_issue",
    });
    expect(classifyRuleTarget("mcp/github/get_issue", INVENTORY)).toEqual({
      kind: "known",
      rule: "mcp/github/get_issue",
      tool: "github__get_issue",
    });
  });

  test("a missing tool on an existing server is unknown, with the nearest names", () => {
    expect(classifyRuleTarget("github__delete_issue", INVENTORY)).toEqual({
      kind: "unknown_tool",
      rule: "github__delete_issue",
      server: "github",
      closest: ["github__create_issue", "github__get_issue"],
    });
    expect(classifyRuleTarget("mcp/github/delete_repo", INVENTORY)).toEqual({
      kind: "unknown_tool",
      rule: "mcp/github/delete_repo",
      server: "github",
      closest: [],
    });
  });

  test("a prefix no server uses is an unknown server, with the nearest prefixes", () => {
    expect(classifyRuleTarget("githb__get_issue", INVENTORY)).toEqual({
      kind: "unknown_server",
      rule: "githb__get_issue",
      server: "githb",
      closest: ["github"],
    });
  });

  test.each([
    "Bash",
    "host/archestra/Bash",
    "tool/coding/shell",
    "mcp/appa/yell",
    "mcp/archestra/get_agent",
    "github__*",
    "agent__researcher",
    "mcp__workspace__bash",
  ])("%s is outside what an MCP inventory can prove", (name) => {
    expect(classifyRuleTarget(name, INVENTORY).kind).toBe("unverifiable");
  });
});

describe("touchedRuleNames", () => {
  test("names only rules added or changed, without selectors or the catch-all", () => {
    const previous = policy(rule("github__get_issue"), rule("slack__x"));
    const content = policy(
      rule("github__get_issue"),
      rule("slack__x", '{ trust = "suspicious" }'),
      rule("github__create_issue(repo:public/*)"),
      rule("*"),
    );
    expect(touchedRuleNames(content, previous)).toEqual([
      "slack__x",
      "github__create_issue",
    ]);
  });
});

describe("touchedToolMetadata", () => {
  test("shortens descriptions, lists argument names and stays within its budget", () => {
    const tools = Array.from({ length: 40 }, (_, index) => ({
      name: `github__tool_${index}`,
      description: `Line one.\n\n${"x".repeat(1000)}`,
      parameters: { type: "object", properties: { repo: {}, title: {} } },
    }));
    const metadata = touchedToolMetadata(tools);
    expect(metadata.tools[0]).toEqual({
      name: "github__tool_0",
      description: `Line one. ${"x".repeat(390)}…`,
      arguments: ["repo", "title"],
    });
    expect(metadata.tools.length + metadata.omitted).toBe(40);
    expect(metadata.omitted).toBeGreaterThan(0);
    expect(
      Buffer.byteLength(JSON.stringify(metadata.tools)),
    ).toBeLessThanOrEqual(6000 + metadata.tools.length);
  });
});
