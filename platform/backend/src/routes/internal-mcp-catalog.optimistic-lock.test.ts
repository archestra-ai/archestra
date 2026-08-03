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

  test("a rename carrying a current expectedRevision applies the whole payload", async () => {
    const catalog = await createCatalog({
      name: "cas-rename-current",
      serverType: "local",
      localConfig: { command: "node" },
    });
    const current = await revisionOf(catalog.id);

    // The rename cascade writes the row itself and bumps the token, so the
    // model's compare-and-set further down must be re-armed with what the
    // cascade left — otherwise the request conflicts with its OWN rename and
    // lands half-applied: renamed, but with the rest of the payload dropped.
    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name: "cas-rename-current-renamed",
        description: "edited",
        expectedRevision: current,
      },
    });

    expect(response.statusCode).toBe(200);
    const [row] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    expect(row.name).toBe("cas-rename-current-renamed");
    expect(row.description).toBe("edited");
  });

  test("the cascade re-checks the token under its own write and rolls back", async () => {
    const catalog = await createCatalog({
      name: "cas-cascade-gate",
      serverType: "local",
      localConfig: { command: "node" },
    });
    const stale = await revisionOf(catalog.id);
    await InternalMcpCatalogModel.update(catalog.id, { description: "theirs" });

    // The route's gate runs well before the cascade — a name-conflict query
    // and the startup adopt await sit in between — so the cascade carries its
    // own check. Nothing may be renamed on the way to being rejected.
    await expect(
      InternalMcpCatalogModel.renameCascade({
        id: catalog.id,
        newName: "cas-cascade-gate-renamed",
        flagReinstallRequired: false,
        freezeDeploymentNames: false,
        expectedRevision: stale,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const [row] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    expect(row.name).toBe("cas-cascade-gate");
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

  /**
   * `catalogReinstallRequired` is reconciler bookkeeping, not config an editor
   * authored. The flips arrive from background reinstall paths at times no
   * human controls, so bumping the token on them would refuse an open editor's
   * save for a conflict with nobody — and the editor's only remedy in that
   * banner is to discard what they typed.
   */
  test("a reconciler's reinstall flip moves neither the token nor the version", async () => {
    const catalog = await createCatalog({
      name: "cas-reconciler-flip",
      serverType: "local",
      localConfig: { command: "node" },
    });
    const before = await revisionOf(catalog.id);
    const versionBefore = (await InternalMcpCatalogModel.findById(catalog.id))
      ?.latestVersion;

    await InternalMcpCatalogModel.update(catalog.id, {
      catalogReinstallRequired: true,
    });

    expect(await revisionOf(catalog.id)).toBe(before);
    const reloaded = await InternalMcpCatalogModel.findById(catalog.id);
    expect(reloaded?.catalogReinstallRequired).toBe(true);
    // The flag is excluded from the snapshot, so a fork here could only ever
    // dedup — it is skipped outright rather than paying for the round trip.
    expect(reloaded?.latestVersion).toBe(versionBefore);

    // An edit arriving alongside a flip is still a real edit.
    await InternalMcpCatalogModel.update(catalog.id, {
      catalogReinstallRequired: false,
      description: "edited while the reconciler was flipping",
    });
    expect(await revisionOf(catalog.id)).toBeGreaterThan(before);
  });

  /**
   * Reset to default sits one button away from the guarded save in the same
   * dialog, and clears the whole stored manifest before cascading every pod
   * onto the generated template. Leaving it unguarded would make it a way to
   * destroy exactly what the save protects.
   */
  test("a stale reset-deployment-yaml is refused and leaves the winning document in place", async () => {
    const catalog = await createCatalog({
      name: "cas-reset-stale",
      serverType: "local",
      localConfig: { command: "node" },
    });
    const stale = await revisionOf(catalog.id);

    // Another admin saves a hand-tuned manifest while our editor sits open.
    await InternalMcpCatalogModel.update(catalog.id, {
      deploymentSpecYaml: "kind: Deployment # theirs\n",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${catalog.id}/reset-deployment-yaml`,
      payload: { expectedRevision: stale },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.internal_code).toBe("catalog_stale_write");

    const [row] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    expect(row.deploymentSpecYaml).toBe("kind: Deployment # theirs\n");
  });

  test("a matching reset token clears the document and answers with a usable one", async () => {
    const catalog = await createCatalog({
      name: "cas-reset-match",
      serverType: "local",
      localConfig: { command: "node" },
    });
    await InternalMcpCatalogModel.update(catalog.id, {
      deploymentSpecYaml: "kind: Deployment # mine\n",
    });
    const current = await revisionOf(catalog.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${catalog.id}/reset-deployment-yaml`,
      payload: { expectedRevision: current },
    });

    expect(response.statusCode).toBe(200);
    const [row] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    expect(row.deploymentSpecYaml).toBeNull();

    // The editor re-baselines on this response instead of reopening, so the
    // token it answers with has to be one a following save is allowed to use.
    const save = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        description: "saved after reset",
        expectedRevision: response.json().revision,
      },
    });
    expect(save.statusCode).toBe(200);
  });

  test("a no-op honours the token even though it writes nothing", async () => {
    const catalog = await createCatalog({
      name: "cas-noop",
      serverType: "local",
      localConfig: { command: "node" },
    });
    const stale = await revisionOf(catalog.id);

    await InternalMcpCatalogModel.update(catalog.id, { description: "moved" });
    const current = await revisionOf(catalog.id);
    expect(current).toBeGreaterThan(stale);

    // The route gates on the token before reaching here, so this only fires
    // for a direct caller. Refusing still matters: the row this returns is not
    // the one the caller certified, and a 200 would tell a stale editor that
    // its snapshot is current.
    await expect(
      InternalMcpCatalogModel.update(
        catalog.id,
        {},
        { expectedRevision: stale },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      internalCode: "catalog_stale_write",
    });

    // A current token passes through untouched — no write, no bump.
    const unchanged = await InternalMcpCatalogModel.update(
      catalog.id,
      {},
      { expectedRevision: current },
    );
    expect(unchanged?.revision).toBe(current);
    expect(await revisionOf(catalog.id)).toBe(current);
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
