import type { ChatMessage } from "@archestra/shared";
import { describe, expect, test } from "vitest";
import { readOpenAppaPolicyTargetContext } from "./read-openappa-policy-target-context";

function userMessage(metadata?: unknown): ChatMessage {
  return {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "hi" }],
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function assistantMessage(metadata?: unknown): ChatMessage {
  return {
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", text: "hello" }],
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

describe("readOpenAppaPolicyTargetContext", () => {
  test("scopes the context to the target on the last user message", () => {
    const context = readOpenAppaPolicyTargetContext([
      userMessage({
        openAppaPolicyTarget: { kind: "mcp_server", name: "GitHub" },
      }),
    ]);
    expect(context).toContain('the MCP server "GitHub"');
  });

  test("reads the latest user message, not an earlier one", () => {
    const context = readOpenAppaPolicyTargetContext([
      userMessage({
        openAppaPolicyTarget: { kind: "agent", name: "Research assistant" },
      }),
      assistantMessage(),
      userMessage({
        openAppaPolicyTarget: { kind: "mcp_gateway", name: "Prod gateway" },
      }),
    ]);
    expect(context).toContain('the MCP gateway "Prod gateway"');
  });

  test("ignores a target reported on an assistant message", () => {
    expect(
      readOpenAppaPolicyTargetContext([
        assistantMessage({
          openAppaPolicyTarget: { kind: "mcp_server", name: "GitHub" },
        }),
        userMessage(),
      ]),
    ).toBeUndefined();
  });

  test("returns undefined when no target is scoped", () => {
    expect(readOpenAppaPolicyTargetContext([userMessage()])).toBeUndefined();
    expect(
      readOpenAppaPolicyTargetContext([userMessage({ createdAt: "now" })]),
    ).toBeUndefined();
  });

  test("tolerates missing and malformed metadata", () => {
    expect(readOpenAppaPolicyTargetContext([])).toBeUndefined();
    expect(
      readOpenAppaPolicyTargetContext([
        userMessage({ openAppaPolicyTarget: { kind: "bogus", name: "X" } }),
      ]),
    ).toBeUndefined();
    expect(
      readOpenAppaPolicyTargetContext([
        userMessage({ openAppaPolicyTarget: "nonsense" }),
      ]),
    ).toBeUndefined();
  });
});
