import { describe, expect, test } from "vitest";
import {
  detectedServerId,
  parseDetectedToolName,
} from "./detected-mcp-server-names";

describe("parseDetectedToolName", () => {
  test.each([
    [
      "claude-code",
      "mcp__slack__slack_send_message",
      "slack",
      "slack_send_message",
    ],
    ["codex", "mcp__linear__create_issue", "linear", "create_issue"],
    ["claude-code", "mcp__my.server-1__tool", "my.server-1", "tool"],
    ["opencode", "mcp:slack:send_message", "slack", "send_message"],
  ] as const)("%s reads %s as label %s and tool %s", (family, name, label, toolName) => {
    expect(parseDetectedToolName(family, name)).toEqual({ label, toolName });
  });

  test.each([
    ["claude-code", "Bash"],
    ["claude-code", "mcp__slack"],
    ["claude-code", "mcp__slack__"],
    ["claude-code", "mcp____send"],
    ["claude-code", "mcp__sl ack__send"],
    ["claude-code", "mcp__sl/ack__send"],
    ["codex", "exec_command"],
    ["opencode", "slack_send_message"],
    ["opencode", "mcp:slack"],
    ["opencode", "mcp::send"],
  ] as const)("%s does not read %s as a detected tool", (family, name) => {
    expect(parseDetectedToolName(family, name)).toBeUndefined();
  });

  // A second `__` makes the split ambiguous, and the runtime reads a
  // canonical name at its last `__`; the name is skipped rather than rewritten.
  test("rejects a name with more than one separator without normalising it", () => {
    expect(
      parseDetectedToolName("claude-code", "mcp__a__b__send"),
    ).toBeUndefined();
  });
});

describe("parseDetectedToolName for OpenCode's labelled spelling", () => {
  test("splits only against a declared label, the longest one winning", () => {
    const declared = ["slack", "slack_admin"];
    expect(
      parseDetectedToolName("opencode", "slack_send_message", declared),
    ).toEqual({ label: "slack", toolName: "send_message" });
    expect(
      parseDetectedToolName("opencode", "slack_admin_ban_user", declared),
    ).toEqual({ label: "slack_admin", toolName: "ban_user" });
  });

  // The runtime splits `<target>__<tool>` at its last `__`, so a tool part
  // holding one would be ruled under a server nobody declared.
  test.each([
    "slack_foo__bar",
    "slack__send",
    "slack_",
    "slack__",
    "linear_create",
  ])("reads nothing from %s", (name) => {
    expect(parseDetectedToolName("opencode", name, ["slack"])).toBeUndefined();
  });

  test("reads nothing without a declared label", () => {
    expect(
      parseDetectedToolName("opencode", "slack_send_message"),
    ).toBeUndefined();
  });
});

describe("detectedServerId", () => {
  test("joins family and label with a dot, the family being dot-free", () => {
    expect(detectedServerId("claude-code", "my.server")).toBe(
      "claude-code.my.server",
    );
  });
});
