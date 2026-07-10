import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { hasPermission, userHasPermission } from "@/auth/utils";
import db, { schema } from "@/database";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const {
  connectAndGetToolsMock,
  k8sStartServerMock,
  k8sRestartServerMock,
  k8sStopServerMock,
  k8sGetOrLoadDeploymentMock,
} = vi.hoisted(() => ({
  connectAndGetToolsMock: vi.fn(),
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

/**
THESE TESTS ARE COVERING EXISING BEHAVIOUR AND EXISTS TO MAKE SURE WE DON'T BREAK IT ACCIDENTALLY.
THERE ARE COUPLE OF WEIRDNESS REAGRDING HOW SECRETS ARE STORED (e.g. per user prompted non-secrets are anyway stored in the secret table).
IT'S OK TO FIX IT.
 */

/**
 * Per-install secret routing: when a user installs an MCP server, which of the
 * values they supplied at install time end up in the install-scoped secret bag
 * (`mcp_server.secret_id` → `secret` row) vs. which are passed transiently to
 * the runtime and not persisted.
 */
describe("MCP Server Install - Per-User Value Routing", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

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
  // ENV VARS
  // ===========================================================================

  describe("env vars", () => {
    test("per-user + secret → value lands in install secret bag", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "install-env-secret",
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "USER_TOKEN",
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

      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: {
          name: "install-env-secret",
          catalogId: catalog.id,
          environmentValues: {
            USER_TOKEN: "user-supplied-secret-1",
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const bag = await loadInstallSecret(catalog.id);
      expect(bag).toEqual({ USER_TOKEN: "user-supplied-secret-1" });
    });

    // TODO: verify this is the intended behavior. Prompted plain_text env vars
    // are handed to the K8s runtime once at install and not persisted anywhere,
    // so reinstall (or any later pod recreate that doesn't replay the original
    // environmentValues) will lose the value. If we decide they SHOULD persist,
    // the only existing install-time sink today is the row referenced by
    // mcp_server.secret_id (despite the name, it already holds non-sensitive
    // prompted headers like tenant_id), so this test would flip to assert the
    // value lands there. A cleaner long-term fix is a dedicated non-secret
    // column for plain prompted values.
    test("per-user + plain → value passed transiently, NOT in install secret bag", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "install-env-plain",
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "WORKSPACE",
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

      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: {
          name: "install-env-plain",
          catalogId: catalog.id,
          environmentValues: {
            WORKSPACE: "my-workspace",
          },
        },
      });

      expect(response.statusCode).toBe(200);

      const [server] = await db
        .select()
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.catalogId, catalog.id));
      expect(server?.secretId).toBeNull();

      expect(k8sStartServerMock).toHaveBeenCalledTimes(1);
      const [, , envValues] = k8sStartServerMock.mock.calls[0];
      expect(envValues).toEqual({ WORKSPACE: "my-workspace" });
    });

    test("mixed: per-user secret env + catalog static secret env → both end up in the same install secret bag", async ({
      makeInternalMcpCatalog,
      makeSecret,
    }) => {
      const catalogSecret = await makeSecret({
        name: "catalog-env-secret",
        secret: { CATALOG_KEY: "catalog-value" },
      });

      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "install-env-mixed",
        serverType: "local",
        localConfigSecretId: catalogSecret.id,
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "CATALOG_KEY",
              type: "secret",
              promptOnInstallation: false,
            },
            {
              key: "USER_TOKEN",
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

      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: {
          name: "install-env-mixed",
          catalogId: catalog.id,
          environmentValues: {
            USER_TOKEN: "user-token-1",
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const bag = await loadInstallSecret(catalog.id);
      expect(bag).toMatchObject({
        CATALOG_KEY: "catalog-value",
        USER_TOKEN: "user-token-1",
      });
    });
  });

  // ===========================================================================
  // HEADERS — userConfig[field] with headerName
  // ===========================================================================

  describe("headers", () => {
    test("local + per-user + sensitive → value lands in install secret bag", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "install-header-sensitive-local",
        serverType: "local",
        userConfig: {
          access_token: {
            type: "string",
            title: "Access Token",
            description: "Per-caller token",
            required: true,
            sensitive: true,
            headerName: "authorization",
            promptOnInstallation: true,
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
          name: "install-header-sensitive-local",
          catalogId: catalog.id,
          userConfigValues: { access_token: "user-token-1" },
        },
      });

      expect(response.statusCode).toBe(200);
      const bag = await loadInstallSecret(catalog.id);
      expect(bag).toMatchObject({ access_token: "user-token-1" });
    });

    test("local + per-user + non-sensitive → value lands in install secret bag", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "install-header-plain-local",
        serverType: "local",
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
          name: "install-header-plain-local",
          catalogId: catalog.id,
          userConfigValues: { tenant_id: "acme" },
        },
      });

      expect(response.statusCode).toBe(200);
      const bag = await loadInstallSecret(catalog.id);
      expect(bag).toMatchObject({ tenant_id: "acme" });
    });

    test("remote + per-user + sensitive → value lands in install secret bag", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "install-header-sensitive-remote",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          access_token: {
            type: "string",
            title: "Access Token",
            description: "Per-caller token",
            required: true,
            sensitive: true,
            headerName: "authorization",
            promptOnInstallation: true,
          },
        },
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: {
          name: "install-header-sensitive-remote",
          catalogId: catalog.id,
          userConfigValues: { access_token: "remote-token-1" },
        },
      });

      expect(response.statusCode).toBe(200);
      const bag = await loadInstallSecret(catalog.id);
      expect(bag).toMatchObject({ access_token: "remote-token-1" });
    });

    test("remote + per-user + non-sensitive → value lands in install secret bag", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "install-header-plain-remote",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
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

      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        payload: {
          name: "install-header-plain-remote",
          catalogId: catalog.id,
          userConfigValues: { tenant_id: "acme" },
        },
      });

      expect(response.statusCode).toBe(200);
      const bag = await loadInstallSecret(catalog.id);
      expect(bag).toMatchObject({ tenant_id: "acme" });
    });
  });

  // ===========================================================================
  // Helpers
  // ===========================================================================

  async function loadInstallSecret(catalogId: string) {
    const [server] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.catalogId, catalogId));
    if (!server?.secretId) {
      throw new Error(
        `Expected install for catalog ${catalogId} to persist a secretId`,
      );
    }
    const stored = await secretManager().getSecret(server.secretId);
    return stored?.secret as Record<string, unknown>;
  }
});
