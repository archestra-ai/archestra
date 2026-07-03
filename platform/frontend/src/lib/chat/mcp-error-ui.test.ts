import { TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  extractCatalogIdFromInstallUrl,
  extractIdsFromReauthUrl,
  hasToolPartsWithAuthErrors,
  isAuthInstructionText,
  isInstallAuthResolved,
  parseAuthRequired,
  parseExpiredAuth,
  parsePolicyDenied,
  resolveAssistantTextAuthState,
  resolveMcpAppToolCallAuthState,
  resolveToolAuthState,
  type ToolAuthState,
} from "./mcp-error-ui";

describe("parsePolicyDenied", () => {
  it("parses a legacy plain-text policy denial with tool name, args, and reason", () => {
    // Hardcoded legacy wording: this is what pre-rewrite refusals persisted
    // in chat history look like.
    const text = `\nI tried to invoke the upstash__context7__get-library-docs tool with the following arguments: {"context7CompatibleLibraryID":"/websites/p5js_reference"}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool call blocked: context contains sensitive data`;
    const result = parsePolicyDenied(text);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("tool-upstash__context7__get-library-docs");
    expect(result?.state).toBe("output-denied");
    expect(result?.input).toEqual({
      context7CompatibleLibraryID: "/websites/p5js_reference",
    });
    const errorInfo = JSON.parse(result?.errorText ?? "");
    expect(errorInfo.reason).toContain("context contains sensitive data");
    expect(result?.unsafeContextActiveAtRequestStart).toBe(true);
  });

  it("parses a current-format plain-text policy denial with tool name, args, and reason", () => {
    const text = `\nArchestra MCP Gateway blocked unsafe tool call: upstash__context7__get-library-docs with arguments: {"context7CompatibleLibraryID":"/websites/p5js_reference"}.\n\n${TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON}.\n\nDo not retry: the same tool call will be blocked again.\n\nArchestra MCP Gateway monitors agentic traffic and blocks unsafe tool calls according to the configured guardrails. If you believe this is a misconfiguration, contact your administrator.`;
    const result = parsePolicyDenied(text);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("tool-upstash__context7__get-library-docs");
    expect(result?.state).toBe("output-denied");
    expect(result?.input).toEqual({
      context7CompatibleLibraryID: "/websites/p5js_reference",
    });
    const errorInfo = JSON.parse(result?.errorText ?? "");
    expect(errorInfo.reason).toBe(TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON);
    expect(result?.unsafeContextActiveAtRequestStart).toBe(true);
  });

  it("parses a JSON-wrapped policy denial (originalError.message)", () => {
    const inner =
      '\nI tried to invoke the my-tool tool with the following arguments: {"key":"value"}.\n\nHowever, I was denied by a tool invocation policy:\n\nBlocked by admin';
    const text = JSON.stringify({
      code: "unknown",
      originalError: { message: inner },
    });
    const result = parsePolicyDenied(text);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("tool-my-tool");
    expect(result?.input).toEqual({ key: "value" });
    expect(result?.unsafeContextActiveAtRequestStart).toBe(false);
  });

  it("uses structured reasonType for policy denials when available", () => {
    const text = JSON.stringify({
      _meta: {
        archestraError: {
          type: "policy_denied",
          message: "blocked",
          toolName: "some-tool",
          input: {},
          reason: TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON,
          reasonType: "sensitive_context",
        },
      },
    });

    const result = parsePolicyDenied(text);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("tool-some-tool");
    expect(result?.unsafeContextActiveAtRequestStart).toBe(true);
  });

  it("parses a JSON-wrapped policy denial (message)", () => {
    const inner =
      "\nI tried to invoke the some-tool tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nNot allowed";
    const text = JSON.stringify({ message: inner });
    const result = parsePolicyDenied(text);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("tool-some-tool");
  });

  it("returns null for unrelated text", () => {
    expect(parsePolicyDenied("Hello world")).toBeNull();
  });

  it("returns null for text missing required keywords", () => {
    expect(
      parsePolicyDenied("The tool was denied access to the resource"),
    ).toBeNull();
  });

  it("returns null for text with keywords but no matching pattern", () => {
    const text =
      "The tool invocation was denied by policy but has no structured format";
    expect(parsePolicyDenied(text)).toBeNull();
  });
});

