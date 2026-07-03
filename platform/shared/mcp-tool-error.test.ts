import { describe, expect, it } from "vitest";
import {
  buildPolicyDeniedMcpToolError,
  extractMcpToolError,
} from "./mcp-tool-error";
import {
  TOOL_INVOCATION_NO_POLICY_UNTRUSTED_REASON,
  TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON,
} from "./tool-invocation-policy-reasons";
import { buildToolInvocationRefusalMessages } from "./tool-refusal";

describe("extractMcpToolError", () => {
  it("extracts a direct MCP tool error object", () => {
    expect(
      extractMcpToolError({
        type: "auth_required",
        message: "Authentication required",
        catalogId: "cat_123",
        catalogName: "GitHub",
        action: "install_mcp_credentials",
        actionUrl: "http://localhost:3000/mcp/registry?install=cat_123",
      }),
    ).toEqual({
      type: "auth_required",
      message: "Authentication required",
      catalogId: "cat_123",
      catalogName: "GitHub",
      action: "install_mcp_credentials",
      actionUrl: "http://localhost:3000/mcp/registry?install=cat_123",
    });
  });

  it("extracts a legacy auth-required MCP tool error with installUrl", () => {
    expect(
      extractMcpToolError({
        type: "auth_required",
        message: "Authentication required",
        catalogId: "cat_123",
        catalogName: "GitHub",
        installUrl: "http://localhost:3000/mcp/registry?install=cat_123",
      }),
    ).toEqual({
      type: "auth_required",
      message: "Authentication required",
      catalogId: "cat_123",
      catalogName: "GitHub",
      installUrl: "http://localhost:3000/mcp/registry?install=cat_123",
    });
  });

  it("extracts a nested MCP tool error from _meta", () => {
    expect(
      extractMcpToolError({
        _meta: {
          archestraError: {
            type: "auth_expired",
            message: "Expired auth",
            catalogId: "cat_123",
            catalogName: "GitHub",
            serverId: "srv_123",
            reauthUrl:
              "http://localhost:3000/mcp/registry?reauth=cat_123&server=srv_123",
          },
        },
      }),
    ).toEqual({
      type: "auth_expired",
      message: "Expired auth",
      catalogId: "cat_123",
      catalogName: "GitHub",
      serverId: "srv_123",
      reauthUrl:
        "http://localhost:3000/mcp/registry?reauth=cat_123&server=srv_123",
    });
  });

  it("preserves the resolved credential scope on an auth_expired error", () => {
    expect(
      extractMcpToolError({
        archestraError: {
          type: "auth_expired",
          message: "Expired auth",
          catalogId: "cat_123",
          catalogName: "GitHub",
          serverId: "srv_123",
          reauthUrl:
            "http://localhost:3000/mcp/registry?reauth=cat_123&server=srv_123",
          credentialScope: "team",
          credentialTeamName: "Platform Team",
        },
      }),
    ).toEqual({
      type: "auth_expired",
      message: "Expired auth",
      catalogId: "cat_123",
      catalogName: "GitHub",
      serverId: "srv_123",
      reauthUrl:
        "http://localhost:3000/mcp/registry?reauth=cat_123&server=srv_123",
      credentialScope: "team",
      credentialTeamName: "Platform Team",
    });
  });

  it("extracts an assigned-credential-unavailable error", () => {
    expect(
      extractMcpToolError({
        type: "assigned_credential_unavailable",
        message: "Assigned credential is unavailable",
        catalogId: "cat_123",
        catalogName: "GitHub",
      }),
    ).toEqual({
      type: "assigned_credential_unavailable",
      message: "Assigned credential is unavailable",
      catalogId: "cat_123",
      catalogName: "GitHub",
    });
  });

  it("extracts a nested MCP tool error from JSON", () => {
    expect(
      extractMcpToolError(
        JSON.stringify({
          structuredContent: {
            archestraError: {
              type: "generic",
              message: "Something failed",
            },
          },
        }),
      ),
    ).toEqual({
      type: "generic",
      message: "Something failed",
    });
  });

  it("extracts a policy denied error from refusal text", () => {
    expect(
      extractMcpToolError(`\
<archestra-tool-name>github__delete_branch</archestra-tool-name>
<archestra-tool-arguments>{"branch":"main"}</archestra-tool-arguments>
<archestra-tool-reason>Tool invocation blocked: sensitive data detected</archestra-tool-reason>

I tried to invoke the github__delete_branch tool with the following arguments: {"branch":"main"}.

However, I was denied by a tool invocation policy:

Tool invocation blocked: sensitive data detected`),
    ).toEqual({
      type: "policy_denied",
      message: expect.any(String),
      toolName: "github__delete_branch",
      input: { branch: "main" },
      reason: "Tool invocation blocked: sensitive data detected",
      reasonType: "generic",
    });
  });

  it("extracts a policy denied error from untagged refusal text", () => {
    expect(
      extractMcpToolError(`I tried to invoke the github__delete_branch tool with the following arguments: {"branch":"main"}.

However, I was denied by a tool invocation policy:

Tool invocation blocked: sensitive data detected`),
    ).toEqual({
      type: "policy_denied",
      message: expect.any(String),
      toolName: "github__delete_branch",
      input: { branch: "main" },
      reason: "sensitive data detected",
      reasonType: "generic",
    });
  });

  it("classifies sensitive-context policy denials in legacy persisted refusals", () => {
    // Hardcoded legacy wording: this is what pre-rewrite refusals persisted
    // in interaction logs and chat history look like.
    expect(
      extractMcpToolError(`I tried to invoke the github__delete_branch tool with the following arguments: {"branch":"main"}.

However, I was denied by a tool invocation policy:

Tool call blocked: context contains sensitive data`),
    ).toEqual({
      type: "policy_denied",
      message: expect.any(String),
      toolName: "github__delete_branch",
      input: { branch: "main" },
      reason: "context contains sensitive data",
      reasonType: "sensitive_context",
    });
  });

  it("extracts a policy denied error from the current Archestra-attributed refusal message (tagged)", () => {
    const { refusalMessage } = buildToolInvocationRefusalMessages({
      toolName: "github__delete_branch",
      toolArguments: '{"branch":"main"}',
      reason: '"Block always" tool call policy violated: no branch deletions',
      surface: "mcp-gateway",
    });

    expect(extractMcpToolError(refusalMessage)).toEqual({
      type: "policy_denied",
      message: expect.any(String),
      toolName: "github__delete_branch",
      input: { branch: "main" },
      reason: '"Block always" tool call policy violated: no branch deletions',
      reasonType: "generic",
    });
  });

  it("extracts a policy denied error from the current Archestra-attributed content message (untagged)", () => {
    // The streaming proxy path and most provider adapters emit only the
    // untagged contentMessage, so the text parse must keep working on the
    // attributed wording — including recovering the exact reason constant so
    // the sensitive-context classification holds.
    const { contentMessage } = buildToolInvocationRefusalMessages({
      toolName: "github__delete_branch",
      toolArguments: '{"branch":"main"}',
      reason: TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON,
      surface: "llm-proxy",
      sessionId: "session-123",
    });

    expect(extractMcpToolError(contentMessage)).toEqual({
      type: "policy_denied",
      message: expect.any(String),
      toolName: "github__delete_branch",
      input: { branch: "main" },
      reason: TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON,
      reasonType: "sensitive_context",
    });
  });

  it("parses the untagged content message even when the white-label product name contains parser anchor words", () => {
    // "Invoke"/"Denied" in an admin-chosen product name must not hijack the
    // legacy heuristic anchors — the current template markers take precedence.
    for (const productName of ["Invoke Gateway", "Denied Access Gateway"]) {
      const { contentMessage } = buildToolInvocationRefusalMessages({
        toolName: "github__delete_branch",
        toolArguments: '{"branch":"main"}',
        reason: TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON,
        surface: "mcp-gateway",
        productName,
      });

      expect(extractMcpToolError(contentMessage)).toEqual({
        type: "policy_denied",
        message: expect.any(String),
        toolName: "github__delete_branch",
        input: { branch: "main" },
        reason: TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON,
        reasonType: "sensitive_context",
      });
    }
  });

  it("normalizes reasonType for direct structured policy-denied errors", () => {
    expect(
      extractMcpToolError({
        type: "policy_denied",
        message: "blocked",
        toolName: "github__delete_branch",
        input: { branch: "main" },
        reason: TOOL_INVOCATION_NO_POLICY_UNTRUSTED_REASON,
      }),
    ).toEqual({
      type: "policy_denied",
      message: "blocked",
      toolName: "github__delete_branch",
      input: { branch: "main" },
      reason: TOOL_INVOCATION_NO_POLICY_UNTRUSTED_REASON,
      reasonType: "sensitive_context",
    });
  });

  it("extracts tool state errors from structured content", () => {
    expect(
      extractMcpToolError({
        structuredContent: {
          archestraError: {
            type: "tool_state",
            code: "already_using_agent",
            message: "Already using agent.",
            toolName: "archestra__swap_agent",
          },
        },
      }),
    ).toEqual({
      type: "tool_state",
      code: "already_using_agent",
      message: "Already using agent.",
      toolName: "archestra__swap_agent",
    });
  });
});

describe("buildPolicyDeniedMcpToolError", () => {
  it("classifies a sensitive-context reason and round-trips through extractMcpToolError", () => {
    const error = buildPolicyDeniedMcpToolError({
      toolName: "archestra_pm__list_tasks",
      input: { list: "week" },
      reason: TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON,
      message: "human-readable refusal",
    });

    expect(error).toEqual({
      type: "policy_denied",
      message: "human-readable refusal",
      toolName: "archestra_pm__list_tasks",
      input: { list: "week" },
      reason: TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON,
      reasonType: "sensitive_context",
    });

    // The structured error is preferred over any prose parsing when carried on
    // a tool result's _meta / structuredContent.
    expect(
      extractMcpToolError({ structuredContent: { archestraError: error } }),
    ).toEqual(error);
    expect(extractMcpToolError({ _meta: { archestraError: error } })).toEqual(
      error,
    );
  });

  it("classifies a non-sensitive reason as generic", () => {
    const error = buildPolicyDeniedMcpToolError({
      toolName: "some_tool",
      input: {},
      reason: "some other policy reason",
      message: "blocked",
    });

    expect(error.reasonType).toBe("generic");
  });
});
