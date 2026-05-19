import { vi } from "vitest";
import {
  InternalMcpCatalogModel,
  McpPresetEntryModel,
  OrganizationModel,
} from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const {
  connectAndGetToolsMock,
  hasPermissionMock,
  userHasPermissionMock,
  k8sStartServerMock,
  k8sRestartServerMock,
  k8sStopServerMock,
  k8sGetOrLoadDeploymentMock,
} = vi.hoisted(() => ({
  connectAndGetToolsMock: vi.fn(),
  hasPermissionMock: vi.fn(),
  userHasPermissionMock: vi.fn(),
  k8sStartServerMock: vi.fn(),
  k8sRestartServerMock: vi.fn(),
  k8sStopServerMock: vi.fn(),
  k8sGetOrLoadDeploymentMock: vi.fn(),
}));

vi.mock("@/clients/mcp-client", () => ({
  McpServerNotReadyError: class extends Error {},
  McpServerConnectionTimeoutError: class extends Error {},
  default: {
    connectAndGetTools: connectAndGetToolsMock,
    invalidateConnectionsForServer: vi.fn(),
    inspectServer: vi.fn(),
  },
}));

vi.mock("@/auth/utils", () => ({
  hasPermission: hasPermissionMock,
  userHasPermission: userHasPermissionMock,
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

describe("MCP Server Install — validationRegex enforcement", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organization.id);

    hasPermissionMock.mockResolvedValue({ success: true });
    userHasPermissionMock.mockResolvedValue(true);
    k8sStartServerMock.mockResolvedValue(undefined);
    k8sRestartServerMock.mockResolvedValue(undefined);
    k8sStopServerMock.mockResolvedValue(undefined);
    k8sGetOrLoadDeploymentMock.mockResolvedValue(undefined);
    connectAndGetToolsMock.mockResolvedValue([
      {
        name: "noop",
        description: "noop",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: mcpServerRoutes } = await import("./mcp-server");
    await app.register(mcpServerRoutes);
  });

  afterEach(async () => {
    connectAndGetToolsMock.mockReset();
    hasPermissionMock.mockReset();
    userHasPermissionMock.mockReset();
    k8sStartServerMock.mockReset();
    k8sRestartServerMock.mockReset();
    k8sStopServerMock.mockReset();
    k8sGetOrLoadDeploymentMock.mockReset();
    await app.close();
  });

  test("preset entry regex rejects mismatched env value at install time", async ({
    makeInternalMcpCatalog,
  }) => {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "context7",
      validationRegex: "^https://",
    });

    const parent = await makeInternalMcpCatalog({
      name: "regex-parent",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "API_URL",
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

    const child = await InternalMcpCatalogModel.create(
      {
        name: `${parent.name}-context7`,
        childName: "context7",
        serverType: parent.serverType,
        localConfig: parent.localConfig,
        presetEntryId: entry.id,
        parentCatalogItemId: parent.id,
        scope: parent.scope,
      },
      { organizationId, authorId: user.id },
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: child.name,
        catalogId: child.id,
        environmentValues: { API_URL: "ftp://nope" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/"API_URL".*"context7"/);
  });

  test("preset entry regex allows matching env value through", async ({
    makeInternalMcpCatalog,
  }) => {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "context7",
      validationRegex: "^https://",
    });

    const parent = await makeInternalMcpCatalog({
      name: "regex-parent-pass",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "API_URL",
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

    const child = await InternalMcpCatalogModel.create(
      {
        name: `${parent.name}-context7`,
        childName: "context7",
        serverType: parent.serverType,
        localConfig: parent.localConfig,
        presetEntryId: entry.id,
        parentCatalogItemId: parent.id,
        scope: parent.scope,
      },
      { organizationId, authorId: user.id },
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: child.name,
        catalogId: child.id,
        environmentValues: { API_URL: "https://api.example.com" },
      },
    });

    expect(res.statusCode).toBe(200);
  });

  test("org-wide default regex rejects parent-install mismatched value", async ({
    makeInternalMcpCatalog,
  }) => {
    await OrganizationModel.patch(organizationId, {
      presetEntityDefaultValidationRegex: "^https://",
    });

    const parent = await makeInternalMcpCatalog({
      name: "default-regex-parent",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "API_URL",
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

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: parent.name,
        catalogId: parent.id,
        environmentValues: { API_URL: "ftp://nope" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/"API_URL"/);
  });

  test("preset entry regex rejects mismatched SECRET-type env value", async ({
    makeInternalMcpCatalog,
  }) => {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "context7",
      validationRegex: "^sk-",
    });

    const parent = await makeInternalMcpCatalog({
      name: "regex-secret-env-parent",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "API_TOKEN",
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

    const child = await InternalMcpCatalogModel.create(
      {
        name: `${parent.name}-context7`,
        childName: "context7",
        serverType: parent.serverType,
        localConfig: parent.localConfig,
        presetEntryId: entry.id,
        parentCatalogItemId: parent.id,
        scope: parent.scope,
      },
      { organizationId, authorId: user.id },
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: child.name,
        catalogId: child.id,
        environmentValues: { API_TOKEN: "not-a-real-token" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/"API_TOKEN".*"context7"/);
  });

  test("preset entry regex rejects mismatched HEADER (userConfig) value", async ({
    makeInternalMcpCatalog,
  }) => {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "context7",
      validationRegex: "^acme-",
    });

    const parent = await makeInternalMcpCatalog({
      name: "regex-header-parent",
      serverType: "remote",
      serverUrl: "https://api.example.com/mcp/",
      userConfig: {
        tenant_id: {
          type: "string",
          title: "Tenant",
          description: "Per-caller tenant",
          required: true,
          sensitive: false,
          headerName: "x-tenant-id",
          promptOnInstallation: true,
        },
      },
    });

    const child = await InternalMcpCatalogModel.create(
      {
        name: `${parent.name}-context7`,
        childName: "context7",
        serverType: parent.serverType,
        serverUrl: parent.serverUrl,
        userConfig: parent.userConfig,
        presetEntryId: entry.id,
        parentCatalogItemId: parent.id,
        scope: parent.scope,
      },
      { organizationId, authorId: user.id },
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: child.name,
        catalogId: child.id,
        userConfigValues: { tenant_id: "other-tenant" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/"tenant_id".*"context7"/);
  });

  test("preset entry regex allows matching HEADER (userConfig) value through", async ({
    makeInternalMcpCatalog,
  }) => {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "context7",
      validationRegex: "^acme-",
    });

    const parent = await makeInternalMcpCatalog({
      name: "regex-header-parent-pass",
      serverType: "remote",
      serverUrl: "https://api.example.com/mcp/",
      userConfig: {
        tenant_id: {
          type: "string",
          title: "Tenant",
          description: "Per-caller tenant",
          required: true,
          sensitive: false,
          headerName: "x-tenant-id",
          promptOnInstallation: true,
        },
      },
    });

    const child = await InternalMcpCatalogModel.create(
      {
        name: `${parent.name}-context7`,
        childName: "context7",
        serverType: parent.serverType,
        serverUrl: parent.serverUrl,
        userConfig: parent.userConfig,
        presetEntryId: entry.id,
        parentCatalogItemId: parent.id,
        scope: parent.scope,
      },
      { organizationId, authorId: user.id },
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: child.name,
        catalogId: child.id,
        userConfigValues: { tenant_id: "acme-prod" },
      },
    });

    expect(res.statusCode).toBe(200);
  });

  test("org-wide default regex rejects parent-install mismatched SECRET env value", async ({
    makeInternalMcpCatalog,
  }) => {
    await OrganizationModel.patch(organizationId, {
      presetEntityDefaultValidationRegex: "^sk-",
      presetEntityDefaultLabel: "Default",
    });

    const parent = await makeInternalMcpCatalog({
      name: "default-regex-secret-env",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "API_TOKEN",
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

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: parent.name,
        catalogId: parent.id,
        environmentValues: { API_TOKEN: "not-a-real-token" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/"API_TOKEN".*"Default"/);
  });

  test("org-wide default regex rejects parent-install mismatched HEADER (userConfig) value", async ({
    makeInternalMcpCatalog,
  }) => {
    await OrganizationModel.patch(organizationId, {
      presetEntityDefaultValidationRegex: "^acme-",
      presetEntityDefaultLabel: "Default",
    });

    const parent = await makeInternalMcpCatalog({
      name: "default-regex-header",
      serverType: "remote",
      serverUrl: "https://api.example.com/mcp/",
      userConfig: {
        tenant_id: {
          type: "string",
          title: "Tenant",
          description: "Per-caller tenant",
          required: true,
          sensitive: false,
          headerName: "x-tenant-id",
          promptOnInstallation: true,
        },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: parent.name,
        catalogId: parent.id,
        userConfigValues: { tenant_id: "other-tenant" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/"tenant_id".*"Default"/);
  });
});