describe("parseAuthRequired", () => {
  const makeDirectErrorText = (catalogName: string, installUrl: string) =>
    `Authentication required for "${catalogName}".\n\nNo credentials were found for your account (user: usr_123).\nTo set up your credentials, visit this URL: ${installUrl}\n\nIMPORTANT: You MUST display the URL above to the user exactly as shown. Do NOT omit it or paraphrase it.\n\nOnce you have completed authentication, retry this tool call.`;

  it("parses a direct text auth-required error", () => {
    const url = "http://localhost:3000/mcp/registry?install=cat_abc";
    const text = makeDirectErrorText("jira-atlassian-remote", url);
    const result = parseAuthRequired(text);
    expect(result).toEqual({
      catalogName: "jira-atlassian-remote",
      actionUrl: url,
      action: "install_mcp_credentials",
      providerId: null,
    });
  });

  it("parses a JSON-wrapped auth-required error (originalError.message)", () => {
    const url = "https://app.example.com/mcp/registry?install=cat_xyz";
    const inner = makeDirectErrorText("slack-remote", url);
    const text = JSON.stringify({
      code: "unknown",
      originalError: { message: inner },
    });
    const result = parseAuthRequired(text);
    expect(result).toEqual({
      catalogName: "slack-remote",
      actionUrl: url,
      action: "install_mcp_credentials",
      providerId: null,
    });
  });

  it("parses a JSON-wrapped auth-required error (message)", () => {
    const url = "http://localhost:3000/mcp/registry?install=cat_123";
    const inner = makeDirectErrorText("github-remote", url);
    const text = JSON.stringify({ message: inner });
    const result = parseAuthRequired(text);
    expect(result).toEqual({
      catalogName: "github-remote",
      actionUrl: url,
      action: "install_mcp_credentials",
      providerId: null,
    });
  });

  it("handles catalog names with special characters", () => {
    const url = "http://localhost:3000/mcp/registry?install=cat_456";
    const text = makeDirectErrorText("my-org/custom-server", url);
    const result = parseAuthRequired(text);
    expect(result).toEqual({
      catalogName: "my-org/custom-server",
      actionUrl: url,
      action: "install_mcp_credentials",
      providerId: null,
    });
  });

  it("returns null for unrelated text", () => {
    expect(parseAuthRequired("Hello world")).toBeNull();
  });

  it("returns null for text with 'Authentication' but not the full pattern", () => {
    expect(
      parseAuthRequired("Authentication failed for some reason"),
    ).toBeNull();
  });

  it("returns null when Authentication required is present but URL is missing", () => {
    const text =
      'Authentication required for "some-tool".\n\nPlease authenticate.';
    expect(parseAuthRequired(text)).toBeNull();
  });

  it("returns null for policy denial errors", () => {
    const text =
      "\nI tried to invoke the my-tool tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nBlocked";
    expect(parseAuthRequired(text)).toBeNull();
  });

  it("returns null for expired auth errors (distinct message format)", () => {
    const text =
      'Expired or invalid authentication for "github-remote".\n\nYour credentials (user: usr_123) failed authentication. Please re-authenticate to continue using this tool.\nTo re-authenticate, visit this URL: http://localhost:3000/mcp/registry?reauth=cat_abc&server=srv_xyz';
    expect(parseAuthRequired(text)).toBeNull();
  });
});

