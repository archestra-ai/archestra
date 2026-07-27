import { eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import db, { schema } from "@/database";
import { InternalMcpCatalogModel, McpServerModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

// Force the K8s runtime ON so the shared-deployment recreate is reachable, and
// stub the cluster calls — we assert which primitive the route picks, not what
// it does to a pod.
vi.mock("@/k8s/mcp-server-runtime/manager", () => ({
  default: {
    isEnabled: true,
    getOrLoadDeployment: vi.fn().mockResolvedValue(undefined),
    tearDownOldNamespaceDeployments: vi.fn().mockResolvedValue(undefined),
    reinstallSharedDeployment: vi.fn().mockResolvedValue(undefined),
    restartServer: vi.fn().mockResolvedValue(undefined),
    validateNamespace: vi.fn().mockResolvedValue(undefined),
  },
}));

import { hasPermission } from "@/auth";
import mcpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";

const mockHasPermission = hasPermission as Mock;
const reinstallSharedSpy =
  mcpServerRuntimeManager.reinstallSharedDeployment as Mock;

async function drainCascade(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * A multi-tenant local catalog has one shared K8s Deployment. Execution-config
 * drift on it is a catalog-scope event owned by the admin doing the edit, so
 * the recreate runs on save rather than waiting behind the card's Reinstall
 * button — and no tenant is marked reinstall-required, because stored
 * credentials stay valid. The exception is an edit that also changes the
 * prompted schema: the pod can't come back on a spec nobody has supplied
 * values for, so that defers to `catalogReinstallRequired`.
 */
describe("PUT /api/internal_mcp_catalog/:id — multi-tenant shared-pod rollout", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    // The recreate's second phase syncs tools per install, which otherwise
    // reaches the real MCP client. Its failure path writes exactly the
    // `reinstallRequired` / `reinstallReason` fields these tests assert on, so
    // leaving it live would decide those assertions by whether a doomed
    // connection attempt happens to settle inside `drainCascade` — and the
    // pending promise would outlive this file's database (see test/setup.ts).
    vi.spyOn(McpServerModel, "getToolsFromServer").mockResolvedValue([
      { name: "test-tool", description: "A test tool", inputSchema: {} },
    ]);

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organization.id, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import("./internal-mcp-catalog");
    await app.register(routes);
  });

  afterEach(async () => {
    await drainCascade();
    vi.restoreAllMocks();
    await app.close();
  });

  const localConfig = {
    command: "node",
    arguments: ["server.js"],
    dockerImage: "example/image:1.0",
    environment: [],
  };

  async function makeCatalogWithInstalls(
    makeMcpServer: (overrides: {
      catalogId: string;
    }) => Promise<{ id: string }>,
    options: { multitenant: boolean; installCount?: number },
  ) {
    const name = `mt-rollout-${crypto.randomUUID().slice(0, 8)}`;
    const catalog = await InternalMcpCatalogModel.create(
      {
        name,
        serverType: "local",
        multitenant: options.multitenant,
        localConfig,
        scope: "org",
      },
      { organizationId },
    );
    const servers = [];
    for (let i = 0; i < (options.installCount ?? 1); i++) {
      servers.push(await makeMcpServer({ catalogId: catalog.id }));
    }
    return { catalog, name, serverIds: servers.map((s) => s.id) };
  }

  async function getCatalogRow(catalogId: string) {
    const [row] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalogId));
    return row;
  }

  async function getServerRow(serverId: string) {
    const [row] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, serverId));
    return row;
  }

  test("image bump recreates the shared deployment once and leaves every tenant unflagged", async ({
    makeMcpServer,
  }) => {
    const { catalog, name, serverIds } = await makeCatalogWithInstalls(
      makeMcpServer,
      { multitenant: true, installCount: 2 },
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name,
        serverType: "local",
        localConfig: { ...localConfig, dockerImage: "example/image:2.0" },
      },
    });
    expect(response.statusCode).toBe(200);
    await drainCascade();

    // One recreate for the one shared pod — not one per install.
    expect(reinstallSharedSpy).toHaveBeenCalledTimes(1);
    expect(reinstallSharedSpy).toHaveBeenCalledWith(catalog.id);

    // Nothing is left pending: no card banner, no per-tenant Reinstall button.
    expect((await getCatalogRow(catalog.id)).catalogReinstallRequired).toBe(
      false,
    );
    for (const serverId of serverIds) {
      const row = await getServerRow(serverId);
      expect(row.reinstallRequired).toBe(false);
      expect(row.reinstallReason).toBeNull();
    }
  });

  test("command change takes the same rollout path as an image bump", async ({
    makeMcpServer,
  }) => {
    const { catalog, name, serverIds } = await makeCatalogWithInstalls(
      makeMcpServer,
      { multitenant: true },
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name,
        serverType: "local",
        localConfig: { ...localConfig, command: "bash" },
      },
    });
    expect(response.statusCode).toBe(200);
    await drainCascade();

    expect(reinstallSharedSpy).toHaveBeenCalledWith(catalog.id);
    expect((await getCatalogRow(catalog.id)).catalogReinstallRequired).toBe(
      false,
    );
    expect((await getServerRow(serverIds[0])).reinstallRequired).toBe(false);
  });

  test("an image bump carrying a new required prompted env var defers the recreate instead", async ({
    makeMcpServer,
  }) => {
    const { catalog, name, serverIds } = await makeCatalogWithInstalls(
      makeMcpServer,
      { multitenant: true },
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name,
        serverType: "local",
        localConfig: {
          ...localConfig,
          dockerImage: "example/image:2.0",
          environment: [
            {
              key: "API_TOKEN",
              type: "secret",
              sensitive: true,
              required: true,
              promptOnInstallation: true,
            },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(200);
    await drainCascade();

    // The pod would come back missing a value no tenant has supplied.
    expect(reinstallSharedSpy).not.toHaveBeenCalled();
    expect((await getCatalogRow(catalog.id)).catalogReinstallRequired).toBe(
      true,
    );
    const row = await getServerRow(serverIds[0]);
    expect(row.reinstallRequired).toBe(true);
    expect(row.reinstallReason).toBe("new-input");
  });

  test("a failed recreate falls back to the catalog Reinstall button", async ({
    makeMcpServer,
  }) => {
    const { catalog, name } = await makeCatalogWithInstalls(makeMcpServer, {
      multitenant: true,
    });
    reinstallSharedSpy.mockRejectedValueOnce(new Error("cluster unreachable"));

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name,
        serverType: "local",
        localConfig: { ...localConfig, dockerImage: "example/image:2.0" },
      },
    });
    expect(response.statusCode).toBe(200);
    await drainCascade();

    // Attempted-then-failed, not skipped — the flag has to come from the
    // catch, otherwise this passes for a deferral that never tried.
    expect(reinstallSharedSpy).toHaveBeenCalledWith(catalog.id);
    // Pod is still on the old spec — the admin needs a retry affordance.
    expect((await getCatalogRow(catalog.id)).catalogReinstallRequired).toBe(
      true,
    );
  });

  test("a queued recreate stands down when the catalog already owes a manual reinstall", async ({
    makeMcpServer,
  }) => {
    const { catalog, name } = await makeCatalogWithInstalls(makeMcpServer, {
      multitenant: true,
    });
    // An earlier edit needed input no tenant has supplied yet.
    await InternalMcpCatalogModel.update(catalog.id, {
      catalogReinstallRequired: true,
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name,
        serverType: "local",
        localConfig: { ...localConfig, dockerImage: "example/image:2.0" },
      },
    });
    expect(response.statusCode).toBe(200);
    await drainCascade();

    // Rolling now would bring the pod back on a spec nobody can satisfy, and
    // clear the flag that asks for the values.
    expect(reinstallSharedSpy).not.toHaveBeenCalled();
    expect((await getCatalogRow(catalog.id)).catalogReinstallRequired).toBe(
      true,
    );
  });

  test("single-tenant image bump still marks installs and never touches the shared primitive", async ({
    makeMcpServer,
  }) => {
    const { catalog, name, serverIds } = await makeCatalogWithInstalls(
      makeMcpServer,
      { multitenant: false },
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name,
        serverType: "local",
        localConfig: { ...localConfig, dockerImage: "example/image:2.0" },
      },
    });
    expect(response.statusCode).toBe(200);
    await drainCascade();

    expect(reinstallSharedSpy).not.toHaveBeenCalled();
    const row = await getServerRow(serverIds[0]);
    expect(row.reinstallRequired).toBe(true);
    expect(row.reinstallReason).toBe("restart");
  });
});
