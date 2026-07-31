import { and, eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { AuditEventName, User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

/**
 * Soft-delete + restore of an internal MCP catalog item through the routes, and
 * the audit records they must emit: one catalog-level summary per delete/restore.
 */
describe("internal MCP catalog soft-delete routes", () => {
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
    registerAuditLogHook(app);

    const { default: routes } = await import("./internal-mcp-catalog");
    await app.register(routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  async function auditRow(action: AuditEventName, resourceId: string) {
    // The audit write is fire-and-forget in the onResponse hook; poll briefly.
    for (let i = 0; i < 20; i++) {
      const rows = await db
        .select({
          action: schema.auditLogsTable.action,
          resourceType: schema.auditLogsTable.resourceType,
          resourceId: schema.auditLogsTable.resourceId,
          before: schema.auditLogsTable.before,
          after: schema.auditLogsTable.after,
        })
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.action, action),
            eq(schema.auditLogsTable.resourceId, resourceId),
          ),
        );
      if (rows.length > 0) return rows[0];
      await new Promise((r) => setTimeout(r, 5));
    }
    return null;
  }

  test("DELETE soft-deletes the catalog + installs + tools and emits a summary audit record", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
    });
    const server = await makeMcpServer({ catalogId: catalog.id });
    const tool = await makeTool({ catalogId: catalog.id });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const [catRow] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    expect(catRow?.deletedAt).not.toBeNull();
    const [srvRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, server.id));
    expect(srvRow?.deletedAt).not.toBeNull();
    const [toolRow] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, tool.id));
    expect(toolRow?.deletedAt).not.toBeNull();

    // One catalog-level summary record, with the installs/tools counts affected.
    const row = await auditRow("internalMcpCatalog.deleted", catalog.id);
    expect(row).not.toBeNull();
    expect(row?.resourceType).toBe("internalMcpCatalog");
    // before snapshot is captured while still active: install/tool counts present.
    expect(row?.before).toMatchObject({ installCount: 1, toolCount: 1 });
    // A genuine delete has no post-state.
    expect(row?.after).toBeNull();
  });

  test("POST /:id/restore revives the cascade, flags reinstall, and audits the restore", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
    });
    const server = await makeMcpServer({ catalogId: catalog.id });
    const tool = await makeTool({ catalogId: catalog.id });

    await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${catalog.id}/restore`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const [srvRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, server.id));
    expect(srvRow?.deletedAt).toBeNull();
    // Flag-only restore: the install is marked for a manual reinstall.
    expect(srvRow?.reinstallRequired).toBe(true);
    const [toolRow] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, tool.id));
    expect(toolRow?.deletedAt).toBeNull();

    const row = await auditRow("internalMcpCatalog.restored", catalog.id);
    expect(row).not.toBeNull();
    expect(row?.resourceType).toBe("internalMcpCatalog");
    // before = soft-deleted snapshot, after = revived snapshot (non-empty diff).
    expect(row?.before).toMatchObject({ deletedAt: expect.any(String) });
    expect(row?.after).toMatchObject({ deletedAt: null });
  });

  test("GET ?status=deleted requires manage-deleted and lists soft-deleted roots", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
    });
    await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
    });

    // Permitted caller sees the deleted root.
    const ok = await app.inject({
      method: "GET",
      url: "/api/internal_mcp_catalog?status=deleted",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().some((c: { id: string }) => c.id === catalog.id)).toBe(
      true,
    );

    // A caller with every ordinary permission (delete included) but not the
    // admin-default manage-deleted capability must not see the tombstone view.
    mockHasPermission.mockImplementation(
      async (permissions: Record<string, string[]>) => ({
        success: !Object.values(permissions).some((actions) =>
          actions.includes("manage-deleted"),
        ),
        error: null,
      }),
    );
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/internal_mcp_catalog?status=deleted",
    });
    expect(forbidden.statusCode).toBe(403);
  });

  test("the restore route is gated on manage-deleted in the endpoint permission map", async () => {
    const { requiredEndpointPermissionsMap } = await import(
      "@archestra/shared/access-control"
    );
    expect(
      requiredEndpointPermissionsMap.restoreInternalMcpCatalogItem,
    ).toEqual({
      mcpRegistry: ["manage-deleted"],
    });
  });

  test("restore is rejected when another active catalog reuses the name", async ({
    makeInternalMcpCatalog,
  }) => {
    const original = await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
      name: "reused-name",
    });
    await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${original.id}`,
    });

    // The freed name is taken by a new active catalog.
    await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
      name: "reused-name",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${original.id}/restore`,
    });
    expect(res.statusCode).toBe(409);
  });
});
