import { ADMIN_ROLE_NAME } from "@archestra/shared";
import McpServerUserModel from "@/models/mcp-server-user";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/apps/external/:catalogId", () => {
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

  test("resolves an external app by catalog id with its UI resource, installs, and default", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Get Time",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const server = await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeTool({
      catalogId: catalog.id,
      name: "get-time",
      meta: { _meta: { ui: { resourceUri: "ui://gt/app.html" } } },
    });

    const ok = await app.inject({
      method: "GET",
      url: `/api/apps/external/${catalog.id}`,
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body).toMatchObject({
      catalogId: catalog.id,
      name: "Get Time",
      resourceUri: "ui://gt/app.html",
      defaultMcpServerId: server.id,
    });
    expect(
      body.installs.some(
        (i: { mcpServerId: string }) => i.mcpServerId === server.id,
      ),
    ).toBe(true);
    // Single UI tool → one resource, labelled "<server> / <tool>".
    expect(body.resources).toEqual([
      {
        resourceUri: "ui://gt/app.html",
        toolName: "get-time",
        name: "Get Time / get-time",
        requiresInput: false,
      },
    ]);
  });

  test("lists every ui:// resource of a multi-tool server, each with a composed label", async ({
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
    // show_board has a required input, so its resource is flagged for the run
    // page's open-in-chat handoff instead of a bare render.
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
      meta: { _meta: { ui: { resourceUri: "ui://pm/backlog.html" } } },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/apps/external/${catalog.id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Sorted by tool name: show_backlog before show_board.
    expect(body.resources).toEqual([
      {
        resourceUri: "ui://pm/backlog.html",
        toolName: "show_backlog",
        name: "Archestra PM / show_backlog",
        requiresInput: false,
      },
      {
        resourceUri: "ui://pm/board.html",
        toolName: "show_board",
        name: "Archestra PM / show_board",
        requiresInput: true,
      },
    ]);
    // Default resource is the first (lowest-named) tool.
    expect(body.resourceUri).toBe("ui://pm/backlog.html");
  });

  test("orders installs by scope precedence (personal first) and defaults to the personal install", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Multi-install",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    // Org install created first; a naive DB-order result would list it first.
    const org = await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    const personal = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: user.id,
    });
    await McpServerUserModel.assignUserToMcpServer(personal.id, user.id);
    await makeTool({
      catalogId: catalog.id,
      name: "draw",
      meta: { _meta: { ui: { resourceUri: "ui://mi/app.html" } } },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/apps/external/${catalog.id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(
      body.installs.map((i: { mcpServerId: string }) => i.mcpServerId),
    ).toEqual([personal.id, org.id]);
    expect(body.defaultMcpServerId).toBe(personal.id);
  });

  test("resolves a visible catalog with no accessible install to a null default and no installs", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Uninstalled",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "draw",
      meta: { _meta: { ui: { resourceUri: "ui://un/app.html" } } },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/apps/external/${catalog.id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.defaultMcpServerId).toBeNull();
    expect(body.installs).toEqual([]);
  });

  test("returns 404 for an unknown catalog id", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/apps/external/${crypto.randomUUID()}`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("returns 404 for a catalog without a ui:// tool", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const plainCatalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Plain",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    await makeMcpServer({
      catalogId: plainCatalog.id,
      scope: "org",
    });
    await makeTool({
      catalogId: plainCatalog.id,
      name: "noop",
      meta: { _meta: {} },
    });

    const notUi = await app.inject({
      method: "GET",
      url: `/api/apps/external/${plainCatalog.id}`,
    });
    expect(notUi.statusCode).toBe(404);
  });
});
