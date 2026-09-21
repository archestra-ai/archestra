import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import { openappaBatteriesService } from "@/openappa/batteries";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
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

  test("a matching catalog entry reports its battery, the evidence and the install once attached", async ({
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
    expect((await matches(catalog.id)).json()).toEqual([
      { battery: "github", evidence: "host", install: null },
    ]);
    await openappaBatteriesService.onCatalogToolsChanged(catalog.id);
    expect((await matches(catalog.id)).json()).toMatchObject([
      {
        battery: "github",
        evidence: "host",
        install: { enabled: true, status: "missing_credentials" },
      },
    ]);
  });

  test("a name-only match attaches disabled, and an unrelated entry matches nothing", async ({
    makeInternalMcpCatalog,
  }) => {
    const byName = await makeInternalMcpCatalog({
      organizationId,
      name: "Slack bridge",
      serverUrl: "https://mcp.example.com/chat",
    });
    await openappaBatteriesService.onCatalogToolsChanged(byName.id);
    expect((await matches(byName.id)).json()).toMatchObject([
      { battery: "slack", evidence: "name", install: { enabled: false } },
    ]);
    const plain = await makeInternalMcpCatalog({
      organizationId,
      name: "Weather",
      serverUrl: "https://mcp.example.com/weather",
    });
    expect((await matches(plain.id)).json()).toEqual([]);
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