describe("parseExpiredAuth", () => {
  const makeExpiredErrorText = (catalogName: string, reauthUrl: string) =>
    `Expired or invalid authentication for "${catalogName}".\n\nYour credentials (user: usr_123) failed authentication. Please re-authenticate to continue using this tool.\nTo re-authenticate, visit this URL: ${reauthUrl}\n\nIMPORTANT: You MUST display the URL above to the user exactly as shown. Do NOT omit it or paraphrase it.\n\nOnce you have re-authenticated, retry this tool call.`;

  it("parses a direct text expired-auth error", () => {
    const url =
      "http://localhost:3000/mcp/registry?reauth=cat_abc&server=srv_xyz";
    const text = makeExpiredErrorText("github-copilot-remote", url);
    const result = parseExpiredAuth(text);
    expect(result).toEqual({
      catalogName: "github-copilot-remote",
      reauthUrl: url,
    });
  });

  it("parses a JSON-wrapped expired-auth error (originalError.message)", () => {
    const url =
      "https://app.example.com/mcp/registry?reauth=cat_jira&server=srv_jira";
    const inner = makeExpiredErrorText("jira-remote", url);
    const text = JSON.stringify({
      code: "unknown",
      originalError: { message: inner },
    });
    const result = parseExpiredAuth(text);
    expect(result).toEqual({
      catalogName: "jira-remote",
      reauthUrl: url,
    });
  });

  it("parses a JSON-wrapped expired-auth error (message)", () => {
    const url =
      "http://localhost:3000/mcp/registry?reauth=cat_123&server=srv_456";
    const inner = makeExpiredErrorText("slack-remote", url);
    const text = JSON.stringify({ message: inner });
    const result = parseExpiredAuth(text);
    expect(result).toEqual({
      catalogName: "slack-remote",
      reauthUrl: url,
    });
  });

  it("returns null for unrelated text", () => {
    expect(parseExpiredAuth("Hello world")).toBeNull();
  });

  it("returns null for auth-required errors (different format)", () => {
    const text =
      'Authentication required for "jira-remote".\n\nNo credentials were found for your account (user: usr_123).\nTo set up your credentials, visit: http://localhost:3000/mcp/registry?install=cat_abc';
    expect(parseExpiredAuth(text)).toBeNull();
  });

  it("returns null when expired auth is present but URL is missing", () => {
    const text =
      'Expired or invalid authentication for "some-tool".\n\nPlease re-authenticate.';
    expect(parseExpiredAuth(text)).toBeNull();
  });

  it("parses the shorter assistant expired-auth phrasing without a catalog name", () => {
    const url =
      "http://localhost:3000/mcp/registry?reauth=cat_abc&server=srv_xyz";
    const text = `Your credentials have expired. Please visit ${url} to re-authenticate and then try again.`;
    const result = parseExpiredAuth(text);
    expect(result).toEqual({
      catalogName: "",
      reauthUrl: url,
    });
  });
});

describe("extractCatalogIdFromInstallUrl", () => {
  it("extracts the catalog ID from a valid install URL", () => {
    expect(
      extractCatalogIdFromInstallUrl(
        "http://localhost:3000/mcp/registry?install=cat_abc123",
      ),
    ).toBe("cat_abc123");
  });

  it("returns null when install param is missing", () => {
    expect(
      extractCatalogIdFromInstallUrl("http://localhost:3000/mcp/registry"),
    ).toBeNull();
  });

  it("returns null for an invalid URL", () => {
    expect(extractCatalogIdFromInstallUrl("not-a-url")).toBeNull();
  });

  it("handles URLs with additional query params", () => {
    expect(
      extractCatalogIdFromInstallUrl(
        "http://localhost:3000/mcp/registry?search=jira&install=cat_xyz",
      ),
    ).toBe("cat_xyz");
  });
});

