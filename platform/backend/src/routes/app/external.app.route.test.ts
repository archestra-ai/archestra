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

describe("GET /api/apps/external/:mcpServerId", () => {
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

  test("resolves a single external UI-providing server by id", async ({
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
      url: `/api/apps/external/${server.id}`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      source: "external",
      mcpServerId: server.id,
      resourceUri: "ui://gt/app.html",
    });
  });

  test("returns 404 for an unknown server id", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/apps/external/${crypto.randomUUID()}`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("returns 404 for an installed server without a ui:// tool", async ({
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
    const plain = await makeMcpServer({
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
      url: `/api/apps/external/${plain.id}`,
    });
    expect(notUi.statusCode).toBe(404);
  });
});
