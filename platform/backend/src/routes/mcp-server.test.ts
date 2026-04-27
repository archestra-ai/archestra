import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import McpServerUserModel from "@/models/mcp-server-user";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const {
  connectAndGetToolsMock,
  exchangeEnterpriseManagedCredentialMock,
  hasPermissionMock,
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
  hasPermissionMock: vi.fn(),
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

vi.mock("@/auth/utils", () => ({
  hasPermission: hasPermissionMock,
}));

vi.mock("@/k8s/mcp-server-runtime", () => ({
  McpServerRuntimeManager: {
    isEnabled: true,
    startServer: k8sStartServerMock,
    restartServer: k8sRestartServerMock,
    stopServer: k8sStopServerMock,
    getOrLoadDeployment: k8sGetOrLoadDeploymentMock,
  },
}));

describe("mcp server inspect route", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let requestOrganizationId: string;
  const originalFetch = global.fetch;

  beforeEach(async ({ makeUser }) => {
    user = await makeUser();
    requestOrganizationId = crypto.randomUUID();
    hasPermissionMock.mockResolvedValue({ success: true });
    k8sStartServerMock.mockResolvedValue(undefined);
    k8sRestartServerMock.mockResolvedValue(undefined);
    k8sStopServerMock.mockResolvedValue(undefined);
    k8sGetOrLoadDeploymentMock.mockResolvedValue({
      waitForDeploymentReady: vi.fn().mockResolvedValue(undefined),
    });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        requestOrganizationId;
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
      serverType: "local",
    });
    const mcpServer = await params.makeMcpServer({
      ownerId: otherUser.id,
      catalogId: catalog.id,
    });

    hasPermissionMock.mockResolvedValueOnce({ success: false });

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
    makeOrganization,
    makeTeam,
    makeTeamMember,
  }) => {
    hasPermissionMock.mockResolvedValueOnce({ success: false });

    const organization = await makeOrganization();
    const selectedTeam = await makeTeam(organization.id, user.id, {
      name: "Selected Team",
    });
    const otherTeam = await makeTeam(organization.id, user.id, {
      name: "Other Team",
    });
    await makeTeamMember(selectedTeam.id, user.id);
    await makeTeamMember(otherTeam.id, user.id);

    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const selectedServer = await makeMcpServer({
      ownerId: user.id,
      catalogId: catalog.id,
      teamId: selectedTeam.id,
    });
    await makeMcpServer({
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
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    hasPermissionMock.mockResolvedValueOnce({ success: true });

    const organization = await makeOrganization();
    const otherUser = await makeUser({ email: "other-owner@example.com" });
    const selectedTeam = await makeTeam(organization.id, user.id, {
      name: "Selected Team",
    });
    await makeTeamMember(selectedTeam.id, user.id);

    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
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
    hasPermissionMock.mockResolvedValueOnce({ success: true });

    const organization = await makeOrganization();
    requestOrganizationId = organization.id;
    const memberOwner = await makeUser({ email: "member-owner@example.com" });
    const outsideOwner = await makeUser({ email: "outside-owner@example.com" });
    await makeMember(memberOwner.id, organization.id, { role: "member" });

    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
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
    hasPermissionMock.mockResolvedValueOnce({ success: true });

    const organization = await makeOrganization();
    requestOrganizationId = organization.id;
    const otherUser = await makeUser({ email: "personal-other@example.com" });
    const authorTeam = await makeTeam(organization.id, user.id, {
      name: "Author Team",
    });
    const otherTeam = await makeTeam(organization.id, user.id, {
      name: "Other Team",
    });
    await makeTeamMember(authorTeam.id, user.id);

    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
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

  test("automatically retries protected remote MCP server installation with an exchanged enterprise-managed credential", async ({
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
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
        },
      },
    });

    const catalog = await makeInternalMcpCatalog({
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
      issuedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      value: "exchanged-github-token",
    });

    connectAndGetToolsMock
      .mockRejectedValueOnce(
        new Error(
          "Failed to connect to MCP server GitHub: Streamable HTTP error: Error POSTing to endpoint: bad request: missing required Authorization header",
        ),
      )
      .mockResolvedValueOnce([
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
    expect(connectAndGetToolsMock.mock.calls[1][0]).toMatchObject({
      secrets: { access_token: "exchanged-github-token" },
    });
  });

  test("persists enterprise-managed config on installed MCP servers", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
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

  test("reinstalls a protected remote MCP server using the current identity-provider access token fallback", async ({
    makeAccount,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
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
      requestOrganizationId = org.id;
      await makeMember(user.id, requestOrganizationId);
    });

    test("remote install with empty agentIds auto-assigns every tool to the installer's personal gateway", async ({
      makeInternalMcpCatalog,
    }) => {
      const { default: AgentModel } = await import("@/models/agent");
      const { default: AgentToolModel } = await import("@/models/agent-tool");

      const catalog = await makeInternalMcpCatalog({
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
        requestOrganizationId,
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
        organizationId: requestOrganizationId,
        authorId: user.id,
      });

      const catalog = await makeInternalMcpCatalog({
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
        requestOrganizationId,
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
      await makeMember(otherUser.id, requestOrganizationId);
      const otherPersonalGateway = await AgentModel.ensurePersonalMcpGateway({
        userId: otherUser.id,
        organizationId: requestOrganizationId,
      });

      const catalog = await makeInternalMcpCatalog({
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
        requestOrganizationId,
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

      const team = await makeTeam(requestOrganizationId, user.id, {
        name: "Auto Assign Team",
      });

      const catalog = await makeInternalMcpCatalog({
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
          teamId: team.id,
        },
      });
      expect(response.statusCode).toBe(200);

      const personalGateway = await AgentModel.getPersonalMcpGateway(
        user.id,
        requestOrganizationId,
      );
      const personalAssignments = personalGateway
        ? await AgentToolModel.findToolIdsByAgent(personalGateway.id)
        : [];
      expect(personalAssignments.length).toBe(0);
    });
  });
});
