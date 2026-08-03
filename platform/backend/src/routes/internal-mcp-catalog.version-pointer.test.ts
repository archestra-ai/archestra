import { eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import InternalMcpCatalogVersionModel from "@/models/internal-mcp-catalog-version";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// The write paths under test never reach K8s; keep the runtime disabled so a
// config edit doesn't try to reconcile a deployment.
const { managerMock } = vi.hoisted(() => ({
  managerMock: {
    isEnabled: false,
    deploymentNamesAdopted: Promise.resolve() as Promise<void>,
    tearDownOldNamespaceDeployments: vi.fn(),
    reinstallSharedDeployment: vi.fn(),
    restartServer: vi.fn(),
    getOrLoadDeployment: vi.fn(),
  },
}));
vi.mock("@/k8s/mcp-server-runtime/manager", () => ({ default: managerMock }));

vi.mock("@/auth");

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

/**
 * `latest_version` is the server-managed head pointer into
 * `mcp_catalog_versions`, and `forkIfChanged` trusts it to compute the next
 * version number. It must therefore never be settable from a request body: a
 * large value makes the retention pruner delete the real history below the
 * poisoned head, and a value of 0 makes every later fork retry version 1
 * forever against the `(catalog_id, version)` unique index — swallowed by the
 * best-effort wrapper, so the item silently stops recording history.
 */
describe("PUT/POST /api/internal_mcp_catalog — latestVersion is not client-settable", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    config.orchestrator.kubernetes.kubeconfig = undefined;
    config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster = false;
    managerMock.deploymentNamesAdopted = Promise.resolve();

    user = await makeUser();
    organizationId = (await makeOrganization()).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import("./internal-mcp-catalog");
    await app.register(routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("a huge latestVersion in the body does not advance the head or prune history", async () => {
    const catalog = await createCatalog({
      name: "pointer-prune",
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
    });
    await InternalMcpCatalogModel.update(catalog.id, { description: "second" });
    await InternalMcpCatalogModel.update(catalog.id, { description: "third" });

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { latestVersion: 900000, description: "jumped" },
    });

    expect(response.statusCode).toBe(200);

    // The head advanced by exactly one, not to 900001.
    expect(await headVersion(catalog.id)).toBe(4);

    // Nothing was pruned: the retention floor would have been 899902.
    const versions = await InternalMcpCatalogVersionModel.listForCatalog({
      catalogId: catalog.id,
      pagination: { limit: 50, offset: 0 },
    });
    expect(versions.pagination.total).toBe(4);
    expect(versions.data.map((v) => v.version)).toEqual([4, 3, 2, 1]);
  });

  test("a zero latestVersion in the body does not wedge future forks", async () => {
    const catalog = await createCatalog({
      name: "pointer-wedge",
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
    });
    await InternalMcpCatalogModel.update(catalog.id, { description: "second" });

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { latestVersion: 0, description: "later" },
    });

    expect(response.statusCode).toBe(200);
    expect(await headVersion(catalog.id)).toBe(3);

    // A further edit still forks rather than colliding on version 1.
    await InternalMcpCatalogModel.update(catalog.id, { description: "later2" });
    expect(await headVersion(catalog.id)).toBe(4);

    const v4 = await InternalMcpCatalogVersionModel.findByCatalogAndVersion({
      catalogId: catalog.id,
      version: 4,
    });
    expect(v4?.snapshot.description).toBe("later2");
  });

  test("latestVersion supplied at creation is ignored", async () => {
    const catalog = await createCatalog({
      name: "pointer-create",
      serverType: "local",
      localConfig: { command: "node", arguments: ["server.js"] },
      latestVersion: 500,
    });

    // create() forks version 1; the supplied value never reaches the row.
    expect(await headVersion(catalog.id)).toBe(1);
  });

  async function headVersion(catalogId: string): Promise<number> {
    const [row] = await db
      .select({ latestVersion: schema.internalMcpCatalogTable.latestVersion })
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalogId));
    return row.latestVersion;
  }

  async function createCatalog(payload: Record<string, unknown>): Promise<{
    id: string;
  }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload,
    });
    if (response.statusCode !== 200) {
      throw new Error(
        `createCatalog failed: ${response.statusCode} ${response.body}`,
      );
    }
    return response.json();
  }
});
