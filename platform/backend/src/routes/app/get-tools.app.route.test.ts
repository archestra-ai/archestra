import { ADMIN_ROLE_NAME } from "@archestra/shared";
import AppToolModel from "@/models/app-tool";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import appRoutes from "./app.routes";

describe("GET /api/apps/:appId/tools", () => {
  const ctx = useRouteTestApp(appRoutes);

  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
  });

  test("round-trips a saved server pin and later unpins it for dynamic resolution", async ({
    makeApp,
    makeTool,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const app = await makeApp({ organizationId: ctx.organizationId });
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "assignment-source",
      serverUrl: "https://example.com/mcp",
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
    });
    const tool = await makeTool({
      name: "assignment_source__read",
      parameters: {},
      catalogId: catalog.id,
    });
    const pinned = await ctx.app.inject({
      method: "POST",
      url: `/api/apps/${app.id}/tools/${tool.id}`,
      payload: { mcpServerId: server.id, credentialResolutionMode: "static" },
    });
    expect(pinned.statusCode, pinned.body).toBe(200);

    const readPinned = await ctx.app.inject({
      method: "GET",
      url: `/api/apps/${app.id}/tools`,
    });
    expect(readPinned.statusCode).toBe(200);
    expect(readPinned.json()).toEqual([
      expect.objectContaining({
        id: tool.id,
        mcpServerId: server.id,
        credentialResolutionMode: "static",
      }),
    ]);

    const dynamic = await ctx.app.inject({
      method: "POST",
      url: `/api/apps/${app.id}/tools/${tool.id}`,
      payload: { mcpServerId: null, credentialResolutionMode: "dynamic" },
    });
    expect(dynamic.statusCode).toBe(200);
    const readDynamic = await ctx.app.inject({
      method: "GET",
      url: `/api/apps/${app.id}/tools`,
    });
    expect(readDynamic.json()).toEqual([
      expect.objectContaining({
        id: tool.id,
        mcpServerId: null,
        credentialResolutionMode: "dynamic",
      }),
    ]);
  });

  test("reports the stored defaults for a legacy unpinned assignment", async ({
    makeApp,
    makeTool,
    makeInternalMcpCatalog,
  }) => {
    const app = await makeApp({ organizationId: ctx.organizationId });
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "legacy-assignment",
      serverUrl: "https://example.com/mcp",
    });
    const tool = await makeTool({
      name: "legacy_assignment__read",
      parameters: {},
      catalogId: catalog.id,
    });
    await AppToolModel.create(app.id, tool.id);

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/apps/${app.id}/tools`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: tool.id,
        mcpServerId: null,
        credentialResolutionMode: "static",
      }),
    ]);
  });

  test("does not expose assignment details for another organization", async ({
    makeApp,
    makeOrganization,
  }) => {
    const other = await makeOrganization();
    const app = await makeApp({ organizationId: other.id });
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/apps/${app.id}/tools`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("does not expose a private app's assignment details to an unshared member", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const app = await makeApp({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      access: "personal",
    });
    const viewer = await makeUser();
    await makeMember(viewer.id, ctx.organizationId, { role: "member" });
    ctx.user = viewer;

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/apps/${app.id}/tools`,
    });
    expect(response.statusCode).toBe(404);
  });
});
