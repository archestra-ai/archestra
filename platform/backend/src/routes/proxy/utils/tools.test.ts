import { AgentToolModel, ToolModel } from "@/models";
import { describe, expect, test } from "@/test";
import { persistTools } from "./tools";

describe("persistTools", () => {
  test("creates new tools and agent-tool relationships in bulk", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    const tools = [
      {
        toolName: "new-tool-1",
        toolParameters: { type: "object", properties: {} },
        toolDescription: "First tool",
      },
      {
        toolName: "new-tool-2",
        toolParameters: { type: "object", properties: {} },
        toolDescription: "Second tool",
      },
      {
        toolName: "new-tool-3",
        toolParameters: { type: "object", properties: {} },
        toolDescription: "Third tool",
      },
    ];

    await persistTools(tools, agent.id);

    // Verify tools were created
    const agentTools = await ToolModel.getToolsByAgent(agent.id);
    const createdToolNames = agentTools.map((t) => t.name);

    expect(createdToolNames).toContain("new-tool-1");
    expect(createdToolNames).toContain("new-tool-2");
    expect(createdToolNames).toContain("new-tool-3");

    // Verify agent-tool relationships exist
    const toolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
    expect(toolIds.length).toBeGreaterThanOrEqual(3);
  });

  test("handles empty tools array without errors", async ({ makeAgent }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    // Should not throw
    await persistTools([], agent.id);

    // No new tools should be created (only Archestra built-in tools)
    const agentTools = await ToolModel.getToolsByAgent(agent.id);
    const proxyTools = agentTools.filter(
      (t) => t.agentId === agent.id && t.catalogId === null,
    );
    expect(proxyTools).toHaveLength(0);
  });

  test("skips Archestra built-in tools", async ({ makeAgent }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    // Try to persist tools with Archestra tool names
    const tools = [
      {
        toolName: "archestra__whoami", // This is an Archestra built-in tool
        toolParameters: { type: "object" },
        toolDescription: "Fake whoami",
      },
      {
        toolName: "regular-tool",
        toolParameters: { type: "object" },
        toolDescription: "Regular tool",
      },
    ];

    await persistTools(tools, agent.id);

    // Only the regular tool should be created as a proxy-sniffed tool
    const agentTools = await ToolModel.getToolsByAgent(agent.id);
    const proxyTools = agentTools.filter(
      (t) => t.agentId === agent.id && t.catalogId === null,
    );

    expect(proxyTools).toHaveLength(1);
    expect(proxyTools[0].name).toBe("regular-tool");
  });

  test("skips agent delegation tools (agent__*)", async ({ makeAgent }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    // Try to persist tools including agent delegation tools
    const tools = [
      {
        toolName: "agent__research_bot", // Agent delegation tool
        toolParameters: { type: "object" },
        toolDescription: "Should be skipped",
      },
      {
        toolName: "agent__code_reviewer", // Another agent delegation tool
        toolParameters: { type: "object" },
        toolDescription: "Should also be skipped",
      },
      {
        toolName: "regular-tool",
        toolParameters: { type: "object" },
        toolDescription: "Regular tool",
      },
    ];

    await persistTools(tools, agent.id);

    // Only the regular tool should be created
    const agentTools = await ToolModel.getToolsByAgent(agent.id);
    const proxyTools = agentTools.filter(
      (t) => t.agentId === agent.id && t.catalogId === null,
    );

    expect(proxyTools).toHaveLength(1);
    expect(proxyTools[0].name).toBe("regular-tool");
  });

  test("skips MCP tools already assigned to the agent", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });
    const catalog = await makeInternalMcpCatalog();
    const mcpServer = await makeMcpServer({ catalogId: catalog.id });

    // Create an MCP tool and assign it to the agent
    const mcpTool = await makeTool({
      name: "mcp-tool-1",
      catalogId: catalog.id,
      mcpServerId: mcpServer.id,
    });
    await AgentToolModel.createIfNotExists(agent.id, mcpTool.id);

    // Try to persist tools including one with the same name as the MCP tool
    const tools = [
      {
        toolName: "mcp-tool-1", // Same name as MCP tool
        toolParameters: { type: "object" },
        toolDescription: "Should be skipped",
      },
      {
        toolName: "proxy-tool-1",
        toolParameters: { type: "object" },
        toolDescription: "Should be created",
      },
    ];

    await persistTools(tools, agent.id);

    // Only the proxy tool should be created (MCP tool should be skipped)
    const agentTools = await ToolModel.getToolsByAgent(agent.id);
    const proxyTools = agentTools.filter(
      (t) => t.agentId === agent.id && t.catalogId === null,
    );

    expect(proxyTools).toHaveLength(1);
    expect(proxyTools[0].name).toBe("proxy-tool-1");
  });

  test("is idempotent - does not create duplicate tools", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    const tools = [
      {
        toolName: "idempotent-tool",
        toolParameters: { type: "object" },
        toolDescription: "Should only exist once",
      },
    ];

    // Call persistTools twice
    await persistTools(tools, agent.id);
    await persistTools(tools, agent.id);

    // Should only have one tool with this name
    const agentTools = await ToolModel.getToolsByAgent(agent.id);
    const matchingTools = agentTools.filter(
      (t) => t.name === "idempotent-tool",
    );

    expect(matchingTools).toHaveLength(1);
  });

  test("handles tools with missing optional fields", async ({ makeAgent }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    const tools = [
      {
        toolName: "tool-with-all-fields",
        toolParameters: { type: "object" },
        toolDescription: "Has all fields",
      },
      {
        toolName: "tool-without-params",
        // No toolParameters
        toolDescription: "No params",
      },
      {
        toolName: "tool-without-description",
        toolParameters: { type: "object" },
        // No toolDescription
      },
      {
        toolName: "tool-minimal",
        // Only toolName
      },
    ];

    // Should not throw
    await persistTools(tools, agent.id);

    // Verify all tools were created
    const agentTools = await ToolModel.getToolsByAgent(agent.id);
    const proxyToolNames = agentTools
      .filter((t) => t.agentId === agent.id && t.catalogId === null)
      .map((t) => t.name);

    expect(proxyToolNames).toContain("tool-with-all-fields");
    expect(proxyToolNames).toContain("tool-without-params");
    expect(proxyToolNames).toContain("tool-without-description");
    expect(proxyToolNames).toContain("tool-minimal");
  });

  test("handles concurrent calls without errors", async ({ makeAgent }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    const tools = [
      {
        toolName: "concurrent-tool-1",
        toolParameters: { type: "object" },
        toolDescription: "Tool 1",
      },
      {
        toolName: "concurrent-tool-2",
        toolParameters: { type: "object" },
        toolDescription: "Tool 2",
      },
    ];

    // Call persistTools multiple times concurrently - should not throw
    await Promise.all([
      persistTools(tools, agent.id),
      persistTools(tools, agent.id),
      persistTools(tools, agent.id),
    ]);

    // Verify tools were created (at least one of each)
    const agentTools = await ToolModel.getToolsByAgent(agent.id);
    const tool1Exists = agentTools.some((t) => t.name === "concurrent-tool-1");
    const tool2Exists = agentTools.some((t) => t.name === "concurrent-tool-2");

    expect(tool1Exists).toBe(true);
    expect(tool2Exists).toBe(true);
  });

  test("filters all tools when all are MCP or Archestra tools", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });
    const catalog = await makeInternalMcpCatalog();
    const mcpServer = await makeMcpServer({ catalogId: catalog.id });

    // Create an MCP tool and assign it
    const mcpTool = await makeTool({
      name: "existing-mcp-tool",
      catalogId: catalog.id,
      mcpServerId: mcpServer.id,
    });
    await AgentToolModel.createIfNotExists(agent.id, mcpTool.id);

    // Get count before
    const toolsBefore = await ToolModel.getToolsByAgent(agent.id);
    const proxyToolsBefore = toolsBefore.filter(
      (t) => t.agentId === agent.id && t.catalogId === null,
    );

    // Try to persist only tools that should be filtered
    const tools = [
      {
        toolName: "existing-mcp-tool", // MCP tool
        toolParameters: { type: "object" },
        toolDescription: "Should be skipped",
      },
      {
        toolName: "archestra__whoami", // Archestra tool
        toolParameters: { type: "object" },
        toolDescription: "Should be skipped",
      },
    ];

    await persistTools(tools, agent.id);

    // No new proxy tools should be created
    const toolsAfter = await ToolModel.getToolsByAgent(agent.id);
    const proxyToolsAfter = toolsAfter.filter(
      (t) => t.agentId === agent.id && t.catalogId === null,
    );

    expect(proxyToolsAfter.length).toBe(proxyToolsBefore.length);
  });

  test("handles duplicate tool names in input without constraint violation", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    // Input contains duplicate tool names - this should not cause a constraint violation
    const tools = [
      {
        toolName: "duplicate-tool",
        toolParameters: { type: "object" },
        toolDescription: "First occurrence",
      },
      {
        toolName: "duplicate-tool", // Duplicate!
        toolParameters: { type: "object", additionalProperties: true },
        toolDescription: "Second occurrence",
      },
      {
        toolName: "unique-tool",
        toolParameters: { type: "object" },
        toolDescription: "Unique tool",
      },
      {
        toolName: "duplicate-tool", // Triple duplicate!
        toolParameters: {},
        toolDescription: "Third occurrence",
      },
    ];

    // Should not throw a constraint violation error
    await persistTools(tools, agent.id);

    // Verify tools were created (only unique names)
    const agentTools = await ToolModel.getToolsByAgent(agent.id);
    const proxyTools = agentTools.filter(
      (t) => t.agentId === agent.id && t.catalogId === null,
    );

    // Should have exactly 2 unique tools
    const toolNames = proxyTools.map((t) => t.name);
    expect(toolNames).toContain("duplicate-tool");
    expect(toolNames).toContain("unique-tool");
    expect(toolNames.filter((n) => n === "duplicate-tool")).toHaveLength(1);

    // Verify agent-tool relationships don't have duplicates
    const toolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
    const uniqueToolIds = [...new Set(toolIds)];
    expect(toolIds.length).toBe(uniqueToolIds.length);
  });
});
