import { describe, expect, test } from "vitest";
import {
  observedServerId,
  parseObservedToolName,
} from "./observed-mcp-server-names";

describe("parseObservedToolName", () => {
  test.each([
    ["mcp__slack__slack_send_message", "slack", "slack_send_message"],
    ["mcp__linear__create_issue", "linear", "create_issue"],
    ["mcp__my.server-1__tool", "my.server-1", "tool"],
    ["mcp:slack:send_message", "slack", "send_message"],
  ] as const)("reads %s as label %s and tool %s, whichever client sent it", (name, label, toolName) => {
    expect(parseObservedToolName(name)).toEqual({ label, toolName });
  });

  test.each([
    "Bash",
    "exec_command",
    "mcp__slack",
    "mcp__slack__",
    "mcp____send",
    "mcp__sl ack__send",
    "mcp__sl/ack__send",
    "slack_send_message",
    "mcp:slack",
    "mcp::send",
  ])("does not read %s as a observed tool", (name) => {
    expect(parseObservedToolName(name)).toBeUndefined();
  });

  // A second `__` makes the split ambiguous, and the runtime reads a
  // canonical name at its last `__`; the name is skipped rather than rewritten.
  test("rejects a name with more than one separator without normalising it", () => {
    expect(parseObservedToolName("mcp__a__b__send")).toBeUndefined();
  });
});

describe("observedServerId", () => {
  test("prefixes the label with observed, whichever client declared it", () => {
    expect(observedServerId("my.server")).toBe("observed.my.server");
  });
});
