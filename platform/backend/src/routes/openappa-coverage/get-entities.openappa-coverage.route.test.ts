import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import config from "@/config";
import ToolModel from "@/models/tool";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
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

  test("matches the active lists: shows unassigned agents and every gateway the caller's wildcard grant reads", async ({
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

    const gateways = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/coverage/entities?search=My%20Gateway",
    });
    expect(gateways.statusCode).toBe(200);
    // The gateway list keeps another member's personal gateway for a caller
    // whose grant reads every gateway, and the report matches that list.
    expect(gateways.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ownGateway.id, scope: "personal" }),
        expect.objectContaining({ id: otherGateway.id, scope: "personal" }),
      ]),
    );
    expect(gateways.json().data).toHaveLength(2);

    const agents = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/coverage/entities?type=agent&search=Unassigned",
    });
    expect(agents.statusCode).toBe(200);
    expect(agents.json().data).toEqual([
      expect.objectContaining({
        id: unassigned.id,
        scope: "org",
        toolCount: 0,
      }),
    ]);

    const byId = await ctx.app.inject({
      method: "GET",
      url: `/api/openappa/coverage/entities?entityId=${unassigned.id}&limit=1`,
    });
    expect(byId.statusCode).toBe(200);
    expect(byId.json().data).toEqual([
      expect.objectContaining({ id: unassigned.id, name: unassigned.name }),
    ]);

    await expect(
      ToolModel.findCoverageInventory(ctx.organizationId, {
        userId: ctx.user.id,
        agentTypes: ["agent", "mcp_gateway"],
      }),
    ).resolves.toMatchObject({ entities: expect.any(Array) });
  });

  test("counts Auto mode tools reachable by the viewer and omits excluded tools", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const gateway = await makeAgent({
      organizationId: ctx.organizationId,
      name: "Dynamic gateway",
      agentType: "mcp_gateway",
      accessAllTools: true,
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Projects",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "projects__list",
      rawName: "list",
    });
    const secondCatalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Other Projects",
    });
    await makeTool({
      catalogId: secondCatalog.id,
      name: "projects__list",
      rawName: "list",
    });
    const excluded = await makeTool({
      catalogId: catalog.id,
      name: "projects__delete",
      rawName: "delete",
    });
    await makeAgentTool(gateway.id, excluded.id);
    await agentToolExclusionsService.replaceExclusions({
      agentId: gateway.id,
      organizationId: ctx.organizationId,
      excludedToolIds: [excluded.id],
    });
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/coverage/entities?search=Dynamic%20gateway",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({
        id: gateway.id,
        autoMode: true,
        toolCount: 1,
        governedCount: 0,
      }),
    ]);

    const tools = await ctx.app.inject({
      method: "GET",
      url: `/api/openappa/coverage/tools?entityId=${gateway.id}`,
    });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().data).toHaveLength(1);
    expect(tools.json().data[0]).toMatchObject({
      fullName: "projects__list",
    });
    expect(tools.json().data[0].toolId).not.toBe(excluded.id);
  });

  test("identifies the built-in default fallback for an assigned tool", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const gateway = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "mcp_gateway",
      name: "Gateway",
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Docs",
    });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "docs__search",
      rawName: "search",
    });
    await makeAgentTool(gateway.id, tool.id);

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/openappa/coverage/tools?entityId=${gateway.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({
        fullName: "docs__search",
        policySource: "built_in",
        unlisted: true,
      }),
    ]);
  });

  test("lists agents, gateways, and registry servers by policy coverage while omitting apps", async ({
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
      agentType: "agent",
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

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/coverage/entities?search=Analyst",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({
        id: agent.id,
        name: "Analyst",
        type: "agent",
        toolCount: 4,
        governedCount: 2,
        fallbackCount: 2,
        builtInCount: 1,
        autoMode: false,
      }),
    ]);

    const gatewayResponse = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/coverage/entities?type=mcp_gateway&search=Tool%20gateway",
    });
    expect(gatewayResponse.statusCode).toBe(200);
    expect(gatewayResponse.json().data).toEqual([
      expect.objectContaining({
        id: gateway.id,
        type: "mcp_gateway",
        toolCount: 1,
        governedCount: 1,
      }),
    ]);

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

    const toolsResponse = await ctx.app.inject({
      method: "GET",
      url: `/api/openappa/coverage/tools?entityId=${agent.id}`,
    });
    expect(toolsResponse.statusCode).toBe(200);
    expect(
      toolsResponse
        .json()
        .data.map((tool: { fullName: string }) => tool.fullName),
    ).toEqual([
      "archestra__search_tools",
      "docs__list_pages",
      "acme__delete_item",
      "docs__microsoft_docs_search",
      "docs__microsoft_docs_search",
    ]);
  });

  test("narrows to the targets that reach one tool", async ({
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
    expect(ids).toEqual(
      expect.arrayContaining([caller.id, gateway.id, catalogIds.acme]),
    );
    expect(ids).toHaveLength(3);
  });
});
