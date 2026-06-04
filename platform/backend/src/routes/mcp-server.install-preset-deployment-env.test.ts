import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { InternalMcpCatalogModel } from "@/models";
import { secretManager } from "@/secrets-manager";
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

/**
 * Preset-scoped values stored on the catalog row must reach the K8s deployment
 * env on install:
 *   - non-secret preset env entries (catalogItem.presetFieldValues[envKey])
 *     → environmentValues passed to McpServerRuntimeManager.startServer
 *   - secret preset env entries (resolved from catalogItem.presetSecretId bag)
 *     → install secret bag (mcp_server.secret_id), same destination used for
 *       per-install secret-type env vars
 *
 * Without this plumbing the pod ships missing those env vars entirely (or with
 * empty secretKeyRef values), which is what bit the mcpeverything-ildar install
 * in dev.
 */
describe("MCP Server Install - Preset Values reach Deployment Env", () => {
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
    k8sGetOrLoadDeploymentMock.mockResolvedValue({
      waitForDeploymentReady: vi.fn().mockResolvedValue(undefined),
    });
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

  test("plain_text preset env from catalog presetFieldValues reaches startServer environmentValues", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "preset-env-deploy-plain",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "STAGE",
            type: "plain_text",
            promptOnInstallation: false,
            promptOnPreset: true,
            required: false,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    // Simulate the preset value already being persisted on the catalog row
    // (e.g. via the preset editor or an earlier install). The install dialog
    // does NOT re-prompt for already-filled preset fields, so the install
    // request itself carries no presetFieldValues.
    await InternalMcpCatalogModel.update(catalog.id, {
      presetFieldValues: { STAGE: "production" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "preset-env-deploy-plain",
        catalogId: catalog.id,
      },
    });

    expect(response.statusCode).toBe(200);

    expect(k8sStartServerMock).toHaveBeenCalledTimes(1);
    const [, , envValues] = k8sStartServerMock.mock.calls[0];
    expect(envValues).toMatchObject({ STAGE: "production" });
  });

  test("secret preset env from catalog presetSecretId bag lands in install secret bag", async ({
    makeInternalMcpCatalog,
    makeSecret,
  }) => {
    const presetSecret = await makeSecret({
      name: "preset-secret-bag",
      secret: { INTERNAL_TOKEN: "preset-secret-val" },
    });

    const catalog = await makeInternalMcpCatalog({
      name: "preset-env-deploy-secret",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "INTERNAL_TOKEN",
            type: "secret",
            promptOnInstallation: false,
            promptOnPreset: true,
            required: false,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    await InternalMcpCatalogModel.update(catalog.id, {
      presetSecretId: presetSecret.id,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "preset-env-deploy-secret",
        catalogId: catalog.id,
      },
    });

    expect(response.statusCode).toBe(200);

    const [server] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.catalogId, catalog.id));

    const secretId = server?.secretId;
    if (!secretId) throw new Error("expected server.secretId");
    const installBag = await secretManager().getSecret(secretId);
    expect(installBag?.secret).toMatchObject({
      INTERNAL_TOKEN: "preset-secret-val",
    });

    // The env builder gates secretKeyRef emission on a non-empty entry in
    // envMap[key], which it populates from environmentValues for any envDef
    // with promptOnInstallation OR promptOnPreset. The install route must
    // therefore also surface preset-scoped secret values in environmentValues
    // so the resulting deployment actually references the K8s Secret entry
    // (otherwise the K8s Secret has the data but the pod gets no env var).
    expect(k8sStartServerMock).toHaveBeenCalledTimes(1);
    const [, , envValues] = k8sStartServerMock.mock.calls[0];
    expect(envValues).toMatchObject({ INTERNAL_TOKEN: "preset-secret-val" });
  });

  test("install-time environmentValues override preset plain_text values for the same key", async ({
    makeInternalMcpCatalog,
  }) => {
    // Edge case: if the install dialog also accepted user input for a
    // preset-scoped key, the user-entered value should win. (In practice the
    // dialog filters out already-filled preset keys, but the precedence rule
    // is what makes the merge safe.)
    const catalog = await makeInternalMcpCatalog({
      name: "preset-env-deploy-precedence",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "STAGE",
            type: "plain_text",
            promptOnInstallation: false,
            promptOnPreset: true,
            required: false,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    await InternalMcpCatalogModel.update(catalog.id, {
      presetFieldValues: { STAGE: "production" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "preset-env-deploy-precedence",
        catalogId: catalog.id,
        environmentValues: { STAGE: "staging" },
      },
    });

    expect(response.statusCode).toBe(200);

    const [, , envValues] = k8sStartServerMock.mock.calls[0];
    expect(envValues).toMatchObject({ STAGE: "staging" });
  });
});
