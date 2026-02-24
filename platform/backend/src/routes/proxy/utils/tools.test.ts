import { AgentToolModel, ToolModel } from "@/models";
import { describe, expect, test } from "@/test";
import { persistTools } from "./tools";

describe("persistTools", () => {
  test("creates new tools in bulk", async ({ makeAgent }) => {
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

    // Verify tools were created in the tools table
    const tool1 = await ToolModel.findByName("new-tool-1");
    const tool2 = await ToolModel.findByName("new-tool-2");
    const tool3 = await ToolModel.findByName("new-tool-3");

    expect(tool1).not.toBeNull();
    expect(tool2).not.toBeNull();
    expect(tool3).not.toBeNull();

    // Proxy tools should have no catalogId, no agentId, no delegateToAgentId
    expect(tool1?.catalogId).toBeNull();
    expect(tool1?.agentId).toBeNull();

    // No agent_tools entries should be created
    const toolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
    const proxyToolIds = [tool1?.id, tool2?.id, tool3?.id];
    for (const id of proxyToolIds) {
      expect(toolIds).not.toContain(id);
    }
  });

  test("handles empty tools array without errors", async ({ makeAgent }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    // Should not throw
    await persistTools([], agent.id);
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
    const regularTool = await ToolModel.findByName("regular-tool");
    expect(regularTool).not.toBeNull();
    expect(regularTool?.catalogId).toBeNull();
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
    const regularTool = await ToolModel.findByName("regular-tool");
    expect(regularTool).not.toBeNull();

    // Agent delegation tools should not exist as proxy tools
    const agentTool1 = await ToolModel.findByName("agent__research_bot");
    const agentTool2 = await ToolModel.findByName("agent__code_reviewer");
    expect(agentTool1).toBeNull();
    expect(agentTool2).toBeNull();
  });

  test("skips MCP tools already assigned to the agent", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });
    const catalog = await makeInternalMcpCatalog();
    await makeMcpServer({ catalogId: catalog.id });

    // Create an MCP tool and assign it to the agent
    const mcpTool = await makeTool({
      name: "mcp-tool-1",
      catalogId: catalog.id,
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

    // The proxy tool should be created
    const proxyTool = await ToolModel.findByName("proxy-tool-1");
    expect(proxyTool).not.toBeNull();
    expect(proxyTool?.catalogId).toBeNull();
  });

  test("skips MCP tools with catalogId (even without MCP server)", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });
    const catalog = await makeInternalMcpCatalog();

    // Create an MCP tool with catalogId (catalogId is what identifies MCP tools)
    const mcpTool = await makeTool({
      name: "mcp-tool-orphaned",
      catalogId: catalog.id,
    });
    await AgentToolModel.createIfNotExists(agent.id, mcpTool.id);

    // Try to persist a tool with the same name as the orphaned MCP tool
    const tools = [
      {
        toolName: "mcp-tool-orphaned", // Same name as MCP tool with catalogId
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

    // The proxy tool should be created
    const proxyTool = await ToolModel.findByName("proxy-tool-1");
    expect(proxyTool).not.toBeNull();
    expect(proxyTool?.catalogId).toBeNull();
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
    const tool = await ToolModel.findByName("idempotent-tool");
    expect(tool).not.toBeNull();
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
    expect(await ToolModel.findByName("tool-with-all-fields")).not.toBeNull();
    expect(await ToolModel.findByName("tool-without-params")).not.toBeNull();
    expect(
      await ToolModel.findByName("tool-without-description"),
    ).not.toBeNull();
    expect(await ToolModel.findByName("tool-minimal")).not.toBeNull();
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

    // Verify tools were created
    expect(await ToolModel.findByName("concurrent-tool-1")).not.toBeNull();
    expect(await ToolModel.findByName("concurrent-tool-2")).not.toBeNull();
  });

  test("filters all tools when all are MCP or Archestra tools", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });
    const catalog = await makeInternalMcpCatalog();
    await makeMcpServer({ catalogId: catalog.id });

    // Create an MCP tool and assign it
    const mcpTool = await makeTool({
      name: "existing-mcp-tool",
      catalogId: catalog.id,
    });
    await AgentToolModel.createIfNotExists(agent.id, mcpTool.id);

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

    // No new proxy tools should be created — the existing MCP tool should remain unchanged
    const existingTool = await ToolModel.findByName("existing-mcp-tool");
    expect(existingTool).not.toBeNull();
    expect(existingTool?.catalogId).toBe(catalog.id);
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
    const duplicateTool = await ToolModel.findByName("duplicate-tool");
    const uniqueTool = await ToolModel.findByName("unique-tool");

    expect(duplicateTool).not.toBeNull();
    expect(uniqueTool).not.toBeNull();
  });
});
