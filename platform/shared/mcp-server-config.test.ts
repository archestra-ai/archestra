import { describe, expect, it } from "vitest";
import {
  McpRuntimeTierSettingsSchema,
  resolveMcpRuntimeTiers,
} from "./mcp-runtime-tiers";
import { LocalConfigSchema, OAuthConfigSchema } from "./mcp-server-config";

describe("OAuthConfigSchema", () => {
  const baseOAuthConfig = {
    name: "Direct OAuth MCP",
    server_url: "https://mcp.example.com",
    client_id: "client-id",
    redirect_uris: ["https://app.example.com/oauth-callback"],
    scopes: ["read"],
    default_scopes: ["read", "write"],
    supports_resource_metadata: false,
  };

  it("accepts explicit authorization and token endpoints when both are set", () => {
    expect(() =>
      OAuthConfigSchema.parse({
        ...baseOAuthConfig,
        authorization_endpoint:
          "https://legacy-idp.example.com/oauth/authorize",
        token_endpoint: "https://legacy-idp.example.com/oauth/token",
      }),
    ).not.toThrow();
  });

  it("rejects configs where only one explicit endpoint is set", () => {
    expect(() =>
      OAuthConfigSchema.parse({
        ...baseOAuthConfig,
        authorization_endpoint:
          "https://legacy-idp.example.com/oauth/authorize",
      }),
    ).toThrow("authorization_endpoint and token_endpoint must be set together");
  });

  it("accepts client credentials configs without redirect URIs", () => {
    expect(() =>
      OAuthConfigSchema.parse({
        ...baseOAuthConfig,
        grant_type: "client_credentials",
        redirect_uris: [],
        token_endpoint: "https://legacy-idp.example.com/oauth/token",
      }),
    ).not.toThrow();
  });
});

describe("MCP runtime tiers", () => {
  it("accepts legacy defaults and trims a named tier", () => {
    expect(LocalConfigSchema.parse({ command: "node" })).toEqual({
      command: "node",
    });
    expect(
      LocalConfigSchema.parse({ command: "node", runtimeTier: " S " })
        .runtimeTier,
    ).toBe("S");
  });
  it.each([
    "",
    "  ",
    "x".repeat(33),
  ])("rejects invalid names %j", (runtimeTier) => {
    expect(
      LocalConfigSchema.safeParse({ command: "node", runtimeTier }).success,
    ).toBe(false);
  });
});

describe("independent MCP tiers", () => {
  it("resolves MCP defaults independently with CPU/RAM only", () => {
    expect(resolveMcpRuntimeTiers(null).tiers[0]).toMatchObject({
      name: "S",
      cpuRequest: 0.1,
      cpuLimit: null,
      memoryRequestMiB: 128,
      memoryLimitMiB: 512,
    });
  });
  it("rejects requests above limits, duplicate names, and agent-only fields", () => {
    const tier = {
      name: "S",
      cpuRequest: 0.1,
      cpuLimit: null,
      memoryRequestMiB: 128,
      memoryLimitMiB: 512,
    };
    for (const tiers of [
      [{ ...tier, cpuLimit: 0.05 }],
      [{ ...tier, memoryLimitMiB: 64 }],
      [tier, { ...tier, name: "s" }],
      [{ ...tier, workspaceGiB: 10 }],
      [{ ...tier, pooled: false }],
    ])
      expect(McpRuntimeTierSettingsSchema.safeParse({ tiers }).success).toBe(
        false,
      );
  });
});
