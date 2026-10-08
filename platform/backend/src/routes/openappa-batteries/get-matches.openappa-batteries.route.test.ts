import {
  ADMIN_ROLE_NAME,
  ARCHESTRA_MCP_CATALOG_ID,
  CLAUDE_CODE_CLIENT_ID,
} from "@archestra/shared";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import ToolModel from "@/models/tool";
import ToolObservationModel from "@/models/tool-observation";
import { openappaBatteriesService } from "@/openappa/batteries";
import { openappaDeclarations } from "@/openappa/declarations";
import { toolEntries } from "@/openappa/policy-text";
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
          payload: {
            batteryName: "github",
            attachment: { kind: "catalog", catalogId: catalog.id },
          },
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

  const detectedMatches = (detectedId: string) =>
    app.inject({
      method: "GET",
      url: `/api/openappa/battery-matches?detectedId=${encodeURIComponent(detectedId)}`,
    });

  /** A tool the bundled github battery's own rules name, so a server declaring it is a fit. */
  async function githubRuleToolName(): Promise<string> {
    const battery = await openappaDeclarations.resolveInstalled({
      organizationId,
      name: "github",
      packageHash: null,
    });
    const named = toolEntries(battery?.policy ?? "")
      .map((entry) => /^mcp\/[^/]+\/([^/*][^/]*)$/.exec(entry.name)?.[1])
      .find((name): name is string => name !== undefined);
    if (!named) throw new Error("the github battery names no tool");
    return named;
  }

  test("a detected server is matched on the tools a battery's rules name, and its attach is reported", async ({
    makeUser,
    makeMember,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId);
    const named = await githubRuleToolName();
    await ToolModel.bulkCreateProxyToolsIfNotExists(
      [
        { name: `mcp__github__${named}`, description: null, parameters: {} },
        { name: "mcp__weather__forecast", description: null, parameters: {} },
      ],
      "",
    );
    await ToolObservationModel.recordObservations({
      toolNames: [`mcp__github__${named}`, "mcp__weather__forecast"],
      userId: member.id,
      externalAgentId: CLAUDE_CODE_CLIENT_ID,
    });

    expect((await detectedMatches("claude-code.github")).json()).toEqual({
      attach: "ready",
      matches: [{ battery: "github", evidence: "tool", install: null }],
    });
    expect((await detectedMatches("claude-code.weather")).json()).toEqual({
      attach: "ready",
      matches: [],
    });

    const attached = await app.inject({
      method: "POST",
      url: "/api/openappa/battery-installs",
      payload: {
        batteryName: "github",
        attachment: { kind: "detected", detectedId: "claude-code.github" },
      },
    });
    expect(attached.statusCode, attached.body).toBe(200);
    expect((await detectedMatches("claude-code.github")).json()).toMatchObject({
      matches: [
        {
          battery: "github",
          install: {
            kind: "detected",
            detectedId: "claude-code.github",
            catalogId: null,
          },
        },
      ],
    });
  });

  test("a detected server nobody in the organization declared is not found, and the query names exactly one server", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const outsider = await makeUser();
    await makeMember(outsider.id, (await makeOrganization()).id);
    await ToolModel.bulkCreateProxyToolsIfNotExists(
      [{ name: "mcp__github__get_me", description: null, parameters: {} }],
      "",
    );
    await ToolObservationModel.recordObservations({
      toolNames: ["mcp__github__get_me"],
      userId: outsider.id,
      externalAgentId: CLAUDE_CODE_CLIENT_ID,
    });
    expect((await detectedMatches("claude-code.github")).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/openappa/battery-matches",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/openappa/battery-matches?catalogId=${ARCHESTRA_MCP_CATALOG_ID}&detectedId=claude-code.github`,
        })
      ).statusCode,
    ).toBe(400);
  });
});
