import { OAUTH_TOKEN_TYPE } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import { hasPermission, userHasPermission } from "@/auth/utils";
import db, { schema } from "@/database";
import { McpServerModel } from "@/models";
import McpServerUserModel from "@/models/mcp-server-user";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const {
  connectAndGetToolsMock,
  exchangeEnterpriseManagedCredentialMock,
  invalidateConnectionsForServerMock,
  inspectServerMock,
  k8sGetOrLoadDeploymentMock,
  k8sRestartServerMock,
  k8sStartServerMock,
  k8sStopServerMock,
  MockMcpServerConnectionTimeoutError,
  MockMcpServerNotReadyError,
} = vi.hoisted(() => ({
  connectAndGetToolsMock: vi.fn(),
  exchangeEnterpriseManagedCredentialMock: vi.fn(),
  invalidateConnectionsForServerMock: vi.fn(),
  inspectServerMock: vi.fn(),
  k8sGetOrLoadDeploymentMock: vi.fn(),
  k8sRestartServerMock: vi.fn(),
  k8sStartServerMock: vi.fn(),
  k8sStopServerMock: vi.fn(),
  MockMcpServerNotReadyError: class MockMcpServerNotReadyError extends Error {},
  MockMcpServerConnectionTimeoutError: class MockMcpServerConnectionTimeoutError extends Error {},
}));

vi.mock("@/clients/mcp-client", () => ({
  McpServerNotReadyError: MockMcpServerNotReadyError,
  McpServerConnectionTimeoutError: MockMcpServerConnectionTimeoutError,
  default: {
    connectAndGetTools: connectAndGetToolsMock,
    invalidateConnectionsForServer: invalidateConnectionsForServerMock,
    inspectServer: inspectServerMock,
  },
}));

vi.mock("@/services/identity-providers/enterprise-managed/exchange", () => ({
  exchangeEnterpriseManagedCredential: exchangeEnterpriseManagedCredentialMock,
}));

vi.mock("@/auth/utils");

vi.mock("@/k8s/mcp-server-runtime", () => ({
  McpServerRuntimeManager: {
    isEnabled: true,
    startServer: k8sStartServerMock,
    restartServer: k8sRestartServerMock,
    stopServer: k8sStopServerMock,
    getOrLoadDeployment: k8sGetOrLoadDeploymentMock,
  },
}));

const hasPermissionMock = vi.mocked(hasPermission);
const userHasPermissionMock = vi.mocked(userHasPermission);

// Wait for the reinstall route's `setImmediate`-scheduled background work
// to flip the install row off "pending". Fails the test if it doesn't —
// without this assertion a stalled async reinstall would exit the polling
// loop silently and leak into the next test in the file.
async function drainPendingReinstall(mcpServerId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [serverRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, mcpServerId));

    if (!serverRow) {
      throw new Error(
        `drainPendingReinstall(${mcpServerId}): mcp_server row not found`,
      );
    }
    if (serverRow.localInstallationStatus !== "pending") {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `drainPendingReinstall(${mcpServerId}) timed out after 2s — background reinstall did not complete`,
  );
}