describe("resolveToolAuthState", () => {
  it("prefers structured auth-required MCP errors", () => {
    expect(
      resolveToolAuthState({
        errorText: "some generic fallback",
        rawOutput: {
          archestraError: {
            type: "auth_required",
            message: "Authentication required",
            catalogName: "github-remote",
            action: "install_mcp_credentials",
            actionUrl: "http://localhost:3000/mcp/registry?install=cat_abc",
            catalogId: "cat_abc",
          },
        },
      }),
    ).toEqual({
      kind: "auth-required",
      catalogName: "github-remote",
      actionUrl: "http://localhost:3000/mcp/registry?install=cat_abc",
      action: "install_mcp_credentials",
      providerId: null,
      catalogId: "cat_abc",
    });
  });

  it("resolves structured linked identity provider auth-required errors", () => {
    const actionUrl =
      "http://localhost:3000/auth/sso/EntraID?redirectTo=%2Fchat%2Fconv-123";

    expect(
      resolveToolAuthState({
        rawOutput: {
          archestraError: {
            type: "auth_required",
            message: "Authentication required",
            catalogName: "protected api",
            action: "connect_identity_provider",
            actionUrl,
            providerId: "EntraID",
            catalogId: "cat_abc",
          },
        },
      }),
    ).toEqual({
      kind: "auth-required",
      catalogName: "protected api",
      actionUrl,
      action: "connect_identity_provider",
      providerId: "EntraID",
      catalogId: "cat_abc",
    });
  });

  it("infers linked identity provider auth from legacy installUrl values", () => {
    const actionUrl =
      "http://localhost:3000/auth/sso/EntraID?redirectTo=%2Fchat%2Fconv-123";

    expect(
      resolveToolAuthState({
        rawOutput: {
          archestraError: {
            type: "auth_required",
            message: "Authentication required",
            catalogName: "protected api",
            installUrl: actionUrl,
            catalogId: "cat_abc",
          },
        },
      }),
    ).toEqual({
      kind: "auth-required",
      catalogName: "protected api",
      actionUrl,
      action: "connect_identity_provider",
      providerId: "EntraID",
      catalogId: "cat_abc",
    });
  });

  it("resolves assigned-credential-unavailable structured errors", () => {
    expect(
      resolveToolAuthState({
        rawOutput: {
          archestraError: {
            type: "assigned_credential_unavailable",
            message: "Assigned credential unavailable",
            catalogName: "githubcopilot__remote-mcp",
            catalogId: "cat_123",
          },
        },
      }),
    ).toEqual({
      kind: "assigned-credential-unavailable",
      catalogName: "githubcopilot__remote-mcp",
      message: "Assigned credential unavailable",
      catalogId: "cat_123",
    });
  });

  it("propagates a personal credential scope for structured auth-expired errors", () => {
    expect(
      resolveToolAuthState({
        rawOutput: {
          archestraError: {
            type: "auth_expired",
            message: "Expired",
            catalogName: "GitHub",
            catalogId: "cat_1",
            serverId: "s_1",
            reauthUrl:
              "http://localhost:3000/mcp/registry?reauth=cat_1&server=s_1",
            credentialScope: "personal",
          },
        },
      }),
    ).toEqual({
      kind: "auth-expired",
      catalogName: "GitHub",
      reauthUrl: "http://localhost:3000/mcp/registry?reauth=cat_1&server=s_1",
      catalogId: "cat_1",
      serverId: "s_1",
      credentialScope: "personal",
    });
  });

  it("carries the owning team name for team-scoped auth-expired errors", () => {
    expect(
      resolveToolAuthState({
        rawOutput: {
          archestraError: {
            type: "auth_expired",
            message: "Expired",
            catalogName: "GitHub",
            catalogId: "cat_1",
            serverId: "s_1",
            reauthUrl:
              "http://localhost:3000/mcp/registry?reauth=cat_1&server=s_1",
            credentialScope: "team",
            credentialTeamName: "Platform Team",
          },
        },
      }),
    ).toMatchObject({
      kind: "auth-expired",
      credentialScope: "team",
      credentialTeamName: "Platform Team",
    });
  });

  it("leaves scope undefined for text-parsed expired-auth errors", () => {
    const authState = resolveToolAuthState({
      errorText: [
        'Expired or invalid authentication for "GitHub".',
        "To re-authenticate, please visit: http://localhost:3000/mcp/registry?reauth=cat_1&server=s_1",
      ].join("\n"),
    });

    expect(authState?.kind).toBe("auth-expired");
    expect(
      (authState as { credentialScope?: string }).credentialScope,
    ).toBeUndefined();
  });

  it("parses policy-denied tool errors from errorText", () => {
    const authState = resolveToolAuthState({
      errorText:
        "\nI tried to invoke the my-tool tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nBlocked",
    });

    expect(authState?.kind).toBe("policy-denied");
  });

  it("prefers the structured policy_denied error on rawOutput over prose parsing", () => {
    const authState = resolveToolAuthState({
      rawOutput: {
        structuredContent: {
          archestraError: {
            type: "policy_denied",
            message: "blocked",
            toolName: "archestra_pm__list_tasks",
            input: { list: "week" },
            reason: TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON,
            reasonType: "sensitive_context",
          },
        },
      },
    });

    expect(authState).toEqual({
      kind: "policy-denied",
      policyDenied: {
        type: "tool-archestra_pm__list_tasks",
        toolCallId: "",
        state: "output-denied",
        input: { list: "week" },
        unsafeContextActiveAtRequestStart: true,
        errorText: JSON.stringify({
          reason: TOOL_INVOCATION_UNTRUSTED_CONTEXT_REASON,
        }),
      },
    });
  });

  it("parses auth-required fallbacks from raw string output", () => {
    expect(
      resolveToolAuthState({
        rawOutput:
          'Authentication required for "jira-remote".\n\nNo credentials were found for your account (user: usr_123).\nTo set up your credentials, visit this URL: http://localhost:3000/mcp/registry?install=cat_123',
      }),
    ).toEqual({
      kind: "auth-required",
      catalogName: "jira-remote",
      actionUrl: "http://localhost:3000/mcp/registry?install=cat_123",
      action: "install_mcp_credentials",
      providerId: null,
      catalogId: "cat_123",
    });
  });
});

