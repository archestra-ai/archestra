import { describe, expect, it } from "vitest";
import { extractMcpToolError } from "./mcp-tool-error";

describe("extractMcpToolError", () => {
  it("extracts a direct MCP tool error object", () => {
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
<archestra-tool-reason>Tool invocation blocked: untrusted data detected</archestra-tool-reason>

I tried to invoke the github__delete_branch tool with the following arguments: {"branch":"main"}.

However, I was denied by a tool invocation policy:

Tool invocation blocked: untrusted data detected`),
    ).toEqual({
      type: "policy_denied",
      message: expect.any(String),
      toolName: "github__delete_branch",
      input: { branch: "main" },
      reason: "Tool invocation blocked: untrusted data detected",
    });
  });

  it("extracts a policy denied error from untagged refusal text", () => {
    expect(
      extractMcpToolError(`I tried to invoke the github__delete_branch tool with the following arguments: {"branch":"main"}.

However, I was denied by a tool invocation policy:

Tool invocation blocked: untrusted data detected`),
    ).toEqual({
      type: "policy_denied",
      message: expect.any(String),
      toolName: "github__delete_branch",
      input: { branch: "main" },
      reason: "untrusted data detected",
    });
  });
});