describe("mcp server inspect route", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  const originalFetch = global.fetch;

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organization.id);
    hasPermissionMock.mockResolvedValue({ success: true, error: null });
    userHasPermissionMock.mockResolvedValue(true);
    k8sStartServerMock.mockResolvedValue(undefined);
    k8sRestartServerMock.mockResolvedValue(undefined);
    k8sStopServerMock.mockResolvedValue(undefined);
    k8sGetOrLoadDeploymentMock.mockResolvedValue({
      waitForDeploymentReady: vi.fn().mockResolvedValue(undefined),
    });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          user: User;
          organizationId: string;
        }
      ).user = user;
      (
        request as typeof request & {
          user: User;
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: mcpServerRoutes } = await import("./mcp-server");
    await app.register(mcpServerRoutes);
  });

  afterEach(async () => {
    connectAndGetToolsMock.mockReset();
    exchangeEnterpriseManagedCredentialMock.mockReset();
    hasPermissionMock.mockReset();
    invalidateConnectionsForServerMock.mockReset();
    inspectServerMock.mockReset();
    k8sGetOrLoadDeploymentMock.mockReset();
    k8sRestartServerMock.mockReset();
    k8sStartServerMock.mockReset();
    k8sStopServerMock.mockReset();
    userHasPermissionMock.mockReset();
    global.fetch = originalFetch;
    await app.close();
  });

  async function expectInaccessibleServerHidden(params: {
    makeInternalMcpCatalog: (
      args?: Record<string, unknown>,
    ) => Promise<{ id: string }>;
    makeMcpServer: (args: {
      ownerId: string;
      catalogId: string;
    }) => Promise<{ id: string }>;
    makeUser: (args?: Record<string, unknown>) => Promise<{ id: string }>;
    method: "GET" | "POST";
    urlBuilder: (id: string) => string;
    payload?: Record<string, unknown>;
  }) {
    const otherUser = await params.makeUser({ email: "other@example.com" });
    const catalog = await params.makeInternalMcpCatalog({
      organizationId,
      serverType: "local",
    });
    const mcpServer = await params.makeMcpServer({
      ownerId: otherUser.id,
      catalogId: catalog.id,
    });

    hasPermissionMock.mockResolvedValueOnce({ success: false, error: null });

    const response = await app.inject({
      method: params.method,
      url: params.urlBuilder(mcpServer.id),
      payload: params.payload,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        message: "MCP server not found",
        type: "api_not_found_error",
      },
    });
  }

  test("hides inaccessible MCP servers on installation-status", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
  }) => {
    await expectInaccessibleServerHidden({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      method: "GET",
      urlBuilder: (id) => `/api/mcp_server/${id}/installation-status`,
    });
  });

  test("hides inaccessible MCP servers on tools", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
  }) => {
    await expectInaccessibleServerHidden({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      method: "GET",
      urlBuilder: (id) => `/api/mcp_server/${id}/tools`,
    });
  });

  test("hides inaccessible MCP servers on inspect", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
  }) => {
    await expectInaccessibleServerHidden({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      method: "POST",
      urlBuilder: (id) => `/api/mcp_server/${id}/inspect`,
      payload: { method: "tools/list" },
    });
  });

  test("filters team-installed connections by selected assignment team", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTeam,
    makeTeamMember,
  }) => {
    hasPermissionMock.mockResolvedValueOnce({ success: false, error: null });

    const selectedTeam = await makeTeam(organizationId, user.id, {
      name: "Selected Team",
    });
    const otherTeam = await makeTeam(organizationId, user.id, {
      name: "Other Team",
    });
    await makeTeamMember(selectedTeam.id, user.id);
    await makeTeamMember(otherTeam.id, user.id);

    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "remote",
    });
    const selectedServer = await makeMcpServer({
      scope: "team",
      ownerId: user.id,
      catalogId: catalog.id,
      teamId: selectedTeam.id,
    });
    await makeMcpServer({
      scope: "team",
      ownerId: user.id,
      catalogId: catalog.id,
      teamId: otherTeam.id,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/mcp_server?assignmentScope=team&assignmentTeamIds=${selectedTeam.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().map((server: { id: string }) => server.id)).toEqual([
      selectedServer.id,
    ]);
  });

  test("filters out personal connections whose owner is not in the selected assignment team", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    hasPermissionMock.mockResolvedValueOnce({ success: true, error: null });

    const otherUser = await makeUser({ email: "other-owner@example.com" });
    const selectedTeam = await makeTeam(organizationId, user.id, {
      name: "Selected Team",
    });
    await makeTeamMember(selectedTeam.id, user.id);

    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "remote",
    });
    const ownPersonalServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await makeMcpServer({
      ownerId: otherUser.id,
      catalogId: catalog.id,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/mcp_server?assignmentScope=team&assignmentTeamIds=${selectedTeam.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().map((server: { id: string }) => server.id)).toEqual([
      ownPersonalServer.id,
    ]);
  });

  test("filters personal connections by organization membership for org assignment scope", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    hasPermissionMock.mockResolvedValueOnce({ success: true, error: null });

    const organization = await makeOrganization();
    organizationId = organization.id;
    const memberOwner = await makeUser({ email: "member-owner@example.com" });
    const outsideOwner = await makeUser({ email: "outside-owner@example.com" });
    await makeMember(memberOwner.id, organization.id, { role: "member" });

    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "remote",
    });
    const memberOwnedServer = await makeMcpServer({
      ownerId: memberOwner.id,
      catalogId: catalog.id,
    });
    const orgOwnedServer = await makeMcpServer({
      catalogId: catalog.id,
    });
    await makeMcpServer({
      ownerId: outsideOwner.id,
      catalogId: catalog.id,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/mcp_server?assignmentScope=org",
    });

    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .map((server: { id: string }) => server.id)
        .sort(),
    ).toEqual([memberOwnedServer.id, orgOwnedServer.id].sort());
  });

  test("filters connections for personal assignment scope", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    hasPermissionMock.mockResolvedValueOnce({ success: true, error: null });

    const organization = await makeOrganization();
    organizationId = organization.id;
    const otherUser = await makeUser({ email: "personal-other@example.com" });
    const authorTeam = await makeTeam(organization.id, user.id, {
      name: "Author Team",
    });
    const otherTeam = await makeTeam(organization.id, user.id, {
      name: "Other Team",
    });
    await makeTeamMember(authorTeam.id, user.id);

    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "remote",
    });
    const ownPersonalServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await makeMcpServer({
      ownerId: otherUser.id,
      catalogId: catalog.id,
    });
    const authorTeamServer = await makeMcpServer({
      ownerId: otherUser.id,
      catalogId: catalog.id,
      teamId: authorTeam.id,
    });
    await makeMcpServer({
      ownerId: otherUser.id,
      catalogId: catalog.id,
      teamId: otherTeam.id,
    });
    const orgOwnedServer = await makeMcpServer({
      catalogId: catalog.id,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/mcp_server?assignmentScope=personal",
    });

    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .map((server: { id: string }) => server.id)
        .sort(),
    ).toEqual(
      [ownPersonalServer.id, authorTeamServer.id, orgOwnedServer.id].sort(),
    );
  });

  test("automatically retries protected remote MCP server installation with the current identity-provider access token", async ({
    makeAccount,
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
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

  test("installs a remote MCP server with static additional headers from the catalog", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Static Header Remote",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
      userConfig: {
        header_x_api_key: {
          type: "string",
          title: "x-api-key",
          description: "Static API key",
          promptOnInstallation: false,
          required: false,
          sensitive: false,
          headerName: "x-api-key",
          default: "catalog-api-key",
        },
      },
    });

    connectAndGetToolsMock
      .mockResolvedValueOnce([
        {
          name: "get-server-info",
          description: "Returns server details",
          inputSchema: { type: "object", properties: {} },
        },
      ])
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
        name: "Static Header Remote",
        catalogId: catalog.id,
        userConfigValues: {
          header_x_api_key: "installer-override",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(connectAndGetToolsMock).toHaveBeenCalledTimes(2);
    expect(connectAndGetToolsMock.mock.calls[0][0]).toMatchObject({
      catalogItem: expect.objectContaining({ id: catalog.id }),
      secrets: {
        header_x_api_key: "catalog-api-key",
      },
    });
  });

  test("installs a remote MCP server with mixed static and prompted headers", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Mixed Header Remote",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
      userConfig: {
        header_x_api_key: {
          type: "string",
          title: "x-api-key",
          description: "Static API key",
          promptOnInstallation: false,
          required: false,
          sensitive: false,
          headerName: "x-api-key",
          default: "catalog-api-key",
        },
        tenant_id: {
          type: "string",
          title: "Tenant ID",
          description: "Prompted tenant ID",
          promptOnInstallation: true,
          required: true,
          sensitive: false,
          headerName: "x-tenant-id",
        },
      },
    });

    connectAndGetToolsMock
      .mockResolvedValueOnce([
        {
          name: "get-server-info",
          description: "Returns server details",
          inputSchema: { type: "object", properties: {} },
        },
      ])
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
        name: "Mixed Header Remote",
        catalogId: catalog.id,
        userConfigValues: {
          tenant_id: "tenant-42",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(connectAndGetToolsMock).toHaveBeenCalledTimes(2);
    expect(connectAndGetToolsMock.mock.calls[0][0]).toMatchObject({
      catalogItem: expect.objectContaining({ id: catalog.id }),
      secrets: {
        header_x_api_key: "catalog-api-key",
        tenant_id: "tenant-42",
      },
    });
  });

  test("ignores unknown install user config keys when creating the secret payload", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Known Header Remote",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
      userConfig: {
        tenant_id: {
          type: "string",
          title: "Tenant ID",
          description: "Prompted tenant ID",
          promptOnInstallation: true,
          required: true,
          sensitive: false,
          headerName: "x-tenant-id",
        },
      },
    });

    connectAndGetToolsMock
      .mockResolvedValueOnce([
        {
          name: "get-server-info",
          description: "Returns server details",
          inputSchema: { type: "object", properties: {} },
        },
      ])
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
        name: "Known Header Remote",
        catalogId: catalog.id,
        userConfigValues: {
          tenant_id: "tenant-42",
          unknown_key: "should-be-dropped",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(connectAndGetToolsMock).toHaveBeenCalledTimes(2);
    expect(connectAndGetToolsMock.mock.calls[0][0]).toMatchObject({
      catalogItem: expect.objectContaining({ id: catalog.id }),
      secrets: {
        tenant_id: "tenant-42",
      },
    });
    expect(
      (
        connectAndGetToolsMock.mock.calls[0]?.[0] as {
          secrets?: Record<string, unknown>;
        }
      ).secrets,
    ).not.toHaveProperty("unknown_key");
  });

  test("installs a local MCP server with prompted header user config", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Local Header Server",
      serverType: "local",
      userConfig: {
        header_x_api_key: {
          type: "string",
          title: "x-api-key",
          description: "Prompted header",
          promptOnInstallation: true,
          required: true,
          sensitive: false,
          headerName: "x-api-key",
        },
      },
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "Local Header Server",
        catalogId: catalog.id,
        userConfigValues: {
          header_x_api_key: "header-value",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(k8sStartServerMock).toHaveBeenCalledTimes(1);
    expect(k8sStartServerMock.mock.calls[0]?.[1]).toEqual({
      header_x_api_key: "header-value",
    });
  });

  test("installs a local MCP server with both secret env vars and prompted header user config", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Local Mixed Secret Server",
      serverType: "local",
      userConfig: {
        tenant_id: {
          type: "string",
          title: "Tenant ID",
          description: "Prompted header",
          promptOnInstallation: true,
          required: true,
          sensitive: false,
          headerName: "x-tenant-id",
        },
      },
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "API_KEY",
            type: "secret",
            promptOnInstallation: false,
            value: "catalog-secret",
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "Local Mixed Secret Server",
        catalogId: catalog.id,
        userConfigValues: {
          tenant_id: "tenant-42",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const [installedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.catalogId, catalog.id));

    expect(installedServer?.secretId).toBeTruthy();
    if (!installedServer?.secretId) {
      throw new Error("Expected local install to persist a secretId");
    }

    const storedSecret = await secretManager().getSecret(
      installedServer.secretId,
    );
    expect(storedSecret?.secret).toMatchObject({
      API_KEY: "catalog-secret",
      tenant_id: "tenant-42",
    });
  });

  test("installs a local streamable-http MCP server with static additional headers from the catalog", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Local Static Header Server",
      serverType: "local",
      userConfig: {
        header_x_api_key: {
          type: "string",
          title: "x-api-key",
          description: "Static API key",
          promptOnInstallation: false,
          required: false,
          sensitive: false,
          headerName: "x-api-key",
          default: "catalog-api-key",
        },
      },
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "Local Static Header Server",
        catalogId: catalog.id,
      },
    });

    expect(response.statusCode).toBe(200);
    const [installedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.catalogId, catalog.id));

    expect(installedServer?.secretId).toBeTruthy();
    if (!installedServer?.secretId) {
      throw new Error("Expected local install to persist a secretId");
    }

    const storedSecret = await secretManager().getSecret(
      installedServer.secretId,
    );
    expect(storedSecret?.secret).toMatchObject({
      header_x_api_key: "catalog-api-key",
    });
  });

  test("local install ignores unknown user config keys and preserves catalog static headers", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Local Filtered Header Server",
      serverType: "local",
      userConfig: {
        header_x_api_key: {
          type: "string",
          title: "x-api-key",
          description: "Static API key",
          promptOnInstallation: false,
          required: false,
          sensitive: false,
          headerName: "x-api-key",
          default: "catalog-api-key",
        },
        tenant_id: {
          type: "string",
          title: "Tenant ID",
          description: "Prompted tenant ID",
          promptOnInstallation: true,
          required: true,
          sensitive: false,
          headerName: "x-tenant-id",
        },
      },
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "Local Filtered Header Server",
        catalogId: catalog.id,
        userConfigValues: {
          header_x_api_key: "installer-override",
          tenant_id: "tenant-42",
          unknown_key: "should-be-dropped",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const [installedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.catalogId, catalog.id));

    expect(installedServer?.secretId).toBeTruthy();
    if (!installedServer?.secretId) {
      throw new Error("Expected local install to persist a secretId");
    }

    const storedSecret = await secretManager().getSecret(
      installedServer.secretId,
    );
    expect(storedSecret?.secret).toMatchObject({
      header_x_api_key: "catalog-api-key",
      tenant_id: "tenant-42",
    });
    expect(storedSecret?.secret).not.toHaveProperty("unknown_key");
  });

  test("reinstalls a local MCP server with prompted header user config", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Local Header Reinstall",
      serverType: "local",
      userConfig: {
        header_x_api_key: {
          type: "string",
          title: "x-api-key",
          description: "Prompted header",
          promptOnInstallation: true,
          required: true,
          sensitive: false,
          headerName: "x-api-key",
        },
      },
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: {
        userConfigValues: {
          header_x_api_key: "header-value",
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const [updatedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, mcpServer.id));

    expect(updatedServer?.secretId).toBeTruthy();
    if (!updatedServer?.secretId) {
      throw new Error("Expected reinstall to persist a secretId");
    }

    const storedSecret = await secretManager().getSecret(
      updatedServer.secretId,
    );
    expect(storedSecret?.secret).toMatchObject({
      header_x_api_key: "header-value",
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const [serverRow] = await db
        .select()
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.id, mcpServer.id));

      if (serverRow?.localInstallationStatus !== "pending") {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  test("local reinstall ignores unknown keys and installer overrides for catalog static headers", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Local Reinstall Filtered Header Server",
      serverType: "local",
      userConfig: {
        header_x_api_key: {
          type: "string",
          title: "x-api-key",
          description: "Static API key",
          promptOnInstallation: false,
          required: false,
          sensitive: false,
          headerName: "x-api-key",
          default: "catalog-api-key",
        },
        tenant_id: {
          type: "string",
          title: "Tenant ID",
          description: "Prompted tenant ID",
          promptOnInstallation: true,
          required: true,
          sensitive: false,
          headerName: "x-tenant-id",
        },
      },
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: {
        userConfigValues: {
          header_x_api_key: "installer-override",
          tenant_id: "tenant-42",
          unknown_key: "should-be-dropped",
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const [updatedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, mcpServer.id));

    expect(updatedServer?.secretId).toBeTruthy();
    if (!updatedServer?.secretId) {
      throw new Error("Expected reinstall to persist a secretId");
    }

    const storedSecret = await secretManager().getSecret(
      updatedServer.secretId,
    );
    expect(storedSecret?.secret).toMatchObject({
      header_x_api_key: "catalog-api-key",
      tenant_id: "tenant-42",
    });
    expect(storedSecret?.secret).not.toHaveProperty("unknown_key");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const [serverRow] = await db
        .select()
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.id, mcpServer.id));

      if (serverRow?.localInstallationStatus !== "pending") {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  test("rejects reinstall of another user's personal connection by an editor", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
  }) => {
    const otherUser = await makeUser({ email: "reinstall-owner@example.com" });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
    });
    const mcpServer = await makeMcpServer({
      ownerId: otherUser.id,
      catalogId: catalog.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: { userConfigValues: { api_key: "attacker-value" } },
    });

    expect(response.statusCode).toBe(403);
    expect(connectAndGetToolsMock).not.toHaveBeenCalled();
  });

  // Regression: the reinstall route used to short-circuit value persistence
  // for remote serverType, dropping any `userConfigValues` in the request
  // body. End-user symptom was an admin adding a new required header to a
  // remote catalog, clicking Reinstall, and the pod coming back with no
  // value for the new header.
  test("reinstall of a remote MCP server persists userConfigValues into the install's secret", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Remote Reinstall With New Required Header",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
      userConfig: {
        header_x_api_key: {
          type: "string",
          title: "x-api-key",
          description: "Newly-required header added on a catalog edit",
          promptOnInstallation: true,
          required: true,
          sensitive: true,
          headerName: "x-api-key",
        },
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    // makeMcpServer hardcodes `serverType: "local"`; force remote so this
    // test exercises the remote code path of the route.
    await db
      .update(schema.mcpServersTable)
      .set({ serverType: "remote" })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: {
        userConfigValues: {
          header_x_api_key: "fresh-header-value",
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const [updatedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, mcpServer.id));

    expect(updatedServer?.secretId).toBeTruthy();
    if (!updatedServer?.secretId) {
      throw new Error("Expected reinstall to persist a secretId");
    }

    const storedSecret = await secretManager().getSecret(
      updatedServer.secretId,
    );
    expect(storedSecret?.secret).toMatchObject({
      header_x_api_key: "fresh-header-value",
    });

    // Drain the route's setImmediate-deferred reinstall so background
    // work doesn't leak into the next test in the file. The local-
    // reinstall test above uses 200ms total, but the remote path runs
    // autoReinstallServer with a tool-fetch that takes longer when
    // mocks aren't pre-primed — give it 2s so we don't leak a
    // "pending" install whose async error fires inside the next test.
    await drainPendingReinstall(mcpServer.id);
  });

  // A partial reinstall (user fills only a newly-added required header) must
  // not 400 on a required header whose value is already on the install's bag.
  test("reinstall accepts a body that omits required userConfig fields already on the install's secret bag", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Remote Reinstall Required UserConfig From Bag",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
      userConfig: {
        header_existing: {
          type: "string",
          title: "x-existing",
          description: "Existing header set at original install",
          promptOnInstallation: true,
          required: true,
          sensitive: false,
          headerName: "x-existing",
        },
        header_new: {
          type: "string",
          title: "x-new",
          description: "New header added in a catalog edit",
          promptOnInstallation: true,
          required: true,
          sensitive: false,
          headerName: "x-new",
        },
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await db
      .update(schema.mcpServersTable)
      .set({ serverType: "remote" })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    const existingBag = await secretManager().createSecret(
      { header_existing: "on-the-bag" },
      `${mcpServer.name}-existing-bag`,
    );
    await db
      .update(schema.mcpServersTable)
      .set({ secretId: existingBag.id })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: {
        userConfigValues: { header_new: "user-fills-only-the-new-one" },
      },
    });

    expect(response.statusCode).toBe(200);

    const [updatedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    expect(updatedServer?.secretId).toBeTruthy();

    const storedSecret = await secretManager().getSecret(
      updatedServer.secretId!,
    );
    expect(storedSecret?.secret).toMatchObject({
      header_existing: "on-the-bag",
      header_new: "user-fills-only-the-new-one",
    });

    await drainPendingReinstall(mcpServer.id);
  });

  // An explicit empty string clears an optional userConfig field from the bag
  // while leaving unrelated entries (OAuth tokens, etc.) untouched.
  test("reinstall body with empty string for an optional userConfig field deletes it from the bag", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Remote Reinstall Optional UserConfig Clear",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
      userConfig: {
        header_optional: {
          type: "string",
          title: "x-optional",
          description: "Optional header the user can clear",
          promptOnInstallation: true,
          required: false,
          sensitive: false,
          headerName: "x-optional",
        },
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await db
      .update(schema.mcpServersTable)
      .set({ serverType: "remote" })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    const existingBag = await secretManager().createSecret(
      { header_optional: "to-be-cleared", unrelated_key: "keep-me" },
      `${mcpServer.name}-existing-bag`,
    );
    await db
      .update(schema.mcpServersTable)
      .set({ secretId: existingBag.id })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: { userConfigValues: { header_optional: "" } },
    });

    expect(response.statusCode).toBe(200);

    const [updatedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    const storedSecret = await secretManager().getSecret(
      updatedServer.secretId!,
    );
    expect(storedSecret?.secret).not.toHaveProperty("header_optional");
    // Unrelated bag entries (OAuth tokens, etc.) must stay put.
    expect(storedSecret?.secret).toMatchObject({ unrelated_key: "keep-me" });

    await drainPendingReinstall(mcpServer.id);
  });

  // A whitespace-only submission for a required userConfig field passes
  // validation via the existing-bag fallback; it must not then overwrite the
  // stored header with whitespace.
  test("reinstall ignores a whitespace-only userConfig submission and keeps the stored value", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Remote Reinstall Whitespace UserConfig",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
      userConfig: {
        header_required: {
          type: "string",
          title: "x-required",
          description: "Required header already set at install",
          promptOnInstallation: true,
          required: true,
          sensitive: false,
          headerName: "x-required",
        },
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await db
      .update(schema.mcpServersTable)
      .set({ serverType: "remote" })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    const existingBag = await secretManager().createSecret(
      { header_required: "valid-value" },
      `${mcpServer.name}-existing-bag`,
    );
    await db
      .update(schema.mcpServersTable)
      .set({ secretId: existingBag.id })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: { userConfigValues: { header_required: "   " } },
    });

    expect(response.statusCode).toBe(200);

    const [updatedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    const storedSecret = await secretManager().getSecret(
      updatedServer.secretId!,
    );
    expect(storedSecret?.secret).toMatchObject({
      header_required: "valid-value",
    });

    await drainPendingReinstall(mcpServer.id);
  });

  // Required-userConfig validation runs even on an empty body, so a newly-added
  // required connection setting that nothing satisfies fails fast with 400
  // rather than starting the server on stale config.
  test("reinstall with an empty body 400s when a required userConfig field is unsatisfied", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Remote Reinstall Empty Body Missing UserConfig",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
      userConfig: {
        header_required: {
          type: "string",
          title: "x-required",
          description: "Required header with no value anywhere yet",
          promptOnInstallation: true,
          required: true,
          sensitive: false,
          headerName: "x-required",
        },
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await db
      .update(schema.mcpServersTable)
      .set({ serverType: "remote" })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("header_required");
  });

  // Regression: reinstall of a local MCP server with a newly-added prompted
  // plain_text env var used to land the value only in the K8s secret bag.
  // On the next pod start, the secret-typed-only filter dropped it, and the
  // install row's `environmentValues` column was empty, so neither source
  // carried the value into the pod env.
  test("reinstall of a local MCP server persists plain prompted env values into mcp_server.environmentValues", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Local Reinstall Plain Prompted Env",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "PROMPTED_PLAIN_VALUE",
            type: "plain_text",
            promptOnInstallation: true,
            required: true,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    // Simulate the install state from before the catalog edit added the
    // new prompted var (its environmentValues column has no entry for it).
    await db
      .update(schema.mcpServersTable)
      .set({ environmentValues: {} })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: {
        environmentValues: {
          PROMPTED_PLAIN_VALUE: "user-entered-at-reinstall",
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const [updatedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, mcpServer.id));

    expect(updatedServer?.environmentValues).toMatchObject({
      PROMPTED_PLAIN_VALUE: "user-entered-at-reinstall",
    });

    await drainPendingReinstall(mcpServer.id);
  });

  // Regression: the install dialog drops empty fields before submitting,
  // so a partial reinstall (user fills only the new prompted var, leaves
  // the others blank because the dialog doesn't pre-fill from the row)
  // must not erase entries already on `environmentValues`.
  test("reinstall preserves existing plain env values that the request body did not carry", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Local Reinstall Partial Submission",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "EXISTING_VAR",
            type: "plain_text",
            promptOnInstallation: true,
            required: false,
          },
          {
            key: "NEW_REQUIRED_VAR",
            type: "plain_text",
            promptOnInstallation: true,
            required: true,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await db
      .update(schema.mcpServersTable)
      .set({ environmentValues: { EXISTING_VAR: "set-at-original-install" } })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: {
        environmentValues: {
          NEW_REQUIRED_VAR: "user-fills-only-this",
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const [updatedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, mcpServer.id));

    expect(updatedServer?.environmentValues).toMatchObject({
      EXISTING_VAR: "set-at-original-install",
      NEW_REQUIRED_VAR: "user-fills-only-this",
    });

    await drainPendingReinstall(mcpServer.id);
  });

  // Required plain env vars already on the row are satisfied by the merged
  // effective state — without this, a partial reinstall would 400 before
  // the merge path could preserve the stored value.
  test("reinstall accepts a body that omits required plain env vars already on the install row", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Local Reinstall Required From Row",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "EXISTING_REQUIRED",
            type: "plain_text",
            promptOnInstallation: true,
            required: true,
          },
          {
            key: "NEW_REQUIRED",
            type: "plain_text",
            promptOnInstallation: true,
            required: true,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await db
      .update(schema.mcpServersTable)
      .set({ environmentValues: { EXISTING_REQUIRED: "row-value" } })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: {
        environmentValues: { NEW_REQUIRED: "user-fills-only-this" },
      },
    });

    expect(response.statusCode).toBe(200);

    const [updatedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, mcpServer.id));

    expect(updatedServer?.environmentValues).toMatchObject({
      EXISTING_REQUIRED: "row-value",
      NEW_REQUIRED: "user-fills-only-this",
    });

    await drainPendingReinstall(mcpServer.id);
  });

  // Same shape as the plain-env case above but for secret-typed required
  // env vars: a partial reinstall body shouldn't be rejected when the
  // missing secret is already on the install's secret bag.
  test("reinstall accepts a body that omits required secret env vars already on the install's secret bag", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Local Reinstall Required Secret From Bag",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "EXISTING_SECRET",
            type: "secret",
            promptOnInstallation: true,
            required: true,
          },
          {
            key: "NEW_REQUIRED",
            type: "plain_text",
            promptOnInstallation: true,
            required: true,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    const existingBag = await secretManager().createSecret(
      { EXISTING_SECRET: "in-the-bag" },
      `${mcpServer.name}-existing-bag`,
    );
    await db
      .update(schema.mcpServersTable)
      .set({ secretId: existingBag.id })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: {
        environmentValues: { NEW_REQUIRED: "user-fills-only-the-new-one" },
      },
    });

    expect(response.statusCode).toBe(200);

    const [updatedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    const storedSecret = await secretManager().getSecret(
      updatedServer.secretId!,
    );
    expect(storedSecret?.secret).toMatchObject({
      EXISTING_SECRET: "in-the-bag",
      NEW_REQUIRED: "user-fills-only-the-new-one",
    });

    await drainPendingReinstall(mcpServer.id);
  });

  // An explicit empty string for a prompted plain key clears it from the
  // row. Distinguishes "user wants to delete this value" from "user didn't
  // touch this field" (the latter signaled by omitting the key entirely).
  test("reinstall body with empty string for a plain env key clears that entry", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Local Reinstall Clear Via Empty String",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "OPTIONAL_PLAIN",
            type: "plain_text",
            promptOnInstallation: true,
            required: false,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await db
      .update(schema.mcpServersTable)
      .set({ environmentValues: { OPTIONAL_PLAIN: "to-be-cleared" } })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: { environmentValues: { OPTIONAL_PLAIN: "" } },
    });

    expect(response.statusCode).toBe(200);

    const [updatedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, mcpServer.id));

    expect(updatedServer?.environmentValues).toEqual({});

    await drainPendingReinstall(mcpServer.id);
  });

  // A whitespace-only submission for a required secret passes validation via
  // the existing-bag fallback; it must not then overwrite the stored secret
  // with whitespace, leaving the restarted server with broken credentials.
  test("reinstall ignores a whitespace-only secret submission and keeps the stored secret", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Local Reinstall Whitespace Secret",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "API_SECRET",
            type: "secret",
            promptOnInstallation: true,
            required: true,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    const existingBag = await secretManager().createSecret(
      { API_SECRET: "valid-credential" },
      `${mcpServer.name}-existing-bag`,
    );
    await db
      .update(schema.mcpServersTable)
      .set({ secretId: existingBag.id })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: { environmentValues: { API_SECRET: "   " } },
    });

    expect(response.statusCode).toBe(200);

    const [updatedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    const storedSecret = await secretManager().getSecret(
      updatedServer.secretId!,
    );
    expect(storedSecret?.secret).toMatchObject({
      API_SECRET: "valid-credential",
    });

    await drainPendingReinstall(mcpServer.id);
  });

  // The plain-env column is rebuilt from the catalog's current plain prompted
  // keys, so a var removed from the catalog or flipped to secret-typed can't
  // survive as stale plaintext in the column (and thus in the pod env via the
  // unconditional overlay).
  test("reinstall prunes column keys no longer plain-prompted in the catalog", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Local Reinstall Prune Stale Column",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "KEPT_PLAIN",
            type: "plain_text",
            promptOnInstallation: true,
            required: false,
          },
          {
            key: "FLIPPED_TO_SECRET",
            type: "secret",
            promptOnInstallation: true,
            required: false,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await db
      .update(schema.mcpServersTable)
      .set({
        environmentValues: {
          KEPT_PLAIN: "old",
          FLIPPED_TO_SECRET: "stale-plaintext",
          REMOVED_FROM_CATALOG: "orphan",
        },
      })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: { environmentValues: { KEPT_PLAIN: "new" } },
    });

    expect(response.statusCode).toBe(200);

    const [updatedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, mcpServer.id));

    expect(updatedServer?.environmentValues).toEqual({ KEPT_PLAIN: "new" });

    await drainPendingReinstall(mcpServer.id);
  });

  // Required-env validation runs even when the reinstall body is empty, so a
  // newly-added required var that nothing satisfies fails fast with 400
  // instead of only breaking later at pod start.
  test("reinstall with an empty body 400s when a newly-added required env var is unsatisfied", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Local Reinstall Empty Body Missing Required",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "NEWLY_REQUIRED",
            type: "plain_text",
            promptOnInstallation: true,
            required: true,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await db
      .update(schema.mcpServersTable)
      .set({ environmentValues: {} })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: { environmentValues: {} },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("NEWLY_REQUIRED");
  });

  // The hoisted validation must not over-reject: an empty body still succeeds
  // when the required var is already satisfied on the install row. The column
  // is also rebuilt on an empty body, so a stale key left by a catalog edit is
  // pruned even when the (auto-cascade) reinstall carries no values.
  test("reinstall with an empty body succeeds and prunes stale column keys", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Local Reinstall Empty Body Satisfied",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "ALREADY_SET",
            type: "plain_text",
            promptOnInstallation: true,
            required: true,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await db
      .update(schema.mcpServersTable)
      .set({
        environmentValues: {
          ALREADY_SET: "from-original-install",
          REMOVED_FROM_CATALOG: "orphan",
        },
      })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: { environmentValues: {} },
    });

    expect(response.statusCode).toBe(200);

    const [updatedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, mcpServer.id));

    expect(updatedServer?.environmentValues).toEqual({
      ALREADY_SET: "from-original-install",
    });

    await drainPendingReinstall(mcpServer.id);
  });

  test("installs a protected remote MCP server with an exchanged enterprise-managed credential on first discovery", async ({
    makeAccount,
    makeIdentityProvider,
    makeInternalMcpCatalog,
  }) => {
    const identityProvider = await makeIdentityProvider(user.id, {
      providerId: "keycloak",
      issuer: "http://localhost:30081/realms/archestra",
      oidcConfig: {
        clientId: "archestra-oidc",
        clientSecret: "archestra-oidc-secret",
        tokenEndpoint:
          "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
        tokenEndpointAuthentication: "client_secret_post",
        enterpriseManagedCredentials: {
          exchangeStrategy: "rfc8693",
          subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
        },
      },
    });

    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "GitHub Remote",
      serverType: "remote",
      serverUrl: "https://api.githubcopilot.com/mcp/",
      enterpriseManagedConfig: {
        identityProviderId: identityProvider.id,
        requestedCredentialType: "bearer_token",
        requestedIssuer: "github",
        tokenInjectionMode: "authorization_bearer",
      },
    });

    await makeAccount(user.id, {
      providerId: "keycloak",
      accessToken: "session-access-token",
    });

    exchangeEnterpriseManagedCredentialMock.mockResolvedValueOnce({
      credentialType: "bearer_token",
      expiresInSeconds: null,
      issuedTokenType: OAUTH_TOKEN_TYPE.AccessToken,
      value: "exchanged-github-token",
    });

    connectAndGetToolsMock.mockResolvedValueOnce([
      {
        name: "add_issue_comment",
        description: "Post a comment to a GitHub issue",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "GitHub",
        catalogId: catalog.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(exchangeEnterpriseManagedCredentialMock).toHaveBeenCalledWith({
      identityProviderId: identityProvider.id,
      assertion: "session-access-token",
      enterpriseManagedConfig: expect.objectContaining({
        requestedIssuer: "github",
      }),
    });
    expect(connectAndGetToolsMock).toHaveBeenCalledTimes(1);
    expect(connectAndGetToolsMock.mock.calls[0][0]).toMatchObject({
      secrets: { access_token: "exchanged-github-token" },
    });
  });

  // Regression: enterprise-managed catalogs with install-time userConfig used
  // to run the static-secret `validateConnection` probe before discovery,
  // which hit the MCP server without any Authorization header and failed the
  // install on servers that require auth for tools/list.
  test("enterprise-managed install with install-time config skips the unauthenticated connection probe", async ({
    makeAccount,
    makeIdentityProvider,
    makeInternalMcpCatalog,
  }) => {
    const identityProvider = await makeIdentityProvider(user.id, {
      providerId: "keycloak",
      issuer: "http://localhost:30081/realms/archestra",
      oidcConfig: {
        clientId: "archestra-oidc",
        clientSecret: "archestra-oidc-secret",
        tokenEndpoint:
          "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
        tokenEndpointAuthentication: "client_secret_post",
        enterpriseManagedCredentials: {
          exchangeStrategy: "rfc8693",
          subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
        },
      },
    });

    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Protected Remote With Config",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      enterpriseManagedConfig: {
        identityProviderId: identityProvider.id,
        requestedCredentialType: "bearer_token",
        tokenInjectionMode: "authorization_bearer",
      },
      userConfig: {
        header_x_tenant: {
          type: "string",
          title: "x-tenant",
          description: "Tenant header",
          promptOnInstallation: true,
          required: true,
          sensitive: false,
          headerName: "x-tenant",
        },
      },
    });

    await makeAccount(user.id, {
      providerId: "keycloak",
      accessToken: "session-access-token",
    });

    exchangeEnterpriseManagedCredentialMock.mockResolvedValueOnce({
      credentialType: "bearer_token",
      expiresInSeconds: null,
      issuedTokenType: OAUTH_TOKEN_TYPE.AccessToken,
      value: "exchanged-downstream-token",
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
        name: "Protected Remote With Config",
        catalogId: catalog.id,
        userConfigValues: {
          header_x_tenant: "tenant-a",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    // Exactly one connect for this catalog: the discovery call carrying the
    // exchanged credential — no prior unauthenticated validateConnection
    // probe. Filter by catalog id so deferred background discovery leaked
    // from sibling tests can't pollute the count.
    const callsForCatalog = connectAndGetToolsMock.mock.calls.filter(
      ([params]) =>
        (params as { catalogItem?: { id?: string } }).catalogItem?.id ===
        catalog.id,
    );
    expect(callsForCatalog).toHaveLength(1);
    expect(callsForCatalog[0][0]).toMatchObject({
      secrets: {
        header_x_tenant: "tenant-a",
        access_token: "exchanged-downstream-token",
      },
    });
  });

  test("enterprise-managed local server install discovery sends the exchanged credential", async ({
    makeAccount,
    makeIdentityProvider,
    makeInternalMcpCatalog,
  }) => {
    const identityProvider = await makeIdentityProvider(user.id, {
      providerId: "keycloak",
      issuer: "http://localhost:30081/realms/archestra",
      oidcConfig: {
        clientId: "archestra-oidc",
        clientSecret: "archestra-oidc-secret",
        tokenEndpoint:
          "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
        tokenEndpointAuthentication: "client_secret_post",
        enterpriseManagedCredentials: {
          exchangeStrategy: "rfc8693",
          subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
        },
      },
    });

    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Protected Local Http",
      serverType: "local",
      enterpriseManagedConfig: {
        identityProviderId: identityProvider.id,
        requestedCredentialType: "bearer_token",
        tokenInjectionMode: "authorization_bearer",
      },
      localConfig: {
        transportType: "streamable-http",
        dockerImage: "example/protected-mcp:latest",
      },
    });

    await makeAccount(user.id, {
      providerId: "keycloak",
      accessToken: "session-access-token",
    });

    exchangeEnterpriseManagedCredentialMock.mockResolvedValueOnce({
      credentialType: "bearer_token",
      expiresInSeconds: null,
      issuedTokenType: OAUTH_TOKEN_TYPE.AccessToken,
      value: "exchanged-local-token",
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
        name: "Protected Local Http",
        catalogId: catalog.id,
      },
    });

    expect(response.statusCode).toBe(200);
    const serverId = response.json().id as string;

    // Local discovery runs in a deferred background task; wait for it.
    let finalStatus: string | null | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [serverRow] = await db
        .select()
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.id, serverId));
      finalStatus = serverRow?.localInstallationStatus;
      if (finalStatus && finalStatus !== "pending") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(finalStatus).toBe("success");
    const callsForCatalog = connectAndGetToolsMock.mock.calls.filter(
      ([params]) =>
        (params as { catalogItem?: { id?: string } }).catalogItem?.id ===
        catalog.id,
    );
    expect(callsForCatalog).toHaveLength(1);
    expect(callsForCatalog[0][0]).toMatchObject({
      secrets: { access_token: "exchanged-local-token" },
    });
  });

  test("sends enterprise-managed credentials on first discovery without depending on auth-error retry matching", async ({
    makeAccount,
    makeIdentityProvider,
    makeInternalMcpCatalog,
  }) => {
    const identityProvider = await makeIdentityProvider(user.id, {
      providerId: "missing-auth-header-idp",
      issuer: "https://login.example.com/tenant/v2.0",
      oidcConfig: {
        clientId: "web-client-id",
        clientSecret: "web-client-secret",
        tokenEndpoint: "https://login.example.com/tenant/oauth2/v2.0/token",
        enterpriseManagedCredentials: {
          exchangeStrategy: "entra_obo",
          subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
          tokenEndpoint: "https://login.example.com/tenant/oauth2/v2.0/token",
          tokenEndpointAuthentication: "client_secret_post",
        },
      },
    });

    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Header Required Remote",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      enterpriseManagedConfig: {
        identityProviderId: identityProvider.id,
        requestedCredentialType: "bearer_token",
        resourceIdentifier: "api://downstream-app",
        tokenInjectionMode: "authorization_bearer",
      },
    });

    await makeAccount(user.id, {
      providerId: "missing-auth-header-idp",
      accessToken: "session-access-token",
    });

    exchangeEnterpriseManagedCredentialMock.mockResolvedValueOnce({
      credentialType: "bearer_token",
      expiresInSeconds: 300,
      issuedTokenType: OAUTH_TOKEN_TYPE.AccessToken,
      value: "downstream-user-token",
    });

    connectAndGetToolsMock.mockResolvedValueOnce([
      {
        name: "debug_auth",
        description: "Debug auth",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: catalog.name,
        catalogId: catalog.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(connectAndGetToolsMock).toHaveBeenCalledTimes(1);
    expect(exchangeEnterpriseManagedCredentialMock).toHaveBeenCalledWith({
      identityProviderId: identityProvider.id,
      assertion: "session-access-token",
      enterpriseManagedConfig: expect.objectContaining({
        resourceIdentifier: "api://downstream-app",
      }),
    });
    expect(connectAndGetToolsMock.mock.calls[0][0]).toMatchObject({
      secrets: { access_token: "downstream-user-token" },
    });
  });

  test("uses the current SSO access token for implicit enterprise-managed install discovery without a matching IdP", async ({
    makeAccount,
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Implicit Protected Remote",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      enterpriseManagedConfig: {
        requestedCredentialType: "bearer_token",
        resourceIdentifier: "api://downstream-app",
        tokenInjectionMode: "authorization_bearer",
      },
    });

    await makeAccount(user.id, {
      providerId: "external-sso-without-idp-row",
      accessToken: "raw-session-access-token",
    });

    connectAndGetToolsMock.mockResolvedValueOnce([
      {
        name: "debug_auth",
        description: "Debug auth",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: catalog.name,
        catalogId: catalog.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(exchangeEnterpriseManagedCredentialMock).not.toHaveBeenCalled();
    expect(connectAndGetToolsMock).toHaveBeenCalledTimes(1);
    expect(connectAndGetToolsMock.mock.calls[0][0]).toMatchObject({
      secrets: { access_token: "raw-session-access-token" },
    });
  });

  test("uses the configured token-exchange identity provider for shared install discovery", async ({
    makeAccount,
    makeIdentityProvider,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    await makeIdentityProvider(user.id, {
      providerId: "login-sso",
      issuer: "https://login-sso.example.com",
      oidcConfig: {
        clientId: "login-client",
        clientSecret: "login-secret",
        tokenEndpoint: "https://login-sso.example.com/oauth/token",
      },
    });
    const exchangeIdentityProvider = await makeIdentityProvider(user.id, {
      providerId: "mcp-exchange-idp",
      issuer: "https://exchange-idp.example.com/tenant/v2.0",
      oidcConfig: {
        clientId: "exchange-client",
        clientSecret: "exchange-secret",
        tokenEndpoint: "https://exchange-idp.example.com/oauth2/v2.0/token",
        enterpriseManagedCredentials: {
          exchangeStrategy: "entra_obo",
          subjectTokenType: OAUTH_TOKEN_TYPE.AccessToken,
          tokenEndpoint: "https://exchange-idp.example.com/oauth2/v2.0/token",
          tokenEndpointAuthentication: "client_secret_post",
        },
      },
    });
    const team = await makeTeam(organizationId, user.id);

    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Shared Protected Remote",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      enterpriseManagedConfig: {
        identityProviderId: exchangeIdentityProvider.id,
        requestedCredentialType: "bearer_token",
        resourceIdentifier: "api://downstream-app",
        tokenInjectionMode: "authorization_bearer",
      },
    });

    await makeAccount(user.id, {
      providerId: "login-sso",
      accessToken: "login-sso-access-token",
    });
    await makeAccount(user.id, {
      providerId: "mcp-exchange-idp",
      accessToken: "exchange-idp-access-token",
    });

    exchangeEnterpriseManagedCredentialMock.mockResolvedValueOnce({
      credentialType: "bearer_token",
      expiresInSeconds: 300,
      issuedTokenType: OAUTH_TOKEN_TYPE.AccessToken,
      value: "shared-install-discovery-token",
    });
    connectAndGetToolsMock.mockResolvedValueOnce([
      {
        name: "list_records",
        description: "List records",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: catalog.name,
        catalogId: catalog.id,
        scope: "team",
        teamId: team.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(exchangeEnterpriseManagedCredentialMock).toHaveBeenCalledWith({
      identityProviderId: exchangeIdentityProvider.id,
      assertion: "exchange-idp-access-token",
      enterpriseManagedConfig: expect.objectContaining({
        resourceIdentifier: "api://downstream-app",
      }),
    });
    expect(connectAndGetToolsMock).toHaveBeenCalledTimes(1);
    expect(connectAndGetToolsMock.mock.calls[0][0]).toMatchObject({
      secrets: { access_token: "shared-install-discovery-token" },
    });
  });

  test("exchanges an install-time session ID token for an ID-JAG before protected resource discovery", async ({
    makeAccount,
    makeAgent,
    makeIdentityProvider,
    makeInternalMcpCatalog,
  }) => {
    const { default: AgentToolModel } = await import("@/models/agent-tool");
    const { ToolModel } = await import("@/models");

    const agent = await makeAgent({
      name: "Protected Resource Demo Agent",
      agentType: "mcp_gateway",
      scope: "personal",
      organizationId,
      authorId: user.id,
    });

    const identityProvider = await makeIdentityProvider(user.id, {
      providerId: "GenericOIDC",
      issuer: "https://idp.example.com",
      oidcConfig: {
        clientId: "archestra-client-id",
        clientSecret: "archestra-client-secret",
        tokenEndpoint: "https://idp.example.com/token",
        tokenEndpointAuthentication: "client_secret_basic",
        enterpriseManagedCredentials: {
          exchangeStrategy: "rfc8693",
          subjectTokenType: OAUTH_TOKEN_TYPE.IdToken,
        },
      },
    });

    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Protected Resource Remote",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      enterpriseManagedConfig: {
        identityProviderId: identityProvider.id,
        requestedCredentialType: "id_jag",
        resourceType: "oauth_protected_resource",
        resourceIdentifier: "https://mcp.example.com/mcp",
        tokenInjectionMode: "authorization_bearer",
      },
    });

    await makeAccount(user.id, {
      providerId: "GenericOIDC",
      accessToken: "session-access-token",
      idToken: "session-id-token",
    });

    exchangeEnterpriseManagedCredentialMock.mockResolvedValueOnce({
      credentialType: "id_jag",
      expiresInSeconds: 300,
      issuedTokenType: OAUTH_TOKEN_TYPE.IdJag,
      value: "session-id-jag",
    });

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (
        href ===
        "https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
      ) {
        return Response.json({
          resource: "https://mcp.example.com/mcp",
          authorization_servers: ["https://auth.example.com"],
        });
      }

      if (
        href ===
        "https://auth.example.com/.well-known/oauth-authorization-server"
      ) {
        return Response.json({
          token_endpoint: "https://auth.example.com/oauth/token",
        });
      }

      if (href === "https://auth.example.com/oauth/token") {
        expect(init?.method).toBe("POST");
        expect(init?.body?.toString()).toContain("assertion=session-id-jag");
        return Response.json({
          access_token: "mcp-server-access-token",
          expires_in: 300,
        });
      }

      return new Response(null, { status: 404 });
    });
    global.fetch = fetchMock as typeof fetch;

    connectAndGetToolsMock.mockResolvedValueOnce([
      {
        name: "read_resource_todos",
        description: "Read todos",
        inputSchema: { type: "object", properties: {} },
        _meta: {
          archestraResourceUri: "todo://todos",
        },
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: catalog.name,
        catalogId: catalog.id,
        agentIds: [agent.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(exchangeEnterpriseManagedCredentialMock).toHaveBeenCalledWith({
      identityProviderId: identityProvider.id,
      assertion: "session-id-token",
      enterpriseManagedConfig: expect.objectContaining({
        requestedCredentialType: "id_jag",
      }),
    });
    expect(connectAndGetToolsMock.mock.calls[0][0]).toMatchObject({
      secrets: { access_token: "mcp-server-access-token" },
    });

    const persistedTool = await ToolModel.findByName(
      "protected_resource_remote__read_resource_todos",
    );
    expect(persistedTool).toMatchObject({
      catalogId: catalog.id,
      meta: {
        _meta: {
          archestraResourceUri: "todo://todos",
        },
      },
    });
    const assignedToolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
    expect(assignedToolIds).toContain(persistedTool?.id);
    if (!persistedTool) throw new Error("expected persisted tool");
    const [assignment] = await db
      .select({
        credentialResolutionMode:
          schema.agentToolsTable.credentialResolutionMode,
      })
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agent.id),
          eq(schema.agentToolsTable.toolId, persistedTool.id),
        ),
      );
    expect(assignment?.credentialResolutionMode).toBe("enterprise_managed");
  });

  test("persists enterprise-managed config on installed MCP servers", async ({
    makeAccount,
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Managed Remote",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
      enterpriseManagedConfig: {
        requestedCredentialType: "secret",
        resourceIdentifier: "orn:okta:pam:github-secret",
        tokenInjectionMode: "authorization_bearer",
        responseFieldPath: "token",
      },
    });

    connectAndGetToolsMock.mockResolvedValueOnce([
      {
        name: "get-server-info",
        description: "Returns server details",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    await makeAccount(user.id, {
      providerId: "session-provider",
      accessToken: "session-access-token",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "Managed Remote",
        catalogId: catalog.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty("enterpriseManagedConfig");
  });

  test("returns 500 when protected remote MCP server installation still lacks usable auth after automatic fallback", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
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
      organizationId,
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
      organizationId,
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
      organizationId,
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
      organizationId,
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
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "local",
    });
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
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "local",
    });
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
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "local",
    });
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
      organizationId,
      name: "Remote Reauth Server",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
      userConfig: {
        api_key: {
          type: "string",
          title: "API Key",
          description: "Prompted API key",
          promptOnInstallation: true,
          required: true,
          sensitive: true,
        },
      },
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
    expect(invalidateConnectionsForServerMock).toHaveBeenCalledWith(
      mcpServer.id,
    );
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

  test("re-authentication ignores installer overrides for catalog static headers", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Remote Static Header Reauth Server",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
      userConfig: {
        header_x_api_key: {
          type: "string",
          title: "x-api-key",
          description: "Static API key",
          promptOnInstallation: false,
          required: false,
          sensitive: false,
          headerName: "x-api-key",
          default: "catalog-api-key",
        },
        tenant_id: {
          type: "string",
          title: "Tenant ID",
          description: "Prompted tenant ID",
          promptOnInstallation: true,
          required: true,
          sensitive: false,
          headerName: "x-tenant-id",
        },
      },
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
          header_x_api_key: "installer-override",
          tenant_id: "tenant-42",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(connectAndGetToolsMock).toHaveBeenCalledTimes(1);
    expect(invalidateConnectionsForServerMock).toHaveBeenCalledWith(
      mcpServer.id,
    );
    expect(connectAndGetToolsMock.mock.calls[0][0]).toMatchObject({
      catalogItem: expect.objectContaining({ id: catalog.id }),
      mcpServerId: "validation",
      secrets: {
        header_x_api_key: "catalog-api-key",
        tenant_id: "tenant-42",
      },
    });
  });

  test("rejects re-authenticate of another user's personal connection by an editor", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
  }) => {
    const otherUser = await makeUser({ email: "reauth-owner@example.com" });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
    });
    const mcpServer = await makeMcpServer({
      ownerId: otherUser.id,
      catalogId: catalog.id,
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/mcp_server/${mcpServer.id}/reauthenticate`,
      payload: { accessToken: "attacker-pat" },
    });

    expect(response.statusCode).toBe(403);
    expect(connectAndGetToolsMock).not.toHaveBeenCalled();
  });

  test("reinstalls a protected remote MCP server using the current identity-provider access token fallback", async ({
    makeAccount,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Protected Remote Reinstall",
      serverType: "remote",
      serverUrl: "http://localhost:30082/mcp",
    });
    const mcpServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
    });
    await McpServerUserModel.assignUserToMcpServer(mcpServer.id, user.id);
    await db
      .update(schema.mcpServersTable)
      .set({
        serverType: "remote",
        localInstallationStatus: "idle",
      })
      .where(eq(schema.mcpServersTable.id, mcpServer.id));

    await makeAccount(user.id, {
      providerId: "keycloak",
      accessToken: "session-access-token",
    });

    connectAndGetToolsMock
      .mockRejectedValueOnce(
        new Error(
          'Failed to connect to MCP server Protected Remote Reinstall: Streamable HTTP error: Error POSTing to endpoint: {"error":"Missing or invalid Authorization header"}',
        ),
      )
      .mockResolvedValueOnce([
        {
          name: "whoami",
          description: "Returns the authenticated user",
          inputSchema: { type: "object", properties: {} },
        },
      ]);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${mcpServer.id}/reinstall`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const [serverRow] = await db
        .select()
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.id, mcpServer.id));

      if (serverRow?.localInstallationStatus === "success") {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(connectAndGetToolsMock).toHaveBeenCalledTimes(2);
    expect(connectAndGetToolsMock.mock.calls[0][0]).toMatchObject({
      catalogItem: expect.objectContaining({ id: catalog.id }),
      mcpServerId: mcpServer.id,
      secrets: {},
    });
    expect(connectAndGetToolsMock.mock.calls[1][0]).toMatchObject({
      catalogItem: expect.objectContaining({ id: catalog.id }),
      mcpServerId: mcpServer.id,
      secrets: { access_token: "session-access-token" },
    });

    const [updatedServer] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, mcpServer.id));
    expect(updatedServer?.localInstallationStatus).toBe("success");
    expect(updatedServer?.localInstallationError).toBeNull();

    const syncedTools = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.catalogId, catalog.id));
    expect(syncedTools.map((tool) => tool.name)).toContain(
      "protected_remote_reinstall__whoami",
    );
  });

  describe("personal gateway auto-assignment on install", () => {
    beforeEach(async ({ makeOrganization, makeMember }) => {
      const org = await makeOrganization();
      organizationId = org.id;
      await makeMember(user.id, organizationId);
    });

    test("remote install with empty agentIds auto-assigns every tool to the installer's personal gateway", async ({
      makeInternalMcpCatalog,
    }) => {
      const { default: AgentModel } = await import("@/models/agent");
      const { default: AgentToolModel } = await import("@/models/agent-tool");

      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "Auto Assign Remote",
        serverType: "remote",
        serverUrl: "http://localhost:30082/mcp",
      });

      connectAndGetToolsMock.mockResolvedValueOnce([
        {
          name: "tool-a",
          description: "tool a",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "tool-b",
          description: "tool b",
          inputSchema: { type: "object", properties: {} },
        },
      ]);

      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: {
          name: "Auto Assign Remote",
          catalogId: catalog.id,
        },
      });
      expect(response.statusCode).toBe(200);

      const personalGateway = await AgentModel.getPersonalMcpGateway(
        user.id,
        organizationId,
      );
      if (!personalGateway) throw new Error("expected personal gateway");
      const assignments = await AgentToolModel.findToolIdsByAgent(
        personalGateway.id,
      );
      expect(assignments.length).toBe(2);
    });

    test("remote install with explicit agentIds still assigns tools to the personal gateway with no duplicate-key errors", async ({
      makeInternalMcpCatalog,
      makeAgent,
    }) => {
      const { default: AgentModel } = await import("@/models/agent");
      const { default: AgentToolModel } = await import("@/models/agent-tool");

      const otherAgent = await makeAgent({
        name: "Explicit Target",
        agentType: "mcp_gateway",
        scope: "personal",
        organizationId: organizationId,
        authorId: user.id,
      });

      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "Auto Assign Remote With Explicit",
        serverType: "remote",
        serverUrl: "http://localhost:30082/mcp",
      });

      connectAndGetToolsMock.mockResolvedValueOnce([
        {
          name: "tool-x",
          description: "tool x",
          inputSchema: { type: "object", properties: {} },
        },
      ]);

      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: {
          name: "Auto Assign Remote With Explicit",
          catalogId: catalog.id,
          agentIds: [otherAgent.id],
        },
      });
      expect(response.statusCode).toBe(200);

      const personalGateway = await AgentModel.getPersonalMcpGateway(
        user.id,
        organizationId,
      );
      if (!personalGateway) throw new Error("expected personal gateway");
      const personalAssignments = await AgentToolModel.findToolIdsByAgent(
        personalGateway.id,
      );
      const explicitAssignments = await AgentToolModel.findToolIdsByAgent(
        otherAgent.id,
      );
      expect(personalAssignments.length).toBe(1);
      expect(explicitAssignments.length).toBe(1);
    });

    test("does not assign tools to other users' personal gateways", async ({
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      const { default: AgentModel } = await import("@/models/agent");
      const { default: AgentToolModel } = await import("@/models/agent-tool");

      const otherUser = await makeUser({ email: "other-install@example.com" });
      await makeMember(otherUser.id, organizationId);
      const otherPersonalGateway = await AgentModel.ensurePersonalMcpGateway({
        userId: otherUser.id,
        organizationId: organizationId,
      });

      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "Auto Assign Remote Isolated",
        serverType: "remote",
        serverUrl: "http://localhost:30082/mcp",
      });

      connectAndGetToolsMock.mockResolvedValueOnce([
        {
          name: "tool-iso",
          description: "isolated tool",
          inputSchema: { type: "object", properties: {} },
        },
      ]);

      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: {
          name: "Auto Assign Remote Isolated",
          catalogId: catalog.id,
        },
      });
      expect(response.statusCode).toBe(200);

      const otherAssignments = await AgentToolModel.findToolIdsByAgent(
        otherPersonalGateway.id,
      );
      expect(otherAssignments.length).toBe(0);
    });

    test("re-install pins mcp_server_id on newly inserted agent_tools rows", async ({
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const { default: AgentModel } = await import("@/models/agent");

      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "Re-install Pinning",
        serverType: "remote",
        serverUrl: "http://localhost:30082/mcp",
      });

      // First install: catalog has tool-a only.
      connectAndGetToolsMock.mockResolvedValueOnce([
        {
          name: "tool-a",
          description: "tool a",
          inputSchema: { type: "object", properties: {} },
        },
      ]);

      const firstResponse = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: { name: "Re-install Pinning", catalogId: catalog.id },
      });
      expect(firstResponse.statusCode).toBe(200);
      const installedServer = firstResponse.json();

      // Catalog gains tool-b before the user re-installs.
      const newTool = await makeTool({
        name: "tool-b-new",
        catalogId: catalog.id,
      });

      // Re-install — duplicate-personal branch fires.
      const secondResponse = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: { name: "Re-install Pinning", catalogId: catalog.id },
      });
      expect(secondResponse.statusCode).toBe(200);

      const personalGateway = await AgentModel.getPersonalMcpGateway(
        user.id,
        organizationId,
      );
      if (!personalGateway) throw new Error("expected personal gateway");

      const newToolRow = await db
        .select({ mcpServerId: schema.agentToolsTable.mcpServerId })
        .from(schema.agentToolsTable)
        .where(
          and(
            eq(schema.agentToolsTable.agentId, personalGateway.id),
            eq(schema.agentToolsTable.toolId, newTool.id),
          ),
        );
      expect(newToolRow).toHaveLength(1);
      expect(newToolRow[0].mcpServerId).toBe(installedServer.id);
    });

    test("team-scoped install does not auto-assign tools to the installer's personal gateway", async ({
      makeInternalMcpCatalog,
      makeTeam,
    }) => {
      const { default: AgentModel } = await import("@/models/agent");
      const { default: AgentToolModel } = await import("@/models/agent-tool");

      const team = await makeTeam(organizationId, user.id, {
        name: "Auto Assign Team",
      });

      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "Auto Assign Team Remote",
        serverType: "remote",
        serverUrl: "http://localhost:30082/mcp",
      });

      connectAndGetToolsMock.mockResolvedValueOnce([
        {
          name: "tool-team",
          description: "team tool",
          inputSchema: { type: "object", properties: {} },
        },
      ]);

      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: {
          name: "Auto Assign Team Remote",
          catalogId: catalog.id,
          scope: "team",
          teamId: team.id,
        },
      });
      expect(response.statusCode).toBe(200);

      const personalGateway = await AgentModel.getPersonalMcpGateway(
        user.id,
        organizationId,
      );
      const personalAssignments = personalGateway
        ? await AgentToolModel.findToolIdsByAgent(personalGateway.id)
        : [];
      expect(personalAssignments.length).toBe(0);
    });
  });

  function configurePermissions(opts: {
    canManageAllTeams: boolean;
    isEditor: boolean;
  }) {
    hasPermissionMock.mockImplementation(
      async (permission: Record<string, string[]>) => {
        if (permission.team?.includes("create")) {
          return { success: opts.canManageAllTeams, error: null };
        }
        if (permission.mcpServerInstallation?.includes("update")) {
          return { success: opts.isEditor, error: null };
        }
        return { success: false, error: null };
      },
    );
  }

  test("install scope=team: organization-level team manager can install for a non-member team", async ({
    makeInternalMcpCatalog,
    makeTeam,
    makeUser,
  }) => {
    configurePermissions({ canManageAllTeams: true, isEditor: false });
    const otherUser = await makeUser();
    const team = await makeTeam(organizationId, otherUser.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Team Scoped Install",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "Team Scoped Install",
        catalogId: catalog.id,
        scope: "team",
        teamId: team.id,
      },
    });

    expect(response.statusCode).toBe(200);
  });

  test("install scope=team: editor + member of team succeeds", async ({
    makeInternalMcpCatalog,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    configurePermissions({ canManageAllTeams: false, isEditor: true });
    const otherUser = await makeUser();
    const team = await makeTeam(organizationId, otherUser.id);
    await makeTeamMember(team.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Team Scoped Install Editor Member",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "Team Scoped Install Editor Member",
        catalogId: catalog.id,
        scope: "team",
        teamId: team.id,
      },
    });

    expect(response.statusCode).toBe(200);
  });

  test("install scope=team: editor not a member of target team is rejected", async ({
    makeInternalMcpCatalog,
    makeTeam,
    makeUser,
  }) => {
    configurePermissions({ canManageAllTeams: false, isEditor: true });
    const otherUser = await makeUser();
    const team = await makeTeam(organizationId, otherUser.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Team Scoped Install Editor Non-Member",
      serverType: "local",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "Team Scoped Install Editor Non-Member",
        catalogId: catalog.id,
        scope: "team",
        teamId: team.id,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain(
      "You can only create MCP server installations for teams you are a member of",
    );
  });

  test("install scope=team: caller without mcpServerInstallation:update is rejected", async ({
    makeInternalMcpCatalog,
    makeTeam,
    makeTeamMember,
  }) => {
    configurePermissions({ canManageAllTeams: false, isEditor: false });
    const team = await makeTeam(organizationId, user.id);
    await makeTeamMember(team.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Team Scoped Install No Editor",
      serverType: "local",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "Team Scoped Install No Editor",
        catalogId: catalog.id,
        scope: "team",
        teamId: team.id,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain(
      "You don't have permission to create team MCP server installations",
    );
  });

  test("revoke team-scoped: organization-level team manager can revoke for a non-member team", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTeam,
    makeUser,
  }) => {
    configurePermissions({ canManageAllTeams: true, isEditor: false });
    const otherUser = await makeUser();
    const team = await makeTeam(organizationId, otherUser.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "remote",
    });
    const mcpServer = await makeMcpServer({
      catalogId: catalog.id,
      scope: "team",
      teamId: team.id,
      ownerId: otherUser.id,
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/mcp_server/${mcpServer.id}`,
    });

    expect(response.statusCode).toBe(200);
  });

  test("revoke team-scoped: editor not a member is rejected", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTeam,
    makeUser,
  }) => {
    configurePermissions({ canManageAllTeams: false, isEditor: true });
    const otherUser = await makeUser();
    const team = await makeTeam(organizationId, otherUser.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "remote",
    });
    const mcpServer = await makeMcpServer({
      catalogId: catalog.id,
      scope: "team",
      teamId: team.id,
      ownerId: otherUser.id,
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/mcp_server/${mcpServer.id}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain(
      "You can only revoke connections for teams you are a member of",
    );
  });
});

describe("mcp server core route coverage", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000aa";

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organization.id);
    hasPermissionMock.mockResolvedValue({ success: true, error: null });
    userHasPermissionMock.mockResolvedValue(true);
    k8sStopServerMock.mockResolvedValue(undefined);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { user: User; organizationId: string }
      ).user = user;
      (
        request as typeof request & { user: User; organizationId: string }
      ).organizationId = organizationId;
    });

    const { default: mcpServerRoutes } = await import("./mcp-server");
    await app.register(mcpServerRoutes);
  });

  afterEach(async () => {
    hasPermissionMock.mockReset();
    userHasPermissionMock.mockReset();
    k8sStopServerMock.mockReset();
    await app.close();
  });

  describe("GET /api/mcp_server/:id", () => {
    test("returns an MCP server the caller can access", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        serverType: "local",
      });
      const server = await makeMcpServer({
        ownerId: user.id,
        catalogId: catalog.id,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/mcp_server/${server.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe(server.id);
    });

    test("returns 404 for an unknown id", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/mcp_server/${UNKNOWN_ID}`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toBe("MCP server not found");
    });
  });

  describe("GET /api/mcp_server/:id/installation-status", () => {
    test("returns the installation status for an accessible server", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        serverType: "local",
      });
      const server = await makeMcpServer({
        ownerId: user.id,
        catalogId: catalog.id,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/mcp_server/${server.id}/installation-status`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        localInstallationStatus: "idle",
        localInstallationError: null,
      });
    });
  });

  describe("GET /api/mcp_server/:id/tools", () => {
    test("returns the catalog tools for an accessible server", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        serverType: "local",
      });
      const server = await makeMcpServer({
        ownerId: user.id,
        catalogId: catalog.id,
      });
      const tool = await makeTool({ catalogId: catalog.id });

      const response = await app.inject({
        method: "GET",
        url: `/api/mcp_server/${server.id}/tools`,
      });

      expect(response.statusCode).toBe(200);
      const tools = response.json();
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        id: tool.id,
        name: tool.name,
        assignedAgentCount: 0,
        assignedAgents: [],
      });
    });

    test("returns an empty list when the catalog has no tools", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        serverType: "local",
      });
      const server = await makeMcpServer({
        ownerId: user.id,
        catalogId: catalog.id,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/mcp_server/${server.id}/tools`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });
  });

  describe("DELETE /api/mcp_server/:id", () => {
    test("returns 404 for an unknown id", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/api/mcp_server/${UNKNOWN_ID}`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toBe("MCP server not found");
    });

    test("refuses to delete a built-in MCP server with 400", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        serverType: "builtin",
      });
      const builtin = await McpServerModel.create({
        name: "builtin-server",
        catalogId: catalog.id,
        serverType: "builtin",
        scope: "org",
        ownerId: user.id,
      });

      const response = await app.inject({
        method: "DELETE",
        url: `/api/mcp_server/${builtin.id}`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toBe(
        "Cannot delete built-in MCP servers",
      );
      await expect(McpServerModel.findById(builtin.id)).resolves.not.toBeNull();
    });

    test("uninstalling the last connection retains tools, policies, and assignments (binding nulled)", async ({
      makeInternalMcpCatalog,
    }) => {
      const { default: AgentModel } = await import("@/models/agent");

      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "Retain On Uninstall",
        serverType: "remote",
        serverUrl: "http://localhost:30082/mcp",
      });

      connectAndGetToolsMock.mockResolvedValueOnce([
        {
          name: "retained-tool",
          description: "kept after uninstall",
          inputSchema: { type: "object", properties: {} },
        },
      ]);

      const installResponse = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: { name: "Retain On Uninstall", catalogId: catalog.id },
      });
      expect(installResponse.statusCode).toBe(200);
      const installedServer = installResponse.json();

      const toolsBefore = await db
        .select()
        .from(schema.toolsTable)
        .where(eq(schema.toolsTable.catalogId, catalog.id));
      expect(toolsBefore).toHaveLength(1);
      const tool = toolsBefore[0];

      const personalGateway = await AgentModel.getPersonalMcpGateway(
        user.id,
        organizationId,
      );
      if (!personalGateway) throw new Error("expected personal gateway");

      const assignmentBefore = await db
        .select({ mcpServerId: schema.agentToolsTable.mcpServerId })
        .from(schema.agentToolsTable)
        .where(
          and(
            eq(schema.agentToolsTable.agentId, personalGateway.id),
            eq(schema.agentToolsTable.toolId, tool.id),
          ),
        );
      expect(assignmentBefore).toHaveLength(1);
      expect(assignmentBefore[0].mcpServerId).toBe(installedServer.id);

      const policiesBefore = await db
        .select()
        .from(schema.toolInvocationPoliciesTable)
        .where(eq(schema.toolInvocationPoliciesTable.toolId, tool.id));
      expect(policiesBefore.length).toBeGreaterThan(0);

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/mcp_server/${installedServer.id}`,
      });
      expect(deleteResponse.statusCode).toBe(200);

      // The connection is gone, but the catalog's capability is retained.
      await expect(
        McpServerModel.findById(installedServer.id),
      ).resolves.toBeNull();

      const toolsAfter = await db
        .select()
        .from(schema.toolsTable)
        .where(eq(schema.toolsTable.catalogId, catalog.id));
      expect(toolsAfter).toHaveLength(1);

      const policiesAfter = await db
        .select()
        .from(schema.toolInvocationPoliciesTable)
        .where(eq(schema.toolInvocationPoliciesTable.toolId, tool.id));
      expect(policiesAfter).toHaveLength(policiesBefore.length);

      const assignmentAfter = await db
        .select({ mcpServerId: schema.agentToolsTable.mcpServerId })
        .from(schema.agentToolsTable)
        .where(
          and(
            eq(schema.agentToolsTable.agentId, personalGateway.id),
            eq(schema.agentToolsTable.toolId, tool.id),
          ),
        );
      expect(assignmentAfter).toHaveLength(1);
      expect(assignmentAfter[0].mcpServerId).toBeNull();
    });

    test("refuses to delete an app server with 400", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        serverType: "app",
      });
      const appServer = await McpServerModel.create({
        name: "app-server",
        catalogId: catalog.id,
        serverType: "app",
        scope: "org",
        ownerId: user.id,
      });

      const response = await app.inject({
        method: "DELETE",
        url: `/api/mcp_server/${appServer.id}`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toBe(
        "App servers are managed via the Apps API; delete the app instead.",
      );
      await expect(
        McpServerModel.findById(appServer.id),
      ).resolves.not.toBeNull();
    });
  });

  describe("PATCH /api/mcp_server/:id/reauthenticate", () => {
    test("rejects a request with no credential fields (400)", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/mcp_server/${UNKNOWN_ID}/reauthenticate`,
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toBe(
        "At least one credential field is required",
      );
    });

    test("returns 404 for an unknown id when a credential is supplied", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/mcp_server/${UNKNOWN_ID}/reauthenticate`,
        payload: { accessToken: "fresh-token" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toBe("MCP server not found");
    });

    test("rejects re-authenticating an app server with 400", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        serverType: "app",
      });
      const appServer = await McpServerModel.create({
        name: "app-server",
        catalogId: catalog.id,
        serverType: "app",
        scope: "org",
        ownerId: user.id,
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/mcp_server/${appServer.id}/reauthenticate`,
        payload: { accessToken: "fresh-token" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toBe(
        "App servers are managed via the Apps API and have no credentials to re-authenticate.",
      );
    });
  });

  describe("POST /api/mcp_server/:id/reinstall", () => {
    test("returns 404 for an unknown id", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/mcp_server/${UNKNOWN_ID}/reinstall`,
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toBe("MCP server not found");
    });

    test("rejects reinstalling an app server with 400", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        serverType: "app",
      });
      const appServer = await McpServerModel.create({
        name: "app-server",
        catalogId: catalog.id,
        serverType: "app",
        scope: "org",
        ownerId: user.id,
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/mcp_server/${appServer.id}/reinstall`,
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toBe(
        "App servers run in-process and are not reinstallable; manage them via the Apps API.",
      );
    });
  });

  describe("POST /api/mcp_server", () => {
    test("returns 400 when the referenced catalog item does not exist", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: { name: "ghost", catalogId: UNKNOWN_ID, scope: "personal" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toBe("Catalog item not found");
    });

    test("returns 400 when installing an app-type catalog item", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        serverType: "app",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: { name: "app", catalogId: catalog.id, scope: "personal" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toBe(
        "App servers are managed via the Apps API and cannot be installed here.",
      );
    });

    test("ignores client-supplied OAuth refresh-failure fields — they are server-owned state", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "Refresh Field Injection Server",
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [],
          transportType: "streamable-http",
          httpPort: 8080,
          httpPath: "/mcp",
        },
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: {
          name: "Refresh Field Injection Server",
          catalogId: catalog.id,
          scope: "personal",
          // A caller cannot seed these at install time — they're written only
          // by the OAuth refresh subsystem, and oauthRefreshErrorDescription
          // is unsanitized if set directly (bypassing sanitizeOAuthErrorDescription).
          oauthRefreshError: "refresh_failed",
          oauthRefreshErrorMessage: "invalid_grant",
          oauthRefreshErrorDescription: "<script>alert(1)</script>",
          oauthRefreshFailedAt: new Date().toISOString(),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.oauthRefreshError).toBeNull();
      expect(body.oauthRefreshErrorMessage).toBeNull();
      expect(body.oauthRefreshErrorDescription).toBeNull();
      expect(body.oauthRefreshFailedAt).toBeNull();
    });
  });
});
