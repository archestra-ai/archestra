import { vi } from "vitest";
import { OrganizationModel } from "@/models";
import McpServerModel from "@/models/mcp-server";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const {
  invalidateConnectionsForServerMock,
  hasPermissionMock,
  userHasPermissionMock,
  k8sRestartServerMock,
} = vi.hoisted(() => ({
  invalidateConnectionsForServerMock: vi.fn(),
  hasPermissionMock: vi.fn(),
  userHasPermissionMock: vi.fn(),
  k8sRestartServerMock: vi.fn(),
}));

vi.mock("@/clients/mcp-client", () => ({
  McpServerNotReadyError: class extends Error {},
  McpServerConnectionTimeoutError: class extends Error {},
  default: {
    invalidateConnectionsForServer: invalidateConnectionsForServerMock,
  },
}));

vi.mock("@/auth/utils", () => ({
  hasPermission: hasPermissionMock,
  userHasPermission: userHasPermissionMock,
}));

vi.mock("@/k8s/mcp-server-runtime", () => ({
  McpServerRuntimeManager: {
    isEnabled: true,
    restartServer: k8sRestartServerMock,
  },
}));

describe("PATCH /api/mcp_server/:id/reauthenticate", () => {
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
    invalidateConnectionsForServerMock.mockResolvedValue(undefined);
    k8sRestartServerMock.mockResolvedValue(undefined);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organization.id;
    });

    const { default: mcpServerRoutes } = await import("./mcp-server");
    await app.register(mcpServerRoutes);
  });

  test("clears the needs-reauthentication trio on successful re-authentication", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "reauth-clears-server",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      oauthConfig: {
        name: "reauth-clears-server",
        server_url: "https://mcp.example.com/mcp",
        client_id: "test-client-id",
        redirect_uris: ["http://localhost:3000/callback"],
        scopes: [],
        default_scopes: [],
        supports_resource_metadata: false,
      },
    });

    const oldSecret = await secretManager().createSecret(
      { access_token: "stale", refresh_token: "stale-refresh" },
      "reauth-old-secret",
    );
    const newSecret = await secretManager().createSecret(
      { access_token: "fresh", refresh_token: "fresh-refresh" },
      "reauth-new-secret",
    );

    const server = await McpServerModel.create({
      name: "reauth-clears-server",
      catalogId: catalog.id,
      secretId: oldSecret.id,
      serverType: "remote",
      ownerId: user.id,
    });

    await McpServerModel.update(server.id, {
      oauthRefreshError: "refresh_failed",
      oauthRefreshErrorMessage: "invalid_grant",
      oauthRefreshFailedAt: new Date(Date.now() - 60_000),
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/mcp_server/${server.id}/reauthenticate`,
      payload: { secretId: newSecret.id },
    });

    expect(response.statusCode).toBe(200);
    const row = await McpServerModel.findById(server.id);
    expect(row?.secretId).toBe(newSecret.id);
    expect(row?.oauthRefreshError).toBeNull();
    expect(row?.oauthRefreshErrorMessage).toBeNull();
    expect(row?.oauthRefreshFailedAt).toBeNull();
  });

  test("rejects re-auth before swapping the secret when the image is untrusted", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    await OrganizationModel.patch(organizationId, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: "ghcr.io/evil/x:1" },
    });
    const newSecret = await secretManager().createSecret(
      { token: "new" },
      "reauth-gate-new",
    );
    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
    });
    const secretIdBefore = server.secretId;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/mcp_server/${server.id}/reauthenticate`,
      payload: { secretId: newSecret.id },
    });

    // Blocked before any mutation: no secret swap, no pod restart, no false 200.
    expect(response.statusCode).toBe(403);
    const row = await McpServerModel.findById(server.id);
    expect(row?.secretId).toBe(secretIdBefore);
    expect(k8sRestartServerMock).not.toHaveBeenCalled();
  });
});
