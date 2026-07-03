import { describe, expect, test } from "vitest";
import {
  ARCHESTRA_TOOL_ARGUMENTS_TAG,
  ARCHESTRA_TOOL_NAME_TAG,
  ARCHESTRA_TOOL_REASON_TAG,
  buildArchestraToolRefusalMetadata,
  buildToolInvocationRefusalMessages,
  buildTrustedDataBlockedContentNotice,
  parseArchestraToolRefusal,
} from "./tool-refusal";

describe("tool refusal helpers", () => {
  test("builds and parses tagged refusal metadata", () => {
    const metadata = buildArchestraToolRefusalMetadata({
      toolName: "github__delete_branch",
      toolArguments: '{"branch":"main"}',
      reason: "Tool invocation blocked: sensitive data detected",
    });

    expect(metadata).toContain(`<${ARCHESTRA_TOOL_NAME_TAG}>`);
    expect(metadata).toContain(`<${ARCHESTRA_TOOL_ARGUMENTS_TAG}>`);
    expect(metadata).toContain(`<${ARCHESTRA_TOOL_REASON_TAG}>`);

    expect(parseArchestraToolRefusal(metadata)).toEqual({
      toolName: "github__delete_branch",
      toolArguments: '{"branch":"main"}',
      reason: "Tool invocation blocked: sensitive data detected",
    });
  });

  test("ignores oversized refusal metadata payloads", () => {
    const oversizedInput = `${"<archestra-tool-name>x".repeat(5_000)}</archestra-tool-name>`;

    expect(parseArchestraToolRefusal(oversizedInput)).toEqual({
      toolName: undefined,
      toolArguments: undefined,
      reason: undefined,
    });
  });

  test("refusal message leads with the block, then the rule, then what Archestra is", () => {
    const { contentMessage, refusalMessage } =
      buildToolInvocationRefusalMessages({
        toolName: "github__delete_branch",
        toolArguments: '{"branch":"main"}',
        reason:
          '"Block in sensitive context" tool call policy violated: this session contains sensitive data',
        surface: "llm-proxy",
        sessionId: "session-123",
      });

    expect(contentMessage).toBe(`
Archestra LLM Proxy blocked unsafe tool call: github__delete_branch with arguments: {"branch":"main"}.

"Block in sensitive context" tool call policy violated: this session contains sensitive data.

Archestra LLM Proxy monitors agentic traffic and blocks unsafe tool calls according to the configured guardrails.

If you believe this is a misconfiguration, contact your administrator.
Your session id: session-123.`);

    expect(refusalMessage).toContain(`<${ARCHESTRA_TOOL_NAME_TAG}>`);
    expect(refusalMessage).toContain(contentMessage);
  });

  test("gateway surface is named and the session line is omitted without a session id", () => {
    const { contentMessage } = buildToolInvocationRefusalMessages({
      toolName: "github__delete_branch",
      toolArguments: '{"branch":"main"}',
      reason: '"Block always" tool call policy violated: no branch deletions',
      surface: "mcp-gateway",
    });

    expect(contentMessage).toContain(
      "Archestra MCP Gateway blocked unsafe tool call: github__delete_branch",
    );
    // The gateway describes its own role (single entry to the MCP servers),
    // not the LLM proxy's "monitors agentic traffic".
    expect(contentMessage).toContain(
      "Archestra MCP Gateway provides a single entry to the MCP servers",
    );
    expect(contentMessage).not.toContain("monitors agentic traffic");
    expect(contentMessage).not.toContain("session id");
  });

  test("refusal messages use the white-label product name when provided", () => {
    const { contentMessage } = buildToolInvocationRefusalMessages({
      toolName: "github__delete_branch",
      toolArguments: '{"branch":"main"}',
      reason: '"Block always" tool call policy violated: no branch deletions',
      surface: "llm-proxy",
      productName: "Acme Gateway",
    });

    expect(contentMessage).toContain(
      "Acme Gateway LLM Proxy blocked unsafe tool call",
    );
    expect(contentMessage).not.toContain("Archestra");
  });

  test("trusted-data blocked content notice attributes the removal", () => {
    expect(
      buildTrustedDataBlockedContentNotice({
        reason: "Data blocked by policy: Block hacker emails",
      }),
    ).toBe(
      "[Content blocked by Archestra security guardrails: Data blocked by policy: Block hacker emails]",
    );

    expect(buildTrustedDataBlockedContentNotice({})).toBe(
      "[Content blocked by Archestra security guardrails]",
    );

    expect(
      buildTrustedDataBlockedContentNotice({
        reason: "Data blocked by policy: PII",
        productName: "Acme Gateway",
      }),
    ).toBe(
      "[Content blocked by Acme Gateway security guardrails: Data blocked by policy: PII]",
    );
  });
});
