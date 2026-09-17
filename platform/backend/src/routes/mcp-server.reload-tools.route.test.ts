import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { hasPermission } from "@/auth/utils";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import McpServerModel from "@/models/mcp-server";
import TeamModel from "@/models/team";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth/utils");

const hasPermissionMock = vi.mocked(hasPermission);

describe("POST /api/mcp_server/:id/reload-tools", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    vi.restoreAllMocks();
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organization.id);

    hasPermissionMock.mockResolvedValue({ success: true, error: null });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organization.id;
    });
    registerAuditLogHook(app);

    const { default: mcpServerRoutes } = await import("./mcp-server");
    await app.register(mcpServerRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  for (const action of ["reload-tools", "reinstall", "reauthenticate"]) {
    test(`denies ${action} for a deleted team's connection in another organization`, async ({
      makeOrganization,
      makeMember,
      makeTeam,
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const foreignOrganization = await makeOrganization();
      // Even a shared owner must not bypass the catalog's organization fence.
      await makeMember(user.id, foreignOrganization.id);
      const team = await makeTeam(foreignOrganization.id, user.id);
      const catalog = await makeInternalMcpCatalog({
        organizationId: foreignOrganization.id,
        serverType: "remote",
      });
      const server = await makeMcpServer({
        catalogId: catalog.id,
        ownerId: user.id,
        scope: "team",
        teamId: team.id,
      });
      await TeamModel.delete(team.id);
      const getTools = vi
        .spyOn(McpServerModel, "getToolsFromServer")
        .mockResolvedValue([]);

      const response = await app.inject({
        method: action === "reauthenticate" ? "PATCH" : "POST",
        url: `/api/mcp_server/${server.id}/${action}`,
        payload:
          action === "reauthenticate" ? { accessToken: "synthetic" } : {},
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toBe("MCP server not found");
      expect(getTools).not.toHaveBeenCalled();
      expect(await McpServerModel.findById(server.id)).toMatchObject({
        scope: "team",
        teamId: null,
        secretId: null,
      });
    });
  }

  for (const canManageAllTeams of [true, false]) {
    test(`after team deletion, reload ${canManageAllTeams ? "allows global team managers" : "denies former team admins"}`, async ({
      makeTeam,
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const team = await makeTeam(organizationId, user.id);
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "deleted-team-reload",
        serverType: "remote",
      });
      const server = await makeMcpServer({
        catalogId: catalog.id,
        ownerId: user.id,
        scope: "team",
        teamId: team.id,
      });
      await TeamModel.delete(team.id);
      expect(await McpServerModel.findById(server.id)).toMatchObject({
        scope: "team",
        teamId: null,
      });
      hasPermissionMock.mockImplementation(async (permissions) => ({
        success: permissions.team ? canManageAllTeams : true,
        error: null,
      }));
      const getTools = vi
        .spyOn(McpServerModel, "getToolsFromServer")
        .mockResolvedValue([
          {
            name: "example_tool",
            description: "A synthetic tool",
            inputSchema: { type: "object" },
          },
        ]);

      const response = await app.inject({
        method: "POST",
        url: `/api/mcp_server/${server.id}/reload-tools`,
      });

      expect(response.statusCode).toBe(canManageAllTeams ? 200 : 403);
      if (canManageAllTeams) {
        expect(response.json()).toEqual({
          created: 1,
          updated: 0,
          unchanged: 0,
          deleted: 0,
        });
        const tools = await db
          .select()
          .from(schema.toolsTable)
          .where(eq(schema.toolsTable.catalogId, catalog.id));
        expect(tools.map((tool) => tool.rawName)).toEqual(["example_tool"]);
        await expect
          .poll(async () => {
            const [record] = await db
              .select()
              .from(schema.auditLogsTable)
              .where(eq(schema.auditLogsTable.resourceId, server.id));
            return record;
          })
          .toMatchObject({
            action: "mcpServer.updated",
            outcome: "success",
            before: { scope: "team", teamId: null },
            after: {
              scope: "team",
              teamId: null,
              toolChanges: { created: 1, updated: 0, unchanged: 0, deleted: 0 },
            },
          });
      } else {
        expect(getTools).not.toHaveBeenCalled();
      }
      expect(await McpServerModel.findById(server.id)).toMatchObject({
        scope: "team",
        teamId: null,
      });
    });
  }

  test("a global team manager can revoke a deleted team's connection with an audit record", async ({
    makeTeam,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const team = await makeTeam(organizationId, user.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "remote",
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      scope: "team",
      teamId: team.id,
    });
    await TeamModel.delete(team.id);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/mcp_server/${server.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(await McpServerModel.findById(server.id)).toBeNull();
    await expect
      .poll(async () => {
        const [record] = await db
          .select()
          .from(schema.auditLogsTable)
          .where(eq(schema.auditLogsTable.resourceId, server.id));
        return record;
      })
      .toMatchObject({
        action: "mcpServer.deleted",
        outcome: "success",
        before: { scope: "team", teamId: null },
        after: null,
      });
  });

  test("re-syncs tools from the live server without a reinstall", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "reload-route-catalog",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      name: "reload-route-catalog",
      ownerId: user.id,
    });
    // One pre-existing tool with a stale schema, one that upstream dropped.
    await makeTool({
      name: "reload-route-catalog__kept_tool",
      rawName: "kept_tool",
      description: "old",
      parameters: { type: "object" },
      catalogId: catalog.id,
    });
    await makeTool({
      name: "reload-route-catalog__gone_tool",
      rawName: "gone_tool",
      catalogId: catalog.id,
    });

    vi.spyOn(McpServerModel, "getToolsFromServer").mockResolvedValue([
      {
        name: "kept_tool",
        description: "new",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
      {
        name: "new_tool",
        description: "fresh",
        inputSchema: { type: "object" },
      },
    ]);

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${server.id}/reload-tools`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      created: 1,
      updated: 1,
      unchanged: 0,
      deleted: 1,
    });
    await expect
      .poll(async () => {
        const [record] = await db
          .select()
          .from(schema.auditLogsTable)
          .where(eq(schema.auditLogsTable.resourceId, server.id));
        return record?.after;
      })
      .toMatchObject({
        toolChanges: { created: 1, updated: 1, unchanged: 0, deleted: 1 },
      });

    const tools = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.catalogId, catalog.id));
    expect(tools.map((t) => t.rawName).sort()).toEqual([
      "kept_tool",
      "new_tool",
    ]);
    expect(tools.find((t) => t.rawName === "kept_tool")?.description).toBe(
      "new",
    );
  });

  test("returns 404 for an unknown server", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/mcp_server/00000000-0000-4000-8000-000000000001/reload-tools",
    });
    expect(response.statusCode).toBe(404);
  });

  // App and builtin servers manage their tools in-process — there is no live
  // upstream to re-discover from.
  for (const serverType of ["app", "builtin"] as const) {
    test(`rejects ${serverType} servers with 400`, async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        name: `reload-${serverType}-catalog`,
        serverType: "remote",
      });
      const server = await makeMcpServer({
        catalogId: catalog.id,
        name: `reload-${serverType}-catalog`,
        ownerId: user.id,
      });
      await db
        .update(schema.mcpServersTable)
        .set({ serverType })
        .where(eq(schema.mcpServersTable.id, server.id));

      const response = await app.inject({
        method: "POST",
        url: `/api/mcp_server/${server.id}/reload-tools`,
      });
      expect(response.statusCode).toBe(400);
    });
  }

  test("denies reload of another user's personal connection", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
  }) => {
    const otherUser = await makeUser();
    const catalog = await makeInternalMcpCatalog({
      name: "reload-denied-catalog",
      serverType: "remote",
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      name: "reload-denied-catalog",
      ownerId: otherUser.id,
      scope: "personal",
    });

    const getTools = vi.spyOn(McpServerModel, "getToolsFromServer");

    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${server.id}/reload-tools`,
    });
    expect(response.statusCode).toBe(403);
    expect(getTools).not.toHaveBeenCalled();
  });
});
