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
 * The install route must mirror the preset editor for `presetFieldValues`:
 *  - non-secret values land on `internal_mcp_catalog.preset_field_values` (JSONB)
 *  - secret-flagged values are partitioned into `preset_secret_id` (via secretManager)
 *  - keys absent from the payload are NOT wiped (the install dialog only sends
 *    the fields the user filled in; previously-filled values must survive)
 *  - catalogs without preset-scoped fields still install successfully
 */
describe("MCP Server Install - Preset Field Values Persistence", () => {
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

  // ===========================================================================
  // 1. Preset values are routed to preset_field_values / preset_secret_id
  //    depending on whether the field is secret-flagged.
  // ===========================================================================

  test("non-secret env preset value → preset_field_values JSONB; secret env preset value → preset_secret_id bag; sensitive userConfig (header) preset value → preset_secret_id bag", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "install-preset-routing",
      serverType: "local",
      userConfig: {
        tenant_id: {
          type: "string",
          title: "Tenant",
          description: "Preset-scoped tenant header",
          required: false,
          sensitive: false,
          headerName: "x-tenant-id",
          promptOnPreset: true,
        },
        api_key: {
          type: "string",
          title: "API Key",
          description: "Preset-scoped sensitive header",
          required: false,
          sensitive: true,
          headerName: "authorization",
          promptOnPreset: true,
        },
      },
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

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "install-preset-routing",
        catalogId: catalog.id,
        presetFieldValues: {
          STAGE: "production",
          INTERNAL_TOKEN: "secret-env-value",
          tenant_id: "acme-corp",
          api_key: "header-secret-value",
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));

    // Non-secret preset values land directly on the JSONB column.
    expect(row?.presetFieldValues).toEqual({
      STAGE: "production",
      tenant_id: "acme-corp",
    });

    // Secret-flagged preset values are partitioned into the preset secret bag.
    const presetSecretId = row?.presetSecretId;
    if (!presetSecretId) throw new Error("expected row.presetSecretId");
    const bag = await secretManager().getSecret(presetSecretId);
    expect(bag?.secret).toEqual({
      INTERNAL_TOKEN: "secret-env-value",
      api_key: "header-secret-value",
    });
  });

  // ===========================================================================
  // 2. Subsequent installs only send the unfilled subset — previously-filled
  //    values must survive (merge, not replace).
  // ===========================================================================

  test("install payload missing already-persisted preset keys preserves them on the catalog row", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "install-preset-merge",
      serverType: "local",
      userConfig: {
        region: {
          type: "string",
          title: "Region",
          description: "Preset-scoped",
          required: false,
          sensitive: false,
          headerName: "x-region",
          promptOnPreset: true,
        },
      },
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

    // Simulate the catalog row already carrying a previously-filled preset
    // value (e.g. from an earlier install or a preset-editor save). The
    // install dialog will then only render the still-unfilled fields and
    // send only those — verify the existing `region` value is preserved.
    await InternalMcpCatalogModel.update(catalog.id, {
      presetFieldValues: { region: "eu-west-1" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "install-preset-merge",
        catalogId: catalog.id,
        presetFieldValues: {
          STAGE: "staging",
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));

    expect(row?.presetFieldValues).toEqual({
      region: "eu-west-1",
      STAGE: "staging",
    });
  });

  // ===========================================================================
  // 3. Catalogs without any preset-scoped fields still install successfully.
  // ===========================================================================

  test("catalog with no preset-scoped fields installs without writing preset state", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "install-no-preset-fields",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "PLAIN_VAR",
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

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "install-no-preset-fields",
        catalogId: catalog.id,
        environmentValues: { PLAIN_VAR: "hello" },
      },
    });

    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));

    expect(row?.presetFieldValues).toEqual({});
    expect(row?.presetSecretId).toBeNull();
  });
});
