import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { hasPermission } from "@/auth/utils";
import db, { schema } from "@/database";
import McpServerModel from "@/models/mcp-server";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth/utils");

const hasPermissionMock = vi.mocked(hasPermission);

describe("POST /api/mcp_server/:id/reload-tools", () => {
  let app: FastifyInstanceWithZod;
  let user: User;

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    vi.restoreAllMocks();
    user = await makeUser();
    const organization = await makeOrganization();
    await makeMember(user.id, organization.id);

    hasPermissionMock.mockResolvedValue({ success: true, error: null });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organization.id;
    });

    const { default: mcpServerRoutes } = await import("./mcp-server");
    await app.register(mcpServerRoutes);
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
