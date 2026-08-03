import { eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

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
 * `expectedRevision` turns the catalog PUT into a compare-and-set. The edit
 * dialog is a whole-object read-modify-write whose stale window spans the HTTP
 * round trip, so without this a second admin's save silently reverts every
 * field the first one changed — including fields they never touched.
 *
 * Omitting the field keeps last-writer-wins, which the background reconcilers
 * rely on: they issue narrow updates from retry loops that must never begin
 * failing because a human edited the item.
 */
describe("PUT /api/internal_mcp_catalog/:id — optimistic concurrency", () => {
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

  test("a matching expectedRevision saves and returns the post-write token", async () => {
    const catalog = await createCatalog({
      name: "cas-match",
      serverType: "local",
      localConfig: { command: "node" },
    });
    const before = await revisionOf(catalog.id);

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { description: "edited", expectedRevision: before },
    });

    expect(response.statusCode).toBe(200);
    // The response token must be live, not the pre-cascade snapshot: the
    // dialog saves again from it without reopening.
    expect(response.json().revision).toBe(await revisionOf(catalog.id));
    expect(response.json().revision).toBeGreaterThan(before);
  });

  test("a stale expectedRevision is refused with 409 and changes nothing", async () => {
    const catalog = await createCatalog({
      name: "cas-stale",
      serverType: "local",
      localConfig: { command: "node" },
    });
    const stale = await revisionOf(catalog.id);
    // Someone else edits the item while our dialog sits open.
    await InternalMcpCatalogModel.update(catalog.id, { description: "theirs" });

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { description: "mine", expectedRevision: stale },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.internal_code).toBe("catalog_stale_write");

    const [row] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    expect(row.description).toBe("theirs");
  });

  test("a stale save is refused BEFORE the rename cascade runs", async () => {
    const catalog = await createCatalog({
      name: "cas-rename",
      serverType: "local",
      localConfig: { command: "node" },
    });
    const stale = await revisionOf(catalog.id);
    await InternalMcpCatalogModel.update(catalog.id, { description: "theirs" });

    // The rename cascade commits ~350 lines before the row write the model
    // guards, so a check that only ran at the model would leave the item
    // renamed by a request that was then rejected.
    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { name: "cas-rename-attempted", expectedRevision: stale },
    });

    expect(response.statusCode).toBe(409);
    const [row] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    expect(row.name).toBe("cas-rename");
  });

  test("omitting expectedRevision keeps last-writer-wins", async () => {
    const catalog = await createCatalog({
      name: "cas-optout",
      serverType: "local",
      localConfig: { command: "node" },
    });
    await InternalMcpCatalogModel.update(catalog.id, { description: "theirs" });

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { description: "mine" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().description).toBe("mine");
  });

  test("a rename bumps the token so a concurrent editor cannot clobber it", async () => {
    const catalog = await createCatalog({
      name: "cas-rename-bump",
      serverType: "local",
      localConfig: { command: "node" },
    });
    const before = await revisionOf(catalog.id);

    await InternalMcpCatalogModel.renameCascade({
      id: catalog.id,
      newName: "cas-renamed",
      flagReinstallRequired: false,
      freezeDeploymentNames: false,
    });

    expect(await revisionOf(catalog.id)).toBeGreaterThan(before);
  });

  test("a sharing-only edit bumps the token, a true no-op does not", async () => {
    const catalog = await createCatalog({
      name: "cas-sharing",
      serverType: "local",
      localConfig: { command: "node" },
    });
    const before = await revisionOf(catalog.id);

    // Labels live in a junction table, so this leaves the row's column set
    // empty — it must still invalidate an open editor's token.
    await InternalMcpCatalogModel.update(catalog.id, {
      labels: [{ key: "team", value: "platform" }],
    });
    const afterSharing = await revisionOf(catalog.id);
    expect(afterSharing).toBeGreaterThan(before);

    // Nothing to write at all: keep the SELECT fallback so saving an unchanged
    // dialog neither bumps updatedAt nor reshuffles the registry listing.
    await InternalMcpCatalogModel.update(catalog.id, {});
    expect(await revisionOf(catalog.id)).toBe(afterSharing);
  });

  async function revisionOf(catalogId: string): Promise<number> {
    const [row] = await db
      .select({ revision: schema.internalMcpCatalogTable.revision })
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalogId));
    return row.revision;
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
