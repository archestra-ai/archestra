import { and, eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { AuditEventName, User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

/**
 * Soft-delete + restore of a standalone MCP server install through the routes,
 * and the per-server audit records each must emit.
 */
describe("MCP server soft-delete routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    // `mcp_server` has no org column; org membership is inferred via the owner's
    // membership row, which the deleted-lookup + audit-snapshot joins require.
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    registerAuditLogHook(app);

    const { default: routes } = await import("./mcp-server");
    await app.register(routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  async function auditRow(action: AuditEventName, resourceId: string) {
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

  test("DELETE soft-deletes the install, retains the DB secret, and audits the delete", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const secret = await makeSecret();
    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
    });
    await db
      .update(schema.mcpServersTable)
      .set({ secretId: secret.id })
      .where(eq(schema.mcpServersTable.id, server.id));

    const res = await app.inject({
      method: "DELETE",
      url: `/api/mcp_server/${server.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const [row] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, server.id));
    expect(row?.deletedAt).not.toBeNull();

    // Soft-delete RETAINS the DB secret row (restore recovers stored credentials).
    const secretRow = await db
      .select()
      .from(schema.secretsTable)
      .where(eq(schema.secretsTable.id, secret.id));
    expect(secretRow).toHaveLength(1);

    const audit = await auditRow("mcpServer.deleted", server.id);
    expect(audit).not.toBeNull();
    expect(audit?.resourceType).toBe("mcpServer");
    expect(audit?.before).toMatchObject({ id: server.id });
    expect(audit?.after).toBeNull();
  });

  test("POST /:id/restore un-hides the install, flags reinstall, and audits the restore", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
    });

    await app.inject({ method: "DELETE", url: `/api/mcp_server/${server.id}` });

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${server.id}/restore`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(server.id);

    const [row] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, server.id));
    expect(row?.deletedAt).toBeNull();
    expect(row?.reinstallRequired).toBe(true);

    const audit = await auditRow("mcpServer.restored", server.id);
    expect(audit).not.toBeNull();
    expect(audit?.resourceType).toBe("mcpServer");
    expect(audit?.before).toMatchObject({ deletedAt: expect.any(String) });
    expect(audit?.after).toMatchObject({ deletedAt: null });
  });

  test("restore is rejected (409) while the parent catalog is still soft-deleted", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
    });

    // Deleting the catalog cascade-soft-deletes the install with it (done via
    // the model — this app only registers the mcp_server routes).
    await InternalMcpCatalogModel.delete(catalog.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${server.id}/restore`,
    });
    expect(res.statusCode).toBe(409);
  });

  test("GET ?status=deleted requires the delete permission", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
    });
    await app.inject({ method: "DELETE", url: `/api/mcp_server/${server.id}` });

    const ok = await app.inject({
      method: "GET",
      url: "/api/mcp_server?status=deleted",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().some((s: { id: string }) => s.id === server.id)).toBe(
      true,
    );

    mockHasPermission.mockResolvedValue({ success: false, error: null });
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/mcp_server?status=deleted",
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
