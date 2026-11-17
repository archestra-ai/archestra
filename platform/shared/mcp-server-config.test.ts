import { describe, expect, it } from "vitest";
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

describe("MCP container resources", () => {
  it("preserves overrides and accepts legacy configurations without them", () => {
    expect(LocalConfigSchema.parse({ command: "node" })).toEqual({
      command: "node",
    });
    const resources = {
      cpuRequest: 0.001,
      cpuLimit: null,
      memoryRequestMiB: 64,
      memoryLimitMiB: 128,
    };
    expect(
      LocalConfigSchema.parse({ command: "node", resources }).resources,
    ).toEqual(resources);
  });

  it.each([
    { cpuRequest: 0 },
    { cpuRequest: 0.0001 },
    { cpuLimit: -1 },
    { cpuRequest: 2, cpuLimit: 1 },
    { memoryRequestMiB: 1.5 },
    { memoryLimitMiB: 0 },
    { memoryRequestMiB: 256, memoryLimitMiB: 128 },
  ])("rejects invalid or unschedulable overrides: %j", (resources) => {
    expect(
      LocalConfigSchema.safeParse({ command: "node", resources }).success,
    ).toBe(false);
  });
});
