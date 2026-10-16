import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import { seedCoverage } from "@/test/openappa-coverage";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./openappa-coverage.routes";

describe("GET /api/openappa/coverage/entities", () => {
  const ctx = useRouteTestApp(routes);
  beforeEach(async ({ makeMember }) => {
    config.openappa.enabled = true;
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  });

  test("lists neither gateways nor agents", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const otherUser = await makeUser();
    await makeMember(otherUser.id, ctx.organizationId);
    const ownGateway = await makeAgent({
      organizationId: ctx.organizationId,
      name: "My Gateway",
      agentType: "mcp_gateway",
      access: "personal",
      authorId: ctx.user.id,
      accessAllTools: true,
    });
    const otherGateway = await makeAgent({
      organizationId: ctx.organizationId,
      name: "My Gateway",
      agentType: "mcp_gateway",
      access: "personal",
      authorId: otherUser.id,
      accessAllTools: true,
    });
    const unassigned = await makeAgent({
      organizationId: ctx.organizationId,
      name: "Unassigned analyst",
      agentType: "agent",
    });

    // Only registry servers are policy targets.
    for (const url of [
      "/api/openappa/coverage/entities?search=My%20Gateway",
      `/api/openappa/coverage/entities?entityId=${ownGateway.id}&limit=1`,
      `/api/openappa/coverage/entities?entityId=${otherGateway.id}&limit=1`,
      "/api/openappa/coverage/entities?search=Unassigned",
      `/api/openappa/coverage/entities?entityId=${unassigned.id}&limit=1`,
    ]) {
      const response = await ctx.app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual([]);
    }
    for (const type of ["agent", "mcp_gateway"]) {
      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/openappa/coverage/entities?type=${type}`,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  test("sorts by name or by tool count, either way", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const small = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Beta ordered",
    });
    await makeTool({ catalogId: small.id, name: "beta__a", rawName: "a" });
    const large = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Gamma ordered",
    });
    await makeTool({ catalogId: large.id, name: "gamma__a", rawName: "a" });
    await makeTool({ catalogId: large.id, name: "gamma__b", rawName: "b" });

    const order = async (sort: string) => {
      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/openappa/coverage/entities?search=ordered${sort}`,
      });
      expect(response.statusCode).toBe(200);
      return response.json().data.map((row: { id: string }) => row.id);
    };

    expect(await order("")).toEqual([small.id, large.id]);
    expect(await order("&sortBy=name&sortDirection=desc")).toEqual([
      large.id,
      small.id,
    ]);
    expect(await order("&sortBy=tools&sortDirection=desc")).toEqual([
      large.id,
      small.id,
    ]);
  });

  test("identifies the built-in default fallback for a server's tool", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Docs",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "docs__search",
      rawName: "search",
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/openappa/coverage/tools?catalogId=${catalog.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({
        fullName: "docs__search",
        policySource: "not_covered",
        unlisted: true,
      }),
    ]);
  });

  test("the default policy covers run_command at the root and search_tools, search_files, and load_skill through the archestra battery, and leaves other built-in tools to the fallback", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const builtInCatalog = await makeInternalMcpCatalog({
      id: ARCHESTRA_MCP_CATALOG_ID,
      organizationId: null,
      name: "Archestra",
    });
    for (const rawName of [
      "run_command",
      "search_tools",
      "search_files",
      "load_skill",
      "list_skills",
    ]) {
      await makeTool({
        catalogId: builtInCatalog.id,
        name: `archestra__${rawName}`,
        rawName,
      });
    }

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/openappa/coverage/tools?catalogId=${builtInCatalog.id}&limit=10`,
    });
    expect(response.statusCode).toBe(200);
    const sources = Object.fromEntries(
      (
        response.json().data as Array<{
          fullName: string;
          policySource: string;
        }>
      ).map((row) => [row.fullName, row.policySource]),
    );
    expect(sources).toEqual({
      archestra__run_command: "root",
      archestra__search_tools: "battery",
      archestra__search_files: "battery",
      archestra__load_skill: "battery",
      archestra__list_skills: "not_covered",
    });
  });

  test("reports registry servers by policy coverage while omitting apps and gateways", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeAgent,
    makeAgentTool,
  }) => {
    const { catalogIds, toolIds } = await seedCoverage({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      fixtures: { makeInternalMcpCatalog, makeTool, makeAgent, makeAgentTool },
    });
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      name: "Analyst",
      agentType: "mcp_gateway",
    });
    const gateway = await makeAgent({
      organizationId: ctx.organizationId,
      name: "Tool gateway",
      agentType: "mcp_gateway",
    });
    await makeAgentTool(agent.id, toolIds.acme__delete_item);
    await makeAgentTool(agent.id, toolIds.docs__list_pages);
    await makeAgentTool(agent.id, toolIds.docs__microsoft_docs_search);
    await makeAgentTool(gateway.id, toolIds.acme__list_items);

    const builtInCatalog = await makeInternalMcpCatalog({
      id: ARCHESTRA_MCP_CATALOG_ID,
      organizationId: null,
      name: "Archestra",
    });
    const builtInTool = await makeTool({
      catalogId: builtInCatalog.id,
      name: "archestra__search_tools",
      rawName: "search_tools",
    });
    await makeAgentTool(agent.id, builtInTool.id);

    const serverList = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/coverage/entities?type=mcp_server&limit=100",
    });
    expect(serverList.statusCode).toBe(200);
    expect(serverList.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: ARCHESTRA_MCP_CATALOG_ID,
          name: "Archestra",
          type: "mcp_server",
          toolCount: 1,
        }),
        expect.objectContaining({ id: catalogIds.docs }),
      ]),
    );
    expect(
      serverList
        .json()
        .data.every((entity: { type: string }) => entity.type === "mcp_server"),
    ).toBe(true);
    const listedIds = serverList
      .json()
      .data.map((entity: { id: string }) => entity.id);
    expect(listedIds).not.toContain(agent.id);
    expect(listedIds).not.toContain(gateway.id);

    const appCatalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Private dashboard",
      serverType: "app",
    });
    const appLaunch = await makeTool({
      catalogId: appCatalog.id,
      name: "private_dashboard__open",
      rawName: "open",
    });
    await makeAgentTool(agent.id, appLaunch.id);

    const serverResponse = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/coverage/entities?type=mcp_server&search=Docs",
    });
    expect(serverResponse.statusCode).toBe(200);
    expect(serverResponse.json().data).toEqual([
      expect.objectContaining({
        id: catalogIds.docs,
        name: "Docs",
        type: "mcp_server",
        scope: "org",
        toolCount: 3,
        governedCount: 2,
        fallbackCount: 1,
        rules: {
          root: 0,
          battery: 2,
          notEnforced: 0,
          notCovered: 1,
          catchAll: 0,
        },
      }),
    ]);

    const emptyServerResponse = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/coverage/entities?type=mcp_server&search=Linear",
    });
    expect(emptyServerResponse.statusCode).toBe(200);
    expect(emptyServerResponse.json().data).toEqual([
      expect.objectContaining({
        id: catalogIds.linear,
        type: "mcp_server",
        toolCount: 0,
        governedCount: 0,
      }),
    ]);

    const serverToolsResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/openappa/coverage/tools?catalogId=${catalogIds.docs}`,
    });
    expect(serverToolsResponse.statusCode).toBe(200);
    expect(
      serverToolsResponse
        .json()
        .data.map((tool: { catalogId: string }) => tool.catalogId),
    ).toEqual([
      catalogIds.docs,
      catalogIds.docs,
      catalogIds.docs,
      catalogIds.docs,
    ]);

    const appResponse = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/coverage/entities?type=mcp_server&search=Private%20dashboard",
    });
    expect(appResponse.statusCode).toBe(200);
    expect(appResponse.json().data).toEqual([]);
  });

  test("narrows to the server of one tool", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeAgent,
    makeAgentTool,
  }) => {
    const { catalogIds, toolIds } = await seedCoverage({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      fixtures: { makeInternalMcpCatalog, makeTool, makeAgent, makeAgentTool },
    });
    const caller = await makeAgent({
      organizationId: ctx.organizationId,
      name: "Deleter",
      agentType: "agent",
    });
    const gateway = await makeAgent({
      organizationId: ctx.organizationId,
      name: "Deleting gateway",
      agentType: "mcp_gateway",
    });
    const bystander = await makeAgent({
      organizationId: ctx.organizationId,
      name: "Reader",
      agentType: "agent",
    });
    await makeAgentTool(caller.id, toolIds.acme__delete_item);
    await makeAgentTool(gateway.id, toolIds.acme__delete_item);
    await makeAgentTool(bystander.id, toolIds.acme__list_items);

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/openappa/coverage/entities?toolId=${toolIds.acme__delete_item}`,
    });
    expect(response.statusCode).toBe(200);
    const ids = response.json().data.map((entity: { id: string }) => entity.id);
    expect(ids).toEqual([catalogIds.acme]);
  });
});
