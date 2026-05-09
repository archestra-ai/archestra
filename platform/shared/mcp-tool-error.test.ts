import { describe, expect, it } from "vitest";
import { extractMcpToolError } from "./mcp-tool-error";
import {
  TOOL_INVOCATION_NO_POLICY_UNTRUSTED_REASON,
  TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON,
} from "./tool-invocation-policy-reasons";

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

  it("classifies sensitive-context policy denials", () => {
    expect(
      extractMcpToolError(`I tried to invoke the github__delete_branch tool with the following arguments: {"branch":"main"}.

However, I was denied by a tool invocation policy:

${TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON}`),
    ).toEqual({
      type: "policy_denied",
      message: expect.any(String),
      toolName: "github__delete_branch",
      input: { branch: "main" },
      reason: "context contains sensitive data",
      reasonType: "sensitive_context",
    });
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
