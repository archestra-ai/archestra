// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  readListedTools,
  readMcpToolCall,
  readToolResultText,
} from "./tool-call-content";

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

  it("treats arguments redacted inside the call as unavailable, keeping the name", () => {
    const call = readMcpToolCall({
      method: "tools/call",
      toolCall: {
        name: "docs__search",
        arguments: { __redacted: "locked_chat" },
      },
      toolResult: { isError: false, content: [] },
    });

    expect(call.toolName).toBe("search");
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

  it("names an encrypted chat's call whose content was not stored", () => {
    // Encrypted chat without an audit context: the name survives beside the
    // redacted arguments, and the whole result is the redaction marker.
    const call = readMcpToolCall({
      method: "tools/call",
      toolCall: {
        id: "tc",
        name: "github__search_issues",
        arguments: { __redacted: "encrypted_chat" },
      },
      toolResult: { __redacted: "encrypted_chat" },
    });

    expect(call.toolName).toBe("search_issues");
    expect(call.args).toBeUndefined();
    expect(call.status).toBe("unknown");
    expect(call.outcomeMessage).toBeNull();
  });

  it("says why a call was refused, failed or cancelled", () => {
    const refusal = {
      type: "tool_state",
      code: "tool_not_enabled",
      message: "The tools are not enabled for this conversation.",
      toolName: "github__search_issues",
    };
    const blocked = readMcpToolCall({
      method: "tools/call",
      toolCall: { name: "github__search_issues", arguments: {} },
      toolResult: {
        isError: true,
        content: [{ type: "text", text: refusal.message }],
        _meta: { archestraError: refusal },
      },
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.outcomeMessage).toBe(refusal.message);

    // The platform's own error string wins over the server's text.
    expect(
      readMcpToolCall({
        method: "tools/call",
        toolCall: null,
        toolResult: {
          isError: true,
          error: "HTTP 502 from upstream",
          content: [{ type: "text", text: "raw body" }],
        },
      }).outcomeMessage,
    ).toBe("HTTP 502 from upstream");
    // A server-reported isError has only its text to say why.
    expect(
      readMcpToolCall({
        method: "tools/call",
        toolCall: null,
        toolResult: {
          isError: true,
          content: [{ type: "text", text: "MCP error -32603: 422" }],
        },
      }).outcomeMessage,
    ).toBe("MCP error -32603: 422");

    const cancelled = readMcpToolCall({
      method: "tools/call",
      toolCall: null,
      toolResult: {
        isError: false,
        content: [{ type: "text", text: "Cancelled before it finished" }],
        _meta: {
          archestraError: {
            type: "cancelled",
            message: "Cancelled before it finished",
          },
        },
      },
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.outcomeMessage).toBe("Cancelled before it finished");

    expect(
      readMcpToolCall({
        method: "tools/call",
        toolCall: null,
        toolResult: { isError: false, content: [{ type: "text", text: "ok" }] },
      }).outcomeMessage,
    ).toBeNull();
  });
});

describe("readToolResultText", () => {
  it("joins a result's text blocks and refuses mixed or empty content", () => {
    expect(
      readToolResultText({
        content: [
          { type: "text", text: "line 1\nline 2" },
          { type: "text", text: "more" },
        ],
      }),
    ).toBe("line 1\nline 2\n\nmore");
    expect(
      readToolResultText({
        content: [
          { type: "text", text: "caption" },
          { type: "image", data: "…", mimeType: "image/png" },
        ],
      }),
    ).toBeNull();
    expect(readToolResultText({ content: [] })).toBeNull();
    expect(readToolResultText(null)).toBeNull();
  });
});

describe("readListedTools", () => {
  it("reads names and descriptions, skipping malformed entries", () => {
    expect(
      readListedTools({
        tools: [
          { name: "github__get_issue", description: "Get one issue." },
          { name: "postgres__query" },
          { description: "no name" },
          null,
        ],
      }),
    ).toEqual([
      { name: "github__get_issue", description: "Get one issue." },
      { name: "postgres__query", description: null },
    ]);
    expect(readListedTools({ content: [] })).toBeNull();
  });
});
