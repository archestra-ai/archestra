import { getArchestraMcpTools } from "@/archestra-mcp-server";
import { describe, expect, test } from "@/test";
import AgentToolModel from "./agent-tool";
import ToolModel from "./tool";

describe("Archestra Tools Dynamic Assignment", () => {
  test("agents get Archestra tools after explicit assignment", async ({
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    // Create a new agent
    const agent = await makeAgent({ name: "New Agent" });

    // Explicitly seed and assign Archestra tools
    await seedAndAssignArchestraTools(agent.id);

    // Verify agent has Archestra tools assigned
    const toolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
    const archestraToolCount = getArchestraMcpTools().length;
    expect(toolIds).toHaveLength(archestraToolCount);

    // Verify getMcpToolsByAgent returns Archestra tools
    const tools = await ToolModel.getMcpToolsByAgent(agent.id);
    expect(tools).toHaveLength(archestraToolCount);

    // Verify the tool names match
    const toolNames = tools.map((t) => t.name).sort();
    const expectedNames = getArchestraMcpTools()
      .map((t) => t.name)
      .sort();
    expect(toolNames).toEqual(expectedNames);
  });

  test("does not duplicate Archestra tools on subsequent getMcpToolsByAgent calls", async ({
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    // Seed and assign Archestra tools first
    await seedAndAssignArchestraTools(agent.id);

    // First call
    const firstCall = await ToolModel.getMcpToolsByAgent(agent.id);
    const firstCount = firstCall.length;

    // Second call - should not duplicate
    const secondCall = await ToolModel.getMcpToolsByAgent(agent.id);
    const secondCount = secondCall.length;

    expect(firstCount).toBe(secondCount);
    expect(firstCount).toBeGreaterThan(0);
  });

  test("getMcpToolsByAgent includes both Archestra and MCP server tools", async ({
    makeAgent,
    makeTool,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent({ name: "Test Agent" });

    // Seed and assign Archestra tools first
    await seedAndAssignArchestraTools(agent.id);

    // Create an MCP server tool
    const catalogItem = await makeInternalMcpCatalog({
      name: "test-mcp-server",
      serverUrl: "https://test.com/mcp/",
    });

    const mcpServer = await makeMcpServer({
      name: "test-server",
      catalogId: catalogItem.id,
      ownerId: user.id,
    });

    const mcpTool = await makeTool({
      name: "test_mcp_tool",
      description: "Test MCP tool",
      parameters: {},
      catalogId: catalogItem.id,
      mcpServerId: mcpServer.id,
    });

    // Assign MCP tool to agent
    await AgentToolModel.create(agent.id, mcpTool.id);

    // Get all tools - should include Archestra + MCP server tool
    const tools = await ToolModel.getMcpToolsByAgent(agent.id);

    const archestraToolCount = getArchestraMcpTools().length;
    expect(tools).toHaveLength(archestraToolCount + 1); // Archestra tools + 1 MCP tool

    // Verify MCP tool is included
    const mcpToolFound = tools.find((t) => t.name === "test_mcp_tool");
    expect(mcpToolFound).toBeDefined();

    // Verify Archestra tools are included
    const archestraToolNames = getArchestraMcpTools().map((t) => t.name);
    for (const name of archestraToolNames) {
      const archestraToolFound = tools.find((t) => t.name === name);
      expect(archestraToolFound).toBeDefined();
    }
  });

  test("does not include proxy-discovered tools in getMcpToolsByAgent", async ({
    makeAgent,
    makeTool,
    seedAndAssignArchestraTools,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    // Seed and assign Archestra tools first
    await seedAndAssignArchestraTools(agent.id);

    // Create a proxy-discovered tool (agentId set, catalogId null)
    await makeTool({
      agentId: agent.id,
      name: "proxy_discovered_tool",
      description: "Proxy discovered tool",
      parameters: {},
    });

    // Get MCP tools - should NOT include proxy-discovered tool
    const tools = await ToolModel.getMcpToolsByAgent(agent.id);

    const proxyTool = tools.find((t) => t.name === "proxy_discovered_tool");
    expect(proxyTool).toBeUndefined();

    // Should only have Archestra tools (proxy-discovered tools are excluded)
    const archestraToolCount = getArchestraMcpTools().length;
    expect(tools).toHaveLength(archestraToolCount);
  });
});