describe("resolveMcpAppToolCallAuthState", () => {
  const authRequiredError = {
    type: "auth_required",
    message: 'Authentication required for "Slack"',
    catalogName: "Slack",
    catalogId: "cat_slack",
    action: "install_mcp_credentials",
    actionUrl: "http://localhost:3000/mcp/registry?install=cat_slack",
  };

  it("detects the structured auth-required error in _meta on an isError result", () => {
    expect(
      resolveMcpAppToolCallAuthState({
        isError: true,
        content: [{ type: "text", text: authRequiredError.message }],
        _meta: { archestraError: authRequiredError },
      }),
    ).toMatchObject({
      kind: "auth-required",
      catalogName: "Slack",
      actionUrl: authRequiredError.actionUrl,
      catalogId: "cat_slack",
    });
  });

  it("detects the structured error mirrored only in structuredContent", () => {
    expect(
      resolveMcpAppToolCallAuthState({
        isError: true,
        content: [{ type: "text", text: authRequiredError.message }],
        structuredContent: { archestraError: authRequiredError },
      }),
    ).toMatchObject({
      kind: "auth-required",
      actionUrl: authRequiredError.actionUrl,
    });
  });

  it("detects structured auth-expired errors with the reauth URL", () => {
    expect(
      resolveMcpAppToolCallAuthState({
        isError: true,
        content: [{ type: "text", text: "Expired credentials" }],
        _meta: {
          archestraError: {
            type: "auth_expired",
            message: "Expired",
            catalogName: "GitHub",
            catalogId: "cat_github",
            serverId: "srv_1",
            reauthUrl:
              "http://localhost:3000/mcp/registry?reauth=cat_github&server=srv_1",
          },
        },
      }),
    ).toMatchObject({
      kind: "auth-expired",
      catalogName: "GitHub",
      reauthUrl:
        "http://localhost:3000/mcp/registry?reauth=cat_github&server=srv_1",
    });
  });

  it("falls back to parsing the auth prose in text content blocks", () => {
    expect(
      resolveMcpAppToolCallAuthState({
        isError: true,
        content: [
          {
            type: "text",
            text: 'Authentication required for "Slack"\n\nNo credentials were found for your account.\nTo set up your credentials, visit this URL: http://localhost:3000/mcp/registry?install=cat_slack\nOnce you have completed authentication, retry this tool call.',
          },
        ],
      }),
    ).toMatchObject({
      kind: "auth-required",
      catalogName: "Slack",
      actionUrl: "http://localhost:3000/mcp/registry?install=cat_slack",
      catalogId: "cat_slack",
    });
  });

  it("ignores successful results even when they carry auth-like content", () => {
    expect(
      resolveMcpAppToolCallAuthState({
        isError: false,
        content: [{ type: "text", text: authRequiredError.message }],
        _meta: { archestraError: authRequiredError },
      }),
    ).toBeNull();
    expect(
      resolveMcpAppToolCallAuthState({
        content: [{ type: "text", text: authRequiredError.message }],
      }),
    ).toBeNull();
  });

  it("returns null for non-auth tool errors", () => {
    expect(
      resolveMcpAppToolCallAuthState({
        isError: true,
        content: [{ type: "text", text: "Upstream server returned 500" }],
      }),
    ).toBeNull();
  });

  it("returns null for policy-denied errors (no connect affordance)", () => {
    expect(
      resolveMcpAppToolCallAuthState({
        isError: true,
        content: [{ type: "text", text: "blocked" }],
        _meta: {
          archestraError: {
            type: "policy_denied",
            message: "blocked",
            toolName: "some-tool",
            input: {},
            reason: "blocked by policy",
          },
        },
      }),
    ).toBeNull();
  });

  it("returns null for non-object results", () => {
    expect(resolveMcpAppToolCallAuthState(null)).toBeNull();
    expect(resolveMcpAppToolCallAuthState("error text")).toBeNull();
    expect(resolveMcpAppToolCallAuthState(undefined)).toBeNull();
  });
});

