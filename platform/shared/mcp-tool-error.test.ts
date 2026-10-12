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

  it("extracts tool state errors from structured content", () => {
    expect(
      extractMcpToolError({
        structuredContent: {
          archestraError: {
            type: "tool_state",
            code: "skill_not_found",
            message: "Skill not found.",
            toolName: "archestra__load_skill",
          },
        },
      }),
    ).toEqual({
      type: "tool_state",
      code: "skill_not_found",
      message: "Skill not found.",
      toolName: "archestra__load_skill",
    });
  });
});
