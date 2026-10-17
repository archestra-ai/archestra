// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readMcpToolCall } from "./tool-call-content";

describe("readMcpToolCall", () => {
  it("names a tool call by its tool, without the server prefix", () => {
    const call = readMcpToolCall({
      method: "tools/call",
      toolCall: { name: "jira__create_issue", arguments: { project: "ENG" } },
      toolResult: { isError: true, error: "403 Forbidden" },
    });

    expect(call.toolName).toBe("create_issue");
    expect(call.args).toEqual({ project: "ENG" });
    expect(call.status).toBe("error");
    expect(call.lockedArgs).toBeNull();
  });

  it("reads non-tool methods as successful and unnamed", () => {
    const call = readMcpToolCall({
      method: "initialize",
      toolCall: null,
      toolResult: { isError: true },
    });

    expect(call.toolName).toBeNull();
    expect(call.status).toBe("success");
  });

  it("claims no outcome or name for an encrypted chat's call", () => {
    const sealed = { __encryptedChatSealed: "ciphertext" };
    const call = readMcpToolCall({
      method: "tools/call",
      toolCall: sealed,
      toolResult: sealed,
    });

    expect(call.toolName).toBeNull();
    expect(call.args).toBeUndefined();
    expect(call.lockedArgs).toEqual(sealed);
    expect(call.lockedResult).toEqual(sealed);
    expect(call.status).toBe("unknown");
  });

  it("treats arguments redacted inside the call as unavailable", () => {
    const call = readMcpToolCall({
      method: "tools/call",
      toolCall: {
        name: "docs__search",
        arguments: { __redacted: "locked_chat" },
      },
      toolResult: { isError: false, content: [] },
    });

    expect(call.args).toBeUndefined();
    expect(call.lockedArgs).toEqual({ __redacted: "locked_chat" });
    expect(call.status).toBe("success");
  });

  it("keeps a metadata-only row's name and outcome but not its content", () => {
    const call = readMcpToolCall({
      method: "tools/call",
      toolCall: {
        name: "docs__search",
        arguments: { __redacted: "log_content_policy" },
      },
      toolResult: { __redacted: "log_content_policy", isError: true },
    });

    expect(call.toolName).toBe("search");
    expect(call.args).toBeUndefined();
    expect(call.result).toBeNull();
    expect(call.status).toBe("error");
  });
});