describe("resolveAssistantTextAuthState", () => {
  it("returns auth state for assistant auth instructions", () => {
    expect(
      resolveAssistantTextAuthState(
        'Authentication required for "slack-remote".\n\nTo set up your credentials, visit this URL: http://localhost:3000/mcp/registry?install=cat_slack',
      ),
    ).toEqual({
      kind: "auth-required",
      catalogName: "slack-remote",
      actionUrl: "http://localhost:3000/mcp/registry?install=cat_slack",
      action: "install_mcp_credentials",
      providerId: null,
      catalogId: "cat_slack",
    });
  });
});

describe("hasToolPartsWithAuthErrors", () => {
  it("detects auth-related tool errors from message parts", () => {
    expect(
      hasToolPartsWithAuthErrors([
        {
          errorText:
            'Expired or invalid authentication for "github-remote".\n\nTo re-authenticate, visit this URL: http://localhost:3000/mcp/registry?reauth=cat_abc&server=srv_xyz',
        },
      ]),
    ).toBe(true);
  });

  it("detects assigned-credential-unavailable tool errors from structured output", () => {
    expect(
      hasToolPartsWithAuthErrors([
        {
          output: {
            archestraError: {
              type: "assigned_credential_unavailable",
              message: "Assigned credential unavailable",
              catalogName: "githubcopilot__remote-mcp",
              catalogId: "cat_123",
            },
          },
        },
      ]),
    ).toBe(true);
  });

  it("ignores non-auth tool errors", () => {
    expect(
      hasToolPartsWithAuthErrors([
        {
          errorText:
            "\nI tried to invoke the my-tool tool with the following arguments: {}.\n\nHowever, I was denied by a tool invocation policy:\n\nBlocked",
        },
      ]),
    ).toBe(false);
  });
});

