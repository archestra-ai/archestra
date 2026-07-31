import { type Mock, vi } from "vitest";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

/**
 * Read-only version-history endpoints. Visibility must mirror
 * `GET /api/internal_mcp_catalog/:id` exactly: org + team scoping, built-in
 * (null-org) catalogs readable, soft-deleted catalogs a plain 404.
 */
describe("internal MCP catalog version routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

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

  test("lists a catalog item's versions newest first, paginated", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
    });
    await InternalMcpCatalogModel.update(catalog.id, {
      description: "second",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${catalog.id}/versions?limit=1`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: Array<{ version: number; snapshot: { description: string } }>;
      pagination: { total: number };
    };
    expect(body.pagination.total).toBe(2);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].version).toBe(2);
    expect(body.data[0].snapshot.description).toBe("second");
  });

  test("returns a specific version by number", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
      description: "as created",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${catalog.id}/versions/1`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 1,
      catalogId: catalog.id,
      snapshot: { name: catalog.name, description: "as created" },
    });
  });

  test("returns 404 for a version the catalog does not have", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${catalog.id}/versions/99`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("returns 404 for another organization's catalog", async ({
    makeInternalMcpCatalog,
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const foreign = await makeInternalMcpCatalog({
      organizationId: otherOrg.id,
    });

    for (const url of [
      `/api/internal_mcp_catalog/${foreign.id}/versions`,
      `/api/internal_mcp_catalog/${foreign.id}/versions/1`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
    }
  });

  test("a non-admin member cannot read versions of another user's personal catalog", async ({
    makeInternalMcpCatalog,
    makeUser,
  }) => {
    const author = await makeUser();
    const personal = await makeInternalMcpCatalog({
      organizationId,
      authorId: author.id,
      scope: "personal",
    });
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    const response = await app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${personal.id}/versions`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("an org-scope catalog without an organization (built-in shape) is readable", async () => {
    // The startup-created built-in catalog has organizationId NULL — the
    // visibility path must not be a bare org-equality join.
    const builtinLike = await InternalMcpCatalogModel.create({
      name: `builtin-${crypto.randomUUID().substring(0, 8)}`,
      serverType: "remote",
      serverUrl: "https://api.example.com/mcp/",
      scope: "org",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${builtinLike.id}/versions`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: Array<{ version: number }> };
    expect(body.data.map((v) => v.version)).toEqual([1]);
  });

  test("a soft-deleted catalog answers 404, mirroring the parent GET", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
    });
    await InternalMcpCatalogModel.delete(catalog.id);

    for (const url of [
      `/api/internal_mcp_catalog/${catalog.id}/versions`,
      `/api/internal_mcp_catalog/${catalog.id}/versions/1`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
    }
  });

  test("an app-backed catalog is readable but has no version history", async ({
    makeInternalMcpCatalog,
  }) => {
    const appBacked = await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
      serverType: "app",
      serverUrl: null,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${appBacked.id}/versions`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: unknown[];
      pagination: { total: number };
    };
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });
});
