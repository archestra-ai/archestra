import { type Mock, vi } from "vitest";
import { enterpriseTier } from "@/enterprise-tier";
import { McpServerModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

/**
 * The registry's server settings dialog is catalog-scoped, so its PUT is the
 * write path for the per-server idle-hibernation override: the field never
 * lands on the catalog row — it cascades onto every live install. The
 * reinstall route stays the per-install path for a single divergent install.
 */
describe("PUT /api/internal_mcp_catalog/:id — hibernation mode cascade", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    // Small team => enterprise core active. The shared setup's reset targets
    // the clean project's module registry; this mocked-project file must seed
    // the instance its own route imports.
    enterpriseTier.setUserCountForTesting(0);

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    // Org-scoped catalog items are admin-managed, and the permission checker
    // reads the REAL member table (mocking @/auth doesn't reach it).
    await makeMember(user.id, organizationId, { role: "admin" });

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
    vi.restoreAllMocks();
    await app.close();
  });

  async function makeCatalogWithInstalls(fixtures: {
    makeInternalMcpCatalog: (
      overrides?: Record<string, unknown>,
    ) => Promise<{ id: string; name: string }>;
    makeMcpServer: (
      overrides?: Record<string, unknown>,
    ) => Promise<{ id: string }>;
  }) {
    const catalog = await fixtures.makeInternalMcpCatalog({
      name: "Sleepy Catalog",
      serverType: "local",
      // Bind to the request's org — the fixture invents a fresh one otherwise
      // and every org-scoped lookup in the route 404s.
      organizationId,
      authorId: user.id,
      localConfig: { command: "node", arguments: ["server.js"] },
    });
    const installA = await fixtures.makeMcpServer({
      catalogId: catalog.id,
      name: "Sleepy Catalog-a",
      serverType: "local",
    });
    const installB = await fixtures.makeMcpServer({
      catalogId: catalog.id,
      name: "Sleepy Catalog-b",
      serverType: "local",
    });
    return { catalog, installA, installB };
  }

  test("cascades the mode onto every live install and stays off the catalog row", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const { catalog, installA, installB } = await makeCatalogWithInstalls({
      makeInternalMcpCatalog,
      makeMcpServer,
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { hibernationMode: "disabled" },
    });
    expect(response.statusCode).toBe(200);
    // Not a catalog column: the response (the catalog row) must not grow it.
    expect(response.json()).not.toHaveProperty("hibernationMode");

    const [modeA, modeB] = await Promise.all([
      McpServerModel.findById(installA.id),
      McpServerModel.findById(installB.id),
    ]);
    expect(modeA?.hibernationMode).toBe("disabled");
    expect(modeB?.hibernationMode).toBe("disabled");
  });

  test("a PUT without the field leaves stored modes untouched", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const { catalog, installA } = await makeCatalogWithInstalls({
      makeInternalMcpCatalog,
      makeMcpServer,
    });
    await McpServerModel.setHibernationModeForCatalog(catalog.id, "disabled");

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { description: "still asleep on purpose" },
    });
    expect(response.statusCode).toBe(200);

    expect((await McpServerModel.findById(installA.id))?.hibernationMode).toBe(
      "disabled",
    );
  });

  test("403s without an enterprise licence and changes nothing", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const { catalog, installA } = await makeCatalogWithInstalls({
      makeInternalMcpCatalog,
      makeMcpServer,
    });
    // Past the small-team threshold with no licence flag: core inactive.
    enterpriseTier.setUserCountForTesting(1_000);

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { hibernationMode: "disabled" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain("enterprise feature");
    expect((await McpServerModel.findById(installA.id))?.hibernationMode).toBe(
      "inherit",
    );
  });

  test("the audit snapshot surfaces the cascaded modes", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const { catalog } = await makeCatalogWithInstalls({
      makeInternalMcpCatalog,
      makeMcpServer,
    });
    const { InternalMcpCatalogModel } = await import("@/models");

    const before = await InternalMcpCatalogModel.findByIdForAudit(
      catalog.id,
      organizationId,
    );
    expect(before?.installHibernationModes).toEqual(["inherit"]);

    await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { hibernationMode: "disabled" },
    });

    const after = await InternalMcpCatalogModel.findByIdForAudit(
      catalog.id,
      organizationId,
    );
    // This is the diff the audit hook records for the change — the catalog row
    // itself never carries the field.
    expect(after?.installHibernationModes).toEqual(["disabled"]);
  });
});
