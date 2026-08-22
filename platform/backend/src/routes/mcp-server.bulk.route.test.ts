import { and, eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import McpServerModel from "@/models/mcp-server";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import websocketService from "@/websocket";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

describe("DELETE /api/mcp_server/bulk", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    // `mcp_server` has no org column; membership is what the org fence infers
    // from, so the owner has to be a member for these servers to resolve.
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);

    const { default: routes } = await import("./mcp-server");
    await app.register(routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const bulkDelete = (ids: unknown) =>
    app.inject({
      method: "DELETE",
      url: "/api/mcp_server/bulk",
      payload: { ids },
    });

  const isDeleted = async (id: string) => {
    const [row] = await db
      .select({ deletedAt: schema.mcpServersTable.deletedAt })
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, id));
    return row?.deletedAt !== null;
  };

  test("uninstalls every named server and leaves the rest alone", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const first = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
      name: "bulk-mcp-a",
    });
    const second = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
      name: "bulk-mcp-b",
    });
    const kept = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
      name: "bulk-mcp-kept",
    });
    const lifecycleBroadcast = vi.spyOn(
      websocketService,
      "broadcastMcpServersChanged",
    );

    const response = await bulkDelete([first.id, second.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json().failed).toEqual([]);
    expect(
      response.json().succeeded.map((entry: { id: string }) => entry.id),
    ).toEqual([first.id, second.id]);

    expect(await isDeleted(first.id)).toBe(true);
    expect(await isDeleted(second.id)).toBe(true);
    expect(await isDeleted(kept.id)).toBe(false);
    expect(lifecycleBroadcast).toHaveBeenCalledWith({
      organizationId,
      serverIds: [first.id, second.id],
    });
  });

  /**
   * Built-in and app-backing servers are never uninstallable here — the first
   * is not the user's to remove, the second belongs to the Apps lifecycle and
   * deleting it would orphan its app. Both stay this row's problem.
   */
  test("refuses a built-in server but uninstalls the rest", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const builtin = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
      name: "built-in-one",
      serverType: "builtin",
    });
    const ordinary = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
      name: "ordinary",
    });

    const response = await bulkDelete([builtin.id, ordinary.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toEqual([
      { id: ordinary.id, name: "ordinary" },
    ]);
    expect(response.json().failed).toEqual([
      {
        id: builtin.id,
        name: "built-in-one",
        error: "Cannot delete built-in MCP servers",
      },
    ]);
    expect(await isDeleted(builtin.id)).toBe(false);
  });

  test("refuses an app-backing server", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const appServer = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
      name: "app-backing",
      serverType: "app",
    });

    const response = await bulkDelete([appServer.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json().failed[0].error).toContain("Apps API");
    expect(await isDeleted(appServer.id)).toBe(false);
  });

  test("reports a server from another organization as not found", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const otherOrgId = (await makeOrganization()).id;
    const stranger = await makeUser();
    await makeMember(stranger.id, otherOrgId, { role: "admin" });
    const catalog = await makeInternalMcpCatalog({
      organizationId: otherOrgId,
    });
    const foreign = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: stranger.id,
      name: "theirs",
    });

    const response = await bulkDelete([foreign.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json().failed).toEqual([
      { id: foreign.id, name: null, error: "MCP server not found" },
    ]);
    expect(await isDeleted(foreign.id)).toBe(false);
  });

  test("rejects an empty batch", async () => {
    expect((await bulkDelete([])).statusCode).toBe(400);
  });

  test("writes one audit record covering the batch", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
      name: "audited-mcp",
    });

    expect((await bulkDelete([server.id])).statusCode).toBe(200);

    const rows = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
        resourceType: schema.auditLogsTable.resourceType,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "mcpServer.bulk_deleted"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].resourceType).toBe("mcpServer");
    expect(rows[0].before).toMatchObject({
      mcpServers: [{ id: server.id, name: "audited-mcp" }],
    });
    // Gone from the live set once uninstalled, which is what makes the diff
    // read as a removal.
    expect(rows[0].after).toMatchObject({ mcpServers: [] });
    expect(await McpServerModel.findByIdsBasic([server.id])).toEqual([]);
  });
});
