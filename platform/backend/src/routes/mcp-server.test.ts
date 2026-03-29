import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import McpServerUserModel from "@/models/mcp-server-user";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const {
  connectAndGetToolsMock,
  hasPermissionMock,
  inspectServerMock,
  MockMcpServerConnectionTimeoutError,
  MockMcpServerNotReadyError,
} = vi.hoisted(() => ({
  connectAndGetToolsMock: vi.fn(),
  hasPermissionMock: vi.fn(),
  inspectServerMock: vi.fn(),
  MockMcpServerNotReadyError: class MockMcpServerNotReadyError extends Error {},
  MockMcpServerConnectionTimeoutError: class MockMcpServerConnectionTimeoutError extends Error {},
}));

vi.mock("@/clients/mcp-client", () => ({
  McpServerNotReadyError: MockMcpServerNotReadyError,
  McpServerConnectionTimeoutError: MockMcpServerConnectionTimeoutError,
  default: {
    connectAndGetTools: connectAndGetToolsMock,
    inspectServer: inspectServerMock,
  },
}));

vi.mock("@/auth/utils", () => ({
  hasPermission: hasPermissionMock,
}));

describe("mcp server inspect route", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  const originalFetch = global.fetch;

  beforeEach(async ({ makeUser }) => {
    user = await makeUser();
    hasPermissionMock.mockResolvedValue({ success: true });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
    });

    const { default: mcpServerRoutes } = await import("./mcp-server");
    await app.register(mcpServerRoutes);
  });

  afterEach(async () => {
    connectAndGetToolsMock.mockReset();
    hasPermissionMock.mockReset();
    inspectServerMock.mockReset();
    global.fetch = originalFetch;
    await app.close();
  });

  test("automatically retries protected remote MCP server installation with the current identity-provider access token", async ({
    makeAccount,
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Protected Remote",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
    });

    await makeAccount(user.id, {
      providerId: "keycloak",
      accessToken: "session-access-token",
    });

    connectAndGetToolsMock
      .mockRejectedValueOnce(
        new Error(
          'Failed to connect to MCP server Protected Remote: Streamable HTTP error: Error POSTing to endpoint: {"error":"Missing or invalid Authorization header"}',
        ),
      )
      .mockResolvedValueOnce([
        {
          name: "get-server-info",
          description: "Returns server details",
          inputSchema: { type: "object", properties: {} },
        },
      ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "Protected Remote",
        catalogId: catalog.id,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(connectAndGetToolsMock).toHaveBeenCalledTimes(2);
    expect(connectAndGetToolsMock.mock.calls[0][0]).toMatchObject({
      catalogItem: expect.objectContaining({ id: catalog.id }),
      secrets: {},
    });
    expect(connectAndGetToolsMock.mock.calls[1][0]).toMatchObject({
      catalogItem: expect.objectContaining({ id: catalog.id }),
      secrets: { access_token: "session-access-token" },
    });
  });

  test("persists enterprise-managed config on installed MCP servers", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Managed Remote",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
    });

    connectAndGetToolsMock.mockResolvedValueOnce([
      {
        name: "get-server-info",
        description: "Returns server details",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "Managed Remote",
        catalogId: catalog.id,
        enterpriseManagedConfig: {
          requestedCredentialType: "secret",
          resourceIdentifier: "orn:okta:pam:github-secret",
          tokenInjectionMode: "authorization_bearer",
          responseFieldPath: "token",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enterpriseManagedConfig: {
        requestedCredentialType: "secret",
        resourceIdentifier: "orn:okta:pam:github-secret",
        tokenInjectionMode: "authorization_bearer",
        responseFieldPath: "token",
      },
    });
  });

  test("returns 500 when protected remote MCP server installation still lacks usable auth after automatic fallback", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Protected Remote Missing Token",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
    });

    connectAndGetToolsMock.mockRejectedValueOnce(
      new Error(
        'Failed to connect to MCP server Protected Remote Missing Token: Streamable HTTP error: Error POSTing to endpoint: {"error":"Missing or invalid Authorization header"}',
      ),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "Protected Remote Missing Token",
        catalogId: catalog.id,
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: {
        message: expect.stringContaining(
          "Missing or invalid Authorization header",
        ),
      },
    });
    expect(connectAndGetToolsMock).toHaveBeenCalledTimes(1);
  });

  test("refreshes an expired linked identity-provider access token before retrying installation discovery", async ({
    makeAccount,
    makeIdentityProvider,
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Protected Remote Refresh",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
    });

    await makeIdentityProvider(user.id, {
      providerId: "keycloak",
      issuer: "http://localhost:30081/realms/archestra",
      oidcConfig: {
        clientId: "archestra-oidc",
        clientSecret: "archestra-oidc-secret",
        tokenEndpoint:
          "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
        tokenEndpointAuthentication: "client_secret_post",
      },
    });

    const account = await makeAccount(user.id, {
      providerId: "keycloak",
      accessToken: "expired-session-access-token",
      refreshToken: "refresh-token-123",
    });
    await db
      .update(schema.accountsTable)
      .set({
        accessTokenExpiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(schema.accountsTable.id, account.id));

    await app.inject({
      method: "GET",
      url: "/api/mcp_server",
    });

    global.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (
        url ===
        "http://localhost:30081/realms/archestra/protocol/openid-connect/token"
      ) {
        return new Response(
          JSON.stringify({
            access_token: "refreshed-access-token",
            refresh_token: "refreshed-refresh-token",
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }) as typeof fetch;

    connectAndGetToolsMock
      .mockRejectedValueOnce(
        new Error(
          'Failed to connect to MCP server Protected Remote Refresh: Streamable HTTP error: Error POSTing to endpoint: {"error":"Missing or invalid Authorization header"}',
        ),
      )
      .mockResolvedValueOnce([
        {
          name: "get-server-info",
          description: "Returns server details",
          inputSchema: { type: "object", properties: {} },
        },
      ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "Protected Remote Refresh",
        catalogId: catalog.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(connectAndGetToolsMock).toHaveBeenCalledTimes(2);
    expect(connectAndGetToolsMock.mock.calls[1][0]).toMatchObject({
      secrets: { access_token: "refreshed-access-token" },
    });
  });

  test("refreshes an expired linked identity-provider access token with client_secret_basic authentication", async ({
    makeAccount,
    makeIdentityProvider,
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Protected Remote Basic Refresh",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
    });

    await makeIdentityProvider(user.id, {
      providerId: "keycloak-basic",
      issuer: "http://localhost:30081/realms/archestra",
      oidcConfig: {
        clientId: "archestra-oidc",
        clientSecret: "archestra-oidc-secret",
        tokenEndpoint:
          "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
        tokenEndpointAuthentication: "client_secret_basic",
      },
    });

    const account = await makeAccount(user.id, {
      providerId: "keycloak-basic",
      accessToken: "expired-session-access-token",
      refreshToken: "refresh-token-123",
    });
    await db
      .update(schema.accountsTable)
      .set({
        accessTokenExpiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(schema.accountsTable.id, account.id));

    global.fetch = vi.fn(async (_input, init) => {
      expect(init?.headers).toBeInstanceOf(Headers);
      const headers = init?.headers as Headers;
      expect(headers.get("Authorization")).toBe(
        `Basic ${Buffer.from("archestra-oidc:archestra-oidc-secret").toString("base64")}`,
      );
      const body = init?.body as URLSearchParams;
      expect(body.get("client_id")).toBeNull();
      expect(body.get("client_secret")).toBeNull();
      expect(body.get("refresh_token")).toBe("refresh-token-123");

      return new Response(
        JSON.stringify({
          access_token: "refreshed-basic-access-token",
          refresh_token: "refreshed-basic-refresh-token",
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    connectAndGetToolsMock
      .mockRejectedValueOnce(
        new Error(
          'Failed to connect to MCP server Protected Remote Basic Refresh: Streamable HTTP error: Error POSTing to endpoint: {"error":"Missing or invalid Authorization header"}',
        ),
      )
      .mockResolvedValueOnce([
        {
          name: "get-server-info",
          description: "Returns server details",
          inputSchema: { type: "object", properties: {} },
        },
      ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "Protected Remote Basic Refresh",
        catalogId: catalog.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(connectAndGetToolsMock.mock.calls[1][0]).toMatchObject({
      secrets: { access_token: "refreshed-basic-access-token" },
    });
  });

  test("does not retry installation discovery when the linked refresh token is expired", async ({
    makeAccount,
    makeIdentityProvider,
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Protected Remote Expired Refresh Token",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
    });

    await makeIdentityProvider(user.id, {
      providerId: "keycloak",
      issuer: "http://localhost:30081/realms/archestra",
      oidcConfig: {
        clientId: "archestra-oidc",
        clientSecret: "archestra-oidc-secret",
        tokenEndpoint:
          "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
        tokenEndpointAuthentication: "client_secret_post",
      },
    });

    const account = await makeAccount(user.id, {
      providerId: "keycloak",
      accessToken: "expired-session-access-token",
      refreshToken: "expired-refresh-token",
    });
    await db
      .update(schema.accountsTable)
      .set({
        accessTokenExpiresAt: new Date(Date.now() - 60_000),
        refreshTokenExpiresAt: new Date(Date.now() - 30_000),
      })
      .where(eq(schema.accountsTable.id, account.id));

    connectAndGetToolsMock.mockRejectedValueOnce(
      new Error(
        'Failed to connect to MCP server Protected Remote Expired Refresh Token: Streamable HTTP error: Error POSTing to endpoint: {"error":"Missing or invalid Authorization header"}',
      ),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "Protected Remote Expired Refresh Token",
        catalogId: catalog.id,
      },
    });

    expect(response.statusCode).toBe(500);
    expect(connectAndGetToolsMock).toHaveBeenCalledTimes(1);
  });

  test("does not retry installation discovery when the linked identity provider cannot refresh the expired token", async ({
    makeAccount,
    makeIdentityProvider,
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Protected Remote Unsupported Refresh",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
    });

    await makeIdentityProvider(user.id, {
      providerId: "okta",
      issuer: "https://example.okta.com/oauth2/default",
      oidcConfig: {
        clientId: "okta-client-id",
        tokenEndpoint: "https://example.okta.com/oauth2/default/v1/token",
        tokenEndpointAuthentication: "private_key_jwt",
      },
    });

    const account = await makeAccount(user.id, {
      providerId: "okta",
      accessToken: "expired-session-access-token",
      refreshToken: "refresh-token-123",
    });
    await db
      .update(schema.accountsTable)
      .set({
        accessTokenExpiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(schema.accountsTable.id, account.id));

    connectAndGetToolsMock.mockRejectedValueOnce(
      new Error(
        'Failed to connect to MCP server Protected Remote Unsupported Refresh: Streamable HTTP error: Error POSTing to endpoint: {"error":"Missing or invalid Authorization header"}',
      ),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "Protected Remote Unsupported Refresh",
        catalogId: catalog.id,
      },
    });

    expect(response.statusCode).toBe(500);
    expect(connectAndGetToolsMock).toHaveBeenCalledTimes(1);
  });

  test("returns 409 when the MCP server is not running yet", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({ serverType: "local" });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });

    inspectServerMock.mockRejectedValueOnce(
      new MockMcpServerNotReadyError(
        "MCP server is not running yet. Start or restart it, then try inspecting it again.",
      ),
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/inspect`,
      payload: { method: "tools/list" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        message:
          "MCP server is not running yet. Start or restart it, then try inspecting it again.",
        type: "api_conflict_error",
      },
    });
  });

  test("returns 409 when the MCP server times out during inspection", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({ serverType: "local" });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });

    inspectServerMock.mockRejectedValueOnce(
      new MockMcpServerConnectionTimeoutError(
        "MCP server did not become reachable within 30 seconds. Verify its configuration and runtime logs, then try again.",
      ),
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/inspect`,
      payload: { method: "tools/list" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        message:
          "MCP server did not become reachable within 30 seconds. Verify its configuration and runtime logs, then try again.",
        type: "api_conflict_error",
      },
    });
  });

  test("keeps unexpected inspect failures as 502 responses", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({ serverType: "local" });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });

    inspectServerMock.mockRejectedValueOnce(new Error("Unexpected failure"));

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/inspect`,
      payload: { method: "tools/list" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        message: "Failed to inspect MCP server: Unexpected failure",
        type: "unknown_api_error",
      },
    });
  });

  test("re-authenticates a remote MCP server with provided user config values", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Remote Reauth Server",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    connectAndGetToolsMock.mockResolvedValueOnce([
      {
        name: "get-server-info",
        description: "Returns server details",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/mcp_server/${mcpServer.id}/reauthenticate`,
      payload: {
        userConfigValues: {
          api_key: "secret-value",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(connectAndGetToolsMock).toHaveBeenCalledTimes(1);
    expect(connectAndGetToolsMock.mock.calls[0][0]).toMatchObject({
      catalogItem: expect.objectContaining({ id: catalog.id }),
      mcpServerId: "validation",
    });
    expect(response.json()).toMatchObject({
      id: mcpServer.id,
      oauthRefreshError: null,
      oauthRefreshFailedAt: null,
    });
  });
});
