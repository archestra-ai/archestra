import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import type { User } from "@/types";

describe("GET /api/apps", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  const appsEnabled = config.apps.enabled;
  beforeAll(() => {
    (config.apps as { enabled: boolean }).enabled = true;
  });
  afterAll(() => {
    (config.apps as { enabled: boolean }).enabled = appsEnabled;
  });

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

  test("the whole surface 404s when the feature is disabled", async () => {
    (config.apps as { enabled: boolean }).enabled = false;
    const response = await app.inject({ method: "GET", url: "/api/apps" });
    (config.apps as { enabled: boolean }).enabled = true;
    expect(response.statusCode).toBe(404);
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
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const server = await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    await makeTool({
      catalogId: catalog.id,
      name: "get-time",
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
      items.find((i) => i.source === "external" && i.mcpServerId === server.id),
    ).toMatchObject({
      source: "external",
      name: "Get Time",
      resourceUri: "ui://get-time/app.html",
      executionModel: "server-scoped",
      cspOrigin: "author-declared",
    });
  });

  test("excludes installed servers without a ui:// tool from the unified listing", async ({
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
    const server = await makeMcpServer({ catalogId: catalog.id, scope: "org" });
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
      items.some((i) => i.source === "external" && i.mcpServerId === server.id),
    ).toBe(false);
  });
});
