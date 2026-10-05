import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import { betterAuth } from "@/auth";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { AuditEventName, User } from "@/types";
import websocketService from "@/websocket";

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
    vi.spyOn(betterAuth.api, "getSession").mockImplementation(
      async () => ({ user: { id: user.id } }) as never,
    );

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
    const lifecycleBroadcast = vi.spyOn(
      websocketService,
      "broadcastMcpServersChanged",
    );

    const res = await app.inject({
      method: "DELETE",
      url: `/api/mcp_server/${server.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(lifecycleBroadcast).toHaveBeenCalledWith({
      organizationId,
      serverIds: [server.id],
    });

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

  test("DELETE cannot uninstall a server belonging to another organization", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const foreignOrganization = await makeOrganization();
    const foreignUser = await makeUser({ email: "foreign-server@test.com" });
    await makeMember(foreignUser.id, foreignOrganization.id, { role: "admin" });
    const catalog = await makeInternalMcpCatalog({
      organizationId: foreignOrganization.id,
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
      ownerId: foreignUser.id,
    });
    const lifecycleBroadcast = vi.spyOn(
      websocketService,
      "broadcastMcpServersChanged",
    );

    const response = await app.inject({
      method: "DELETE",
      url: `/api/mcp_server/${server.id}`,
    });

    expect(response.statusCode).toBe(404);
    expect(lifecycleBroadcast).not.toHaveBeenCalled();
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

  test("delete-only roles see and restore their own connections but cannot recover other scopes", async ({
    makeCustomRole,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeUser,
    makeTeam,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const owner = user;
    const role = await makeCustomRole(organizationId, {
      permission: { mcpServerInstallation: ["read", "delete"] },
    });
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: role.role });
    const team = await makeTeam(organizationId, owner.id);
    const own = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
    });
    const others = await Promise.all([
      makeMcpServer({
        catalogId: catalog.id,
        scope: "personal",
        ownerId: owner.id,
      }),
      makeMcpServer({
        catalogId: catalog.id,
        scope: "team",
        teamId: team.id,
        ownerId: owner.id,
      }),
      makeMcpServer({ catalogId: catalog.id, scope: "org", ownerId: owner.id }),
    ]);
    await db
      .update(schema.mcpServersTable)
      .set({ deletedAt: new Date() })
      .where(eq(schema.mcpServersTable.catalogId, catalog.id));
    const trash = await app.inject({
      method: "GET",
      url: "/api/mcp_server?status=deleted",
    });
    expect(trash.statusCode).toBe(200);
    expect(trash.json().map((server: { id: string }) => server.id)).toEqual([
      own.id,
    ]);
    for (const server of others) {
      const denied = await app.inject({
        method: "POST",
        url: `/api/mcp_server/${server.id}/restore`,
      });
      expect(denied.statusCode).toBe(403);
      const [row] = await db
        .select()
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.id, server.id));
      expect(row.deletedAt).not.toBeNull();
    }
    const restored = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${own.id}/restore`,
    });
    expect(restored.statusCode).toBe(200);
  });

  test("editors recover personal and member-team connections; only installation admins recover org connections", async ({
    makeCustomRole,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeUser,
    makeTeam,
    makeTeamMember,
  }) => {
    const admin = user;
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const role = await makeCustomRole(organizationId, {
      permission: { mcpServerInstallation: ["read", "update", "delete"] },
    });
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: role.role });
    const memberTeam = await makeTeam(organizationId, admin.id);
    await makeTeamMember(memberTeam.id, user.id);
    const otherTeam = await makeTeam(organizationId, admin.id);
    const childTeam = await makeTeam(organizationId, admin.id, {
      parentId: otherTeam.id,
    });
    await makeTeamMember(childTeam.id, user.id);
    const personal = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: admin.id,
    });
    const team = await makeMcpServer({
      catalogId: catalog.id,
      scope: "team",
      teamId: memberTeam.id,
      ownerId: admin.id,
    });
    const foreignTeam = await makeMcpServer({
      catalogId: catalog.id,
      scope: "team",
      teamId: otherTeam.id,
      ownerId: admin.id,
    });
    const org = await makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
      ownerId: admin.id,
    });
    await db
      .update(schema.mcpServersTable)
      .set({ deletedAt: new Date() })
      .where(eq(schema.mcpServersTable.catalogId, catalog.id));
    const trash = await app.inject({
      method: "GET",
      url: "/api/mcp_server?status=deleted",
    });
    expect(trash.statusCode).toBe(200);
    expect(
      trash
        .json()
        .map((server: { id: string }) => server.id)
        .sort(),
    ).toEqual([personal.id, team.id].sort());
    for (const server of [personal, team]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/mcp_server/${server.id}/restore`,
          })
        ).statusCode,
      ).toBe(200);
    }
    for (const server of [foreignTeam, org]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/mcp_server/${server.id}/restore`,
          })
        ).statusCode,
      ).toBe(403);
    }
    user = admin;
    const adminTrash = await app.inject({
      method: "GET",
      url: "/api/mcp_server?status=deleted",
    });
    expect(
      adminTrash
        .json()
        .map((server: { id: string }) => server.id)
        .sort(),
    ).toEqual([foreignTeam.id, org.id].sort());
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/mcp_server/${org.id}/restore`,
        })
      ).statusCode,
    ).toBe(200);
  });

  test("deleted installs remain fenced by their catalog organization even when their owner belongs to this organization", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const foreignOrg = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({
      organizationId: foreignOrg.id,
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
    });
    await db
      .update(schema.mcpServersTable)
      .set({ deletedAt: new Date() })
      .where(eq(schema.mcpServersTable.id, server.id));
    const trash = await app.inject({
      method: "GET",
      url: "/api/mcp_server?status=deleted",
    });
    expect(trash.statusCode).toBe(200);
    expect(trash.json()).toEqual([]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/mcp_server/${server.id}/restore`,
        })
      ).statusCode,
    ).toBe(404);
  });

  test("trash requires delete even for the owner", async ({
    makeCustomRole,
    makeMember,
    makeUser,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: { mcpServerInstallation: ["read"] },
    });
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: role.role });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/mcp_server?status=deleted",
        })
      ).statusCode,
    ).toBe(403);
  });
});
