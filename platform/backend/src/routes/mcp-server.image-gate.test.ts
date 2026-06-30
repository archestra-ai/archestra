import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { InternalMcpCatalogModel, OrganizationModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { autoReinstallServer } from "@/services/mcp-reinstall";
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
  // The image gate resolves the catalog author's privilege; empty permissions
  // make the author a non-privileged member, so these image-based cases gate.
  getPermissionsForUserContext: () => Promise.resolve({}),
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
 * Install-time trusted-image-registry gate: a personal local catalog item whose
 * custom image is not in the target environment's trusted registries is blocked
 * (no mcp_server row, no startServer) until an admin approves the catalog item.
 */
describe("MCP Server Install - trusted-image-registry gate", () => {
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
    connectAndGetToolsMock.mockResolvedValue([]);

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

  async function makePersonalLocalCatalog(dockerImage: string) {
    return InternalMcpCatalogModel.create(
      {
        name: `gate-${crypto.randomUUID().slice(0, 8)}`,
        serverType: "local",
        scope: "personal",
        localConfig: { dockerImage },
      },
      { organizationId, authorId: user.id },
    );
  }

  async function installedRowCount(catalogId: string): Promise<number> {
    const rows = await db
      .select({ id: schema.mcpServersTable.id })
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.catalogId, catalogId));
    return rows.length;
  }

  test("blocks a personal local install with an untrusted image", async () => {
    await OrganizationModel.patch(organizationId, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const catalog = await makePersonalLocalCatalog("ghcr.io/evil/x:1");

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: { name: catalog.name, catalogId: catalog.id, scope: "personal" },
    });

    expect(response.statusCode).toBe(403);
    expect(k8sStartServerMock).not.toHaveBeenCalled();
    expect(await installedRowCount(catalog.id)).toBe(0);
    const flagged = await InternalMcpCatalogModel.findById(catalog.id);
    expect(flagged?.catalogItemApprovalStatus).toBe("pending");
  });

  test("deploys after the catalog item's image is approved", async () => {
    await OrganizationModel.patch(organizationId, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const catalog = await makePersonalLocalCatalog("ghcr.io/evil/x:1");

    const blocked = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: { name: catalog.name, catalogId: catalog.id, scope: "personal" },
    });
    expect(blocked.statusCode).toBe(403);

    await InternalMcpCatalogModel.approveImage({
      id: catalog.id,
      reviewedBy: user.id,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: { name: catalog.name, catalogId: catalog.id, scope: "personal" },
    });

    expect(response.statusCode).toBe(200);
    expect(k8sStartServerMock).toHaveBeenCalledTimes(1);
    expect(await installedRowCount(catalog.id)).toBe(1);
  });

  test("does not gate an image that matches the trusted registries", async () => {
    await OrganizationModel.patch(organizationId, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const catalog = await makePersonalLocalCatalog("ghcr.io/acme/server:1");

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: { name: catalog.name, catalogId: catalog.id, scope: "personal" },
    });

    expect(response.statusCode).toBe(200);
    expect(k8sStartServerMock).toHaveBeenCalledTimes(1);
  });

  test("does not gate when no trusted registries are configured", async () => {
    const catalog = await makePersonalLocalCatalog("ghcr.io/evil/x:1");

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: { name: catalog.name, catalogId: catalog.id, scope: "personal" },
    });

    expect(response.statusCode).toBe(200);
    expect(k8sStartServerMock).toHaveBeenCalledTimes(1);
  });

  // Redeploy paths (reinstall route + catalog-edit cascade + refresh-image) all
  // funnel through autoReinstallServer, so it carries the gate too — otherwise an
  // image edited to an untrusted value would be rolled onto the running pod.
  test("reinstall is blocked for an untrusted (edited) image", async ({
    makeMcpServer,
  }) => {
    await OrganizationModel.patch(organizationId, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const catalog = await makePersonalLocalCatalog("ghcr.io/evil/x:1");
    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
    });

    await expect(autoReinstallServer(server, catalog)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(k8sRestartServerMock).not.toHaveBeenCalled();
    const flagged = await InternalMcpCatalogModel.findById(catalog.id);
    expect(flagged?.catalogItemApprovalStatus).toBe("pending");
  });

  test("reinstall proceeds for a trusted image", async ({ makeMcpServer }) => {
    await OrganizationModel.patch(organizationId, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const catalog = await makePersonalLocalCatalog("ghcr.io/acme/foo:1");
    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
    });

    await autoReinstallServer(server, catalog);
    expect(k8sRestartServerMock).toHaveBeenCalled();
  });
});
