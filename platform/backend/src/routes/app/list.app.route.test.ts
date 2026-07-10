import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { AppListItem, User } from "@/types";

type AppListResponse = {
  data: AppListItem[];
  pagination: { total: number };
};

describe("GET /api/apps", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          organizationId: string;
          user: User;
        }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: appRoutes } = await import("./app.routes");
    await app.register(appRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns owned apps with pagination metadata", async ({ makeApp }) => {
    const owned = await makeApp({
      organizationId,
      scope: "org",
      name: "Owned One",
    });

    const response = await app.inject({ method: "GET", url: "/api/apps" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((a: { id: string }) => a.id)).toContain(
      owned.id,
    );
    expect(response.json().pagination.total).toBeGreaterThanOrEqual(1);
  });

  test("treats wildcard characters literally in owned app search", async ({
    makeApp,
  }) => {
    const percentName = await makeApp({
      organizationId,
      scope: "org",
      name: "100% Ready",
    });
    const percentDescription = await makeApp({
      organizationId,
      scope: "org",
      name: "Percent Description",
      description: "Contains a % marker",
    });
    const underscoreName = await makeApp({
      organizationId,
      scope: "org",
      name: "Under_score Name",
    });
    const underscoreDescription = await makeApp({
      organizationId,
      scope: "org",
      name: "Underscore Description",
      description: "Contains an _ marker",
    });
    const backslashName = await makeApp({
      organizationId,
      scope: "org",
      name: "Back\\slash Name",
    });
    const backslashDescription = await makeApp({
      organizationId,
      scope: "org",
      name: "Backslash Description",
      description: "Contains a \\ marker",
    });
    await makeApp({
      organizationId,
      scope: "org",
      name: "Plain App",
      description: "Contains no special marker",
    });

    const searchOwned = async (search: string) => {
      const response = await app.inject({
        method: "GET",
        url: `/api/apps?limit=100&offset=0&search=${encodeURIComponent(search)}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<AppListResponse>();
      const ids = body.data
        .filter((item) => item.source === "owned")
        .map((item) => item.id)
        .sort();
      return { ids, total: body.pagination.total };
    };

    expect(await searchOwned("%")).toEqual({
      ids: [percentName.id, percentDescription.id].sort(),
      total: 2,
    });
    expect(await searchOwned("_")).toEqual({
      ids: [underscoreName.id, underscoreDescription.id].sort(),
      total: 2,
    });
    expect(await searchOwned("\\")).toEqual({
      ids: [backslashName.id, backslashDescription.id].sort(),
      total: 2,
    });
    expect(await searchOwned("READY")).toEqual({
      ids: [percentName.id],
      total: 1,
    });
  });

  test("treats wildcard characters literally in external app search", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const makeExternalApp = async (params: {
      catalogName: string;
      catalogDescription: string;
      toolName: string;
      toolDescription: string;
    }) => {
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: params.catalogName,
        description: params.catalogDescription,
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      });
      await makeMcpServer({ catalogId: catalog.id, scope: "org" });
      await makeTool({
        catalogId: catalog.id,
        name: params.toolName,
        description: params.toolDescription,
        meta: {
          _meta: { ui: { resourceUri: `ui://${catalog.id}/app.html` } },
        },
      });
      return catalog;
    };

    const percentName = await makeExternalApp({
      catalogName: "100% External",
      catalogDescription: "Catalog name marker",
      toolName: "percentname",
      toolDescription: "Ordinary description",
    });
    const underscoreDescription = await makeExternalApp({
      catalogName: "Underscore Description",
      catalogDescription: "Contains an _ marker",
      toolName: "underscoredescription",
      toolDescription: "Ordinary description",
    });
    const backslashToolName = await makeExternalApp({
      catalogName: "Backslash Tool Name",
      catalogDescription: "Tool name marker",
      toolName: "back\\slash",
      toolDescription: "Ordinary description",
    });
    const percentToolDescription = await makeExternalApp({
      catalogName: "Tool Description Marker",
      catalogDescription: "Ordinary catalog description",
      toolName: "percentdescription",
      toolDescription: "MiXeD needle with a % marker",
    });

    const searchExternal = async (search: string) => {
      const response = await app.inject({
        method: "GET",
        url: `/api/apps?limit=100&offset=0&search=${encodeURIComponent(search)}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<AppListResponse>();
      const catalogIds = body.data
        .filter((item) => item.source === "external")
        .map((item) => item.catalogId)
        .sort();
      return { catalogIds, total: body.pagination.total };
    };

    expect(await searchExternal("%")).toEqual({
      catalogIds: [percentName.id, percentToolDescription.id].sort(),
      total: 2,
    });
    expect(await searchExternal("_")).toEqual({
      catalogIds: [underscoreDescription.id],
      total: 1,
    });
    expect(await searchExternal("\\")).toEqual({
      catalogIds: [backslashToolName.id],
      total: 1,
    });
    expect(await searchExternal("mixed NEEDLE")).toEqual({
      catalogIds: [percentToolDescription.id],
      total: 1,
    });
  });

  test("includes assigned team names for a team-scoped owned app", async ({
    makeApp,
    makeTeam,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, user.id, { name: "London HQ" });
    await makeTeamMember(team.id, user.id);
    const owned = await makeApp({
      organizationId,
      scope: "team",
      authorId: user.id,
      teamIds: [team.id],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/apps?limit=100&offset=0",
    });
    expect(res.statusCode).toBe(200);
    const item = (res.json().data as Array<Record<string, unknown>>).find(
      (i) => i.source === "owned" && i.id === owned.id,
    );
    expect(item?.teams).toEqual([{ id: team.id, name: "London HQ" }]);
  });

  test("lists external UI-providing servers alongside owned apps, with trust disclosure", async ({
    makeApp,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const owned = await makeApp({
      organizationId,
      scope: "org",
      name: "My Owned App",
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Get Time",
      icon: "🕒",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeTool({
      catalogId: catalog.id,
      name: "get-time",
      description: "Tells the current time",
      meta: { _meta: { ui: { resourceUri: "ui://get-time/app.html" } } },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/apps?limit=100&offset=0",
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().data as Array<Record<string, unknown>>;

    expect(
      items.find((i) => i.source === "owned" && i.id === owned.id),
    ).toMatchObject({
      source: "owned",
      executionModel: "viewer-scoped",
      cspOrigin: "platform-pinned",
    });
    expect(
      items.find((i) => i.source === "external" && i.catalogId === catalog.id),
    ).toMatchObject({
      source: "external",
      catalogId: catalog.id,
      scope: "org",
      // "<server> / <tool>" title, tool description as subtitle.
      name: "Get Time / get-time",
      description: "Tells the current time",
      resourceUri: "ui://get-time/app.html",
      executionModel: "server-scoped",
      cspOrigin: "author-declared",
      // The catalog's registry icon rides along so the card can show it.
      icon: "🕒",
      // No required inputs → runnable standalone.
      requiresInput: false,
    });
  });

  test("flags external apps whose tool has required inputs (requiresInput)", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Archestra PM",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeTool({
      catalogId: catalog.id,
      name: "show_board",
      parameters: {
        type: "object",
        properties: { boardId: { type: "string" } },
        required: ["boardId"],
      },
      meta: { _meta: { ui: { resourceUri: "ui://pm/board.html" } } },
    });
    await makeTool({
      catalogId: catalog.id,
      name: "show_backlog",
      parameters: {
        type: "object",
        properties: { boardId: { type: "string" } },
      },
      meta: { _meta: { ui: { resourceUri: "ui://pm/backlog.html" } } },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/apps?limit=100&offset=0",
    });
    const items = res.json().data as Array<Record<string, unknown>>;
    const byResource = (uri: string) =>
      items.find((i) => i.source === "external" && i.resourceUri === uri);
    // Required inputs → prompt-mode only, no standalone render.
    expect(byResource("ui://pm/board.html")).toMatchObject({
      requiresInput: true,
    });
    // Optional-only inputs render fine with `{}`.
    expect(byResource("ui://pm/backlog.html")).toMatchObject({
      requiresInput: false,
    });
  });

  test("lists a UI catalog's tool once per accessible install", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Archestra PM",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeTool({
      catalogId: catalog.id,
      name: "open",
      meta: { _meta: { ui: { resourceUri: "ui://pm/app.html" } } },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/apps?limit=100&offset=0",
    });
    const items = res.json().data as Array<Record<string, unknown>>;
    const external = items.filter(
      (i) => i.source === "external" && i.catalogId === catalog.id,
    );
    // One card per concrete install, each carrying a distinct mcpServerId.
    expect(external).toHaveLength(3);
    expect(new Set(external.map((i) => i.mcpServerId)).size).toBe(3);
  });

  test("lists each ui:// tool of one server as its own card (server title, tool subtitle)", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Archestra PM",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeTool({
      catalogId: catalog.id,
      name: "show_board",
      meta: { _meta: { ui: { resourceUri: "ui://pm/board.html" } } },
    });
    await makeTool({
      catalogId: catalog.id,
      name: "show_backlog",
      meta: { _meta: { ui: { resourceUri: "ui://pm/backlog.html" } } },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/apps?limit=100&offset=0",
    });
    const items = res.json().data as Array<Record<string, unknown>>;
    const external = items.filter(
      (i) => i.source === "external" && i.catalogId === catalog.id,
    );
    // Each tool is its own card, titled "<server> / <tool>".
    expect(external.map((i) => i.name).sort()).toEqual([
      "Archestra PM / show_backlog",
      "Archestra PM / show_board",
    ]);
  });

  test("excludes catalogs without a ui:// tool from the unified listing", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Plain",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeTool({
      catalogId: catalog.id,
      name: "noop",
      meta: { _meta: {} },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/apps?limit=100&offset=0",
    });
    const items = res.json().data as Array<Record<string, unknown>>;
    expect(
      items.some((i) => i.source === "external" && i.catalogId === catalog.id),
    ).toBe(false);
  });

  test("does not surface another author's personal-scope app to an admin caller", async ({
    makeUser,
    makeApp,
  }) => {
    const otherAuthor = await makeUser();
    const foreignPersonal = await makeApp({
      organizationId,
      scope: "personal",
      authorId: otherAuthor.id,
      name: "Someone Else's Personal App",
    });
    const ownPersonal = await makeApp({
      organizationId,
      scope: "personal",
      authorId: user.id,
      name: "My Personal App",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/apps?limit=100&offset=0",
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as Array<{ id: string }>).map((a) => a.id);
    // The caller is an org admin, yet the listing union is role-independent:
    // a personal app appears only in its own author's listing.
    expect(ids).toContain(ownPersonal.id);
    expect(ids).not.toContain(foreignPersonal.id);
  });
});
