import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { type Mock, vi } from "vitest";
import { hasPermission } from "@/auth";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

vi.mock("@/auth");

const mockHasPermission = hasPermission as Mock;

type CatalogToolReference = { id: string; name: string; catalogId: string };

describe("GET /api/internal_mcp_catalog/tools", () => {
  const ctx = useRouteTestApp(internalMcpCatalogRoutes);

  beforeEach(async ({ makeMember }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  });

  const getBatch = async (): Promise<CatalogToolReference[]> => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/internal_mcp_catalog/tools",
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };

  test("returns every catalog's tools in one request, keyed by catalog", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const first = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
    });
    const second = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
    });
    const a = await makeTool({ name: "first__alpha", catalogId: first.id });
    const b = await makeTool({ name: "first__beta", catalogId: first.id });
    const c = await makeTool({ name: "second__gamma", catalogId: second.id });

    const tools = await getBatch();

    expect(
      tools
        .filter((tool) => tool.catalogId === first.id)
        .map((tool) => tool.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(tools.filter((tool) => tool.catalogId === second.id)).toEqual([
      { id: c.id, name: "second__gamma", catalogId: second.id },
    ]);
  });

  test("hides the same tools the per-catalog route hides", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    await makeInternalMcpCatalog({
      id: ARCHESTRA_MCP_CATALOG_ID,
      name: "Archestra",
      serverType: "builtin",
      organizationId: null,
    });
    const visible = await makeTool({
      name: "archestra__list_agents",
      catalogId: ARCHESTRA_MCP_CATALOG_ID,
    });
    for (const hidden of [
      "archestra__search_tools",
      "archestra__run_tool",
      "archestra__query_knowledge_sources",
    ]) {
      await makeTool({ name: hidden, catalogId: ARCHESTRA_MCP_CATALOG_ID });
    }

    const builtIn = (await getBatch()).filter(
      (tool) => tool.catalogId === ARCHESTRA_MCP_CATALOG_ID,
    );

    expect(builtIn.map((tool) => tool.id)).toEqual([visible.id]);

    // ...and agrees with the per-catalog route it replaces for this page.
    const perCatalog = await ctx.app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${ARCHESTRA_MCP_CATALOG_ID}/tools`,
    });
    expect(perCatalog.statusCode).toBe(200);
    expect(perCatalog.json().map((tool: { id: string }) => tool.id)).toEqual([
      visible.id,
    ]);
  });

  test("omits tools of catalog items the caller cannot see", async ({
    makeInternalMcpCatalog,
    makeMember,
    makeTool,
    makeUser,
  }) => {
    const author = await makeUser();
    await makeMember(author.id, ctx.organizationId, { role: "member" });
    const personal = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      authorId: author.id,
      scope: "personal",
    });
    await makeTool({ name: "personal__secret", catalogId: personal.id });

    // A different non-admin member: the admin probe resolves false, so the
    // batch is scoped to what this caller can list.
    const member = await makeUser();
    await makeMember(member.id, ctx.organizationId, { role: "member" });
    ctx.user = member;
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    expect(
      (await getBatch()).some((tool) => tool.catalogId === personal.id),
    ).toBe(false);
  });

  test("excludes app backing catalogs, which stay behind the app-read gate", async ({
    makeApp,
  }) => {
    const ownedApp = await makeApp({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      scope: "org",
    });

    const backingCatalogIds = new Set(
      (await getBatch()).map((tool) => tool.catalogId),
    );

    // The app's backing catalog is reachable only via ?includeApps=true on the
    // list route; nothing of it leaks through the batched tools route.
    const listed = await ctx.app.inject({
      method: "GET",
      url: "/api/internal_mcp_catalog?includeApps=true",
    });
    const backing = listed
      .json()
      .find(
        (item: { serverType: string; appId?: string | null }) =>
          item.serverType === "app" && item.appId === ownedApp.id,
      );
    expect(backing).toBeDefined();
    expect(backingCatalogIds.has(backing.id)).toBe(false);
  });
});

describe("catalog list toolCount", () => {
  const ctx = useRouteTestApp(internalMcpCatalogRoutes);

  beforeEach(async ({ makeMember }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  });

  test("counts only the tools the picker lists", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    await makeInternalMcpCatalog({
      id: ARCHESTRA_MCP_CATALOG_ID,
      name: "Archestra",
      serverType: "builtin",
      organizationId: null,
    });
    for (const name of [
      "archestra__list_agents",
      "archestra__create_agent",
      "archestra__search_tools",
      "archestra__run_tool",
      "archestra__query_knowledge_sources",
    ]) {
      await makeTool({ name, catalogId: ARCHESTRA_MCP_CATALOG_ID });
    }

    const listed = await ctx.app.inject({
      method: "GET",
      url: "/api/internal_mcp_catalog",
    });
    expect(listed.statusCode).toBe(200);
    const builtIn = listed
      .json()
      .find((item: { id: string }) => item.id === ARCHESTRA_MCP_CATALOG_ID) as {
      toolCount: number;
    };

    const perCatalog = await ctx.app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${ARCHESTRA_MCP_CATALOG_ID}/tools`,
    });

    // The badge is what labels that list, so it has to be its length: the
    // three meta/knowledge dispatch tools are not offerable and used to
    // inflate the count.
    expect(builtIn.toolCount).toBe(2);
    expect(perCatalog.json()).toHaveLength(2);
  });
});