describe("isAuthInstructionText", () => {
  it("returns true for auth install instructions", () => {
    expect(
      isAuthInstructionText(
        'Authentication required for "github-remote". Visit this URL: http://localhost:3000/mcp/registry?install=cat_abc',
      ),
    ).toBe(true);
  });

  it("returns false for unrelated text", () => {
    expect(isAuthInstructionText("hello world")).toBe(false);
  });

  it("returns true for credential-assignment guidance", () => {
    expect(
      isAuthInstructionText(
        'Expired / Invalid Authentication: credentials for "github" have expired or are invalid. Re-authenticate to continue using this tool. Ask the agent owner or an admin to re-authenticate.',
      ),
    ).toBe(true);
  });
});

describe("extractIdsFromReauthUrl", () => {
  it("extracts catalog ID and server ID from a manage URL", () => {
    expect(
      extractIdsFromReauthUrl(
        "http://localhost:3000/mcp/registry?reauth=cat_abc&server=srv_xyz",
      ),
    ).toEqual({ catalogId: "cat_abc", serverId: "srv_xyz" });
  });

  it("returns catalogId only when highlight is missing", () => {
    expect(
      extractIdsFromReauthUrl(
        "http://localhost:3000/mcp/registry?reauth=cat_abc",
      ),
    ).toEqual({ catalogId: "cat_abc", serverId: null });
  });

  it("returns nulls when both params are missing", () => {
    expect(
      extractIdsFromReauthUrl("http://localhost:3000/mcp/registry"),
    ).toEqual({ catalogId: null, serverId: null });
  });

  it("returns nulls for an invalid URL", () => {
    expect(extractIdsFromReauthUrl("not-a-url")).toEqual({
      catalogId: null,
      serverId: null,
    });
  });
});

describe("isInstallAuthResolved", () => {
  const installState: ToolAuthState = {
    kind: "auth-required",
    catalogName: "Atlassian Cloud MCP",
    actionUrl: "http://localhost:3000/mcp/registry?install=cat_1",
    action: "install_mcp_credentials",
    providerId: null,
    catalogId: "cat_1",
  };

  it("treats an install prompt as resolved once a server for its catalog is connected", () => {
    expect(
      isInstallAuthResolved({
        authState: installState,
        connectedCatalogIds: new Set(["cat_1"]),
      }),
    ).toBe(true);
  });

  it("stays unresolved while no server for the catalog is connected", () => {
    expect(
      isInstallAuthResolved({
        authState: installState,
        connectedCatalogIds: new Set(["other-catalog"]),
      }),
    ).toBe(false);
  });

  it("ignores identity-provider connect prompts even when the catalog is connected", () => {
    expect(
      isInstallAuthResolved({
        authState: {
          ...installState,
          action: "connect_identity_provider",
          providerId: "EntraID",
        },
        connectedCatalogIds: new Set(["cat_1"]),
      }),
    ).toBe(false);
  });

  it("ignores expired/re-auth prompts even when the catalog is connected", () => {
    expect(
      isInstallAuthResolved({
        authState: {
          kind: "auth-expired",
          catalogName: "Atlassian Cloud MCP",
          reauthUrl:
            "http://localhost:3000/mcp/registry?reauth=cat_1&server=s_1",
          catalogId: "cat_1",
          serverId: "s_1",
        },
        connectedCatalogIds: new Set(["cat_1"]),
      }),
    ).toBe(false);
  });

  it("stays unresolved when the prompt carries no catalog id", () => {
    expect(
      isInstallAuthResolved({
        authState: { ...installState, catalogId: null },
        connectedCatalogIds: new Set(["cat_1"]),
      }),
    ).toBe(false);
  });

  it("stays unresolved when there is no auth state", () => {
    expect(
      isInstallAuthResolved({
        authState: null,
        connectedCatalogIds: new Set(["cat_1"]),
      }),
    ).toBe(false);
  });
});
