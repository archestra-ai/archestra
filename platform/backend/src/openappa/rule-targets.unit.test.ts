import { describe, expect, test } from "vitest";
import {
  classifyRuleTarget,
  ruleTargetWarning,
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

describe("ruleTargetWarning", () => {
  test("an unknown tool can still match a server or client call", () => {
    expect(
      ruleTargetWarning(classifyRuleTarget("github__delete_issue", INVENTORY)),
    ).toBe(
      'tool rule "github__delete_issue" names no known tool: prefix "github" has no such tool in the MCP registry or observed LLM proxy traffic, so it matches nothing unless a server or client calls "github__delete_issue"; did you mean "github__create_issue", "github__get_issue"?',
    );
  });

  test("an unknown prefix can still match an unseen server or client", () => {
    expect(
      ruleTargetWarning(classifyRuleTarget("githb__get_issue", INVENTORY)),
    ).toBe(
      'tool rule "githb__get_issue" names no known tool: no MCP server or observed LLM proxy tool in this organization uses the prefix "githb", so it matches nothing unless a server or client uses that prefix; did you mean "github"?',
    );
    expect(
      ruleTargetWarning(
        classifyRuleTarget("calendar__create_event", INVENTORY),
      ),
    ).toBe(
      'tool rule "calendar__create_event" names no known tool: no MCP server or observed LLM proxy tool in this organization uses the prefix "calendar", so it matches nothing unless a server or client uses that prefix',
    );
  });

  test.each([
    "github__get_issue",
    "mcp/github/get_issue",
    "Bash",
  ])("%s needs no missing-tool warning", (name) => {
    expect(ruleTargetWarning(classifyRuleTarget(name, INVENTORY))).toBeNull();
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
