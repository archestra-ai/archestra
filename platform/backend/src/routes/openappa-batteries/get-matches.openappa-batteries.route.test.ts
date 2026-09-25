import { ADMIN_ROLE_NAME, ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import ToolModel from "@/models/tool";
import { openappaBatteriesService } from "@/openappa/batteries";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import routes from "./openappa-batteries.routes";

describe("guardrails battery matches", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    const user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    config.openappa.enabled = true;
    // The shipped default governs the built-in tools, as every deployment seeds them.
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    await app.register(routes);
  });
  afterEach(async () => {
    await app.close();
  });

  const matches = (catalogId: string) =>
    app.inject({
      method: "GET",
      url: `/api/openappa/battery-matches?catalogId=${catalogId}`,
    });

  test("a matching catalog entry reports its battery, the evidence and the row it was declared for", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Code",
      serverUrl: "https://api.githubcopilot.com/mcp/",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "github__get_me",
      rawName: "get_me",
    });
    // A synced catalog is only a suggestion: nothing is declared for it.
    await openappaBatteriesService.onCatalogToolsChanged(catalog.id);
    expect((await matches(catalog.id)).json()).toEqual({
      attach: "ready",
      matches: [{ battery: "github", evidence: "host", install: null }],
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/openappa/battery-installs",
          payload: { batteryName: "github", catalogId: catalog.id },
        })
      ).statusCode,
    ).toBe(200);
    expect((await matches(catalog.id)).json()).toMatchObject({
      matches: [
        {
          battery: "github",
          evidence: "host",
          install: { catalogId: catalog.id, status: "missing_credentials" },
        },
      ],
    });
  });

  test("a name-only match is reported undeclared, and an unrelated entry matches nothing", async ({
    makeInternalMcpCatalog,
  }) => {
    const byName = await makeInternalMcpCatalog({
      organizationId,
      name: "Slack bridge",
      serverUrl: "https://mcp.example.com/chat",
    });
    await openappaBatteriesService.onCatalogToolsChanged(byName.id);
    // Nothing synced yet: the match is offered, the attach is not.
    expect((await matches(byName.id)).json()).toEqual({
      attach: "unsynced",
      matches: [{ battery: "slack", evidence: "name", install: null }],
    });
    const plain = await makeInternalMcpCatalog({
      organizationId,
      name: "Weather",
      serverUrl: "https://mcp.example.com/weather",
    });
    expect((await matches(plain.id)).json()).toEqual({
      attach: "unsynced",
      matches: [],
    });
  });

  test("another organization's catalog entry is not found", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const foreign = await makeInternalMcpCatalog({
      organizationId: (await makeOrganization()).id,
      name: "Code",
      serverUrl: "https://github.com/mcp",
    });
    expect((await matches(foreign.id)).statusCode).toBe(404);
  });
});
