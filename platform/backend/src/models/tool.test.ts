import { describe, expect, test } from "@/test";
import AgentToolModel from "./agent-tool";
import TeamModel from "./team";
import ToolModel from "./tool";

describe("ToolModel", () => {
  describe("Access Control", () => {
    test("admin can see all tools", async ({
      makeAdmin,
      makeAgent,
      makeTool,
    }) => {
      const admin = await makeAdmin();
      const agent1 = await makeAgent({ name: "Agent1" });
      const agent2 = await makeAgent({ name: "Agent2" });

      await makeTool({
        agentId: agent1.id,
        name: "tool1",
        description: "Tool 1",
      });

      await makeTool({
        agentId: agent2.id,
        name: "tool2",
        description: "Tool 2",
        parameters: {},
      });

      const tools = await ToolModel.findAll(admin.id, true);
      // Expects 10 tools total: 8 Archestra built-in tools + 2 proxy-discovered tools
      expect(tools).toHaveLength(10);
    });

    test("member only sees tools for accessible agents", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
      makeAgent,
      makeTool,
    }) => {
      const user1 = await makeUser();
      const user2 = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      // Create teams and add users
      const team1 = await makeTeam(org.id, admin.id, { name: "Team 1" });
      await TeamModel.addMember(team1.id, user1.id);

      const team2 = await makeTeam(org.id, admin.id, { name: "Team 2" });
      await TeamModel.addMember(team2.id, user2.id);

      // Create agents with team assignments
      const agent1 = await makeAgent({ name: "Agent1", teams: [team1.id] });
      const agent2 = await makeAgent({ name: "Agent2", teams: [team2.id] });

      const tool1 = await makeTool({
        agentId: agent1.id,
        name: "tool1",
        description: "Tool 1",
        parameters: {},
      });

      await makeTool({
        agentId: agent2.id,
        name: "tool2",
        description: "Tool 2",
        parameters: {},
      });

      const tools = await ToolModel.findAll(user1.id, false);
      expect(tools).toHaveLength(1);
      expect(tools[0].id).toBe(tool1.id);
    });

    test("member with no access sees no tools", async ({
      makeUser,
      makeAgent,
      makeTool,
    }) => {
      const user = await makeUser();
      const agent1 = await makeAgent({ name: "Agent1" });

      await makeTool({
        agentId: agent1.id,
        name: "tool1",
        description: "Tool 1",
      });

      const tools = await ToolModel.findAll(user.id, false);
      expect(tools).toHaveLength(0);
    });

    test("findById returns tool for admin", async ({
      makeAdmin,
      makeAgent,
      makeTool,
    }) => {
      const admin = await makeAdmin();
      const agent = await makeAgent();

      const tool = await makeTool({
        agentId: agent.id,
        name: "test-tool",
        description: "Test Tool",
        parameters: {},
      });

      const found = await ToolModel.findById(tool.id, admin.id, true);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(tool.id);
    });

    test("findById returns tool for user with agent access", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
      makeAgent,
      makeTool,
    }) => {
      const user = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      // Create team and add user
      const team = await makeTeam(org.id, admin.id);
      await TeamModel.addMember(team.id, user.id);

      const agent = await makeAgent({ teams: [team.id] });

      const tool = await makeTool({
        agentId: agent.id,
        name: "test-tool",
        description: "Test Tool",
        parameters: {},
      });

      const found = await ToolModel.findById(tool.id, user.id, false);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(tool.id);
    });

    test("findById returns null for user without agent access", async ({
      makeUser,
      makeAgent,
      makeTool,
    }) => {
      const user = await makeUser();
      const agent = await makeAgent();

      const tool = await makeTool({
        agentId: agent.id,
        name: "test-tool",
        description: "Test Tool",
        parameters: {},
      });

      const found = await ToolModel.findById(tool.id, user.id, false);
      expect(found).toBeNull();
    });

    test("findByName returns tool for admin", async ({
      makeAdmin,
      makeAgent,
      makeTool,
    }) => {
      const admin = await makeAdmin();
      const agent = await makeAgent();

      await makeTool({
        agentId: agent.id,
        name: "unique-tool",
        description: "Unique Tool",
        parameters: {},
      });

      const found = await ToolModel.findByName("unique-tool", admin.id, true);
      expect(found).not.toBeNull();
      expect(found?.name).toBe("unique-tool");
    });

    test("findByName returns tool for user with agent access", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
      makeAgent,
      makeTool,
    }) => {
      const user = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      // Create team and add user
      const team = await makeTeam(org.id, admin.id);
      await TeamModel.addMember(team.id, user.id);

      const agent = await makeAgent({ teams: [team.id] });

      await makeTool({
        agentId: agent.id,
        name: "user-tool",
        description: "User Tool",
        parameters: {},
      });

      const found = await ToolModel.findByName("user-tool", user.id, false);
      expect(found).not.toBeNull();
      expect(found?.name).toBe("user-tool");
    });

    test("findByName returns null for user without agent access", async ({
      makeUser,
      makeAgent,
      makeTool,
    }) => {
      const user = await makeUser();
      const agent = await makeAgent();

      await makeTool({
        agentId: agent.id,
        name: "restricted-tool",
        description: "Restricted Tool",
        parameters: {},
      });

      const found = await ToolModel.findByName(
        "restricted-tool",
        user.id,
        false,
      );
      expect(found).toBeNull();
    });
  });

  describe("getMcpToolsAssignedToAgent", () => {
    test("returns empty array when no tools provided", async ({
      makeAgent,
      makeUser,
    }) => {
      const _user = await makeUser();
      const agent = await makeAgent();

      const result = await ToolModel.getMcpToolsAssignedToAgent([], agent.id);
      expect(result).toEqual([]);
    });

    test("returns empty array when no MCP tools assigned to agent", async ({
      makeAgent,
      makeUser,
      makeTool,
    }) => {
      const _user = await makeUser();
      const agent = await makeAgent();

      // Create a proxy-sniffed tool (no mcpServerId)
      await makeTool({
        agentId: agent.id,
        name: "proxy_tool",
        description: "Proxy Tool",
        parameters: {},
      });

      const result = await ToolModel.getMcpToolsAssignedToAgent(
        ["proxy_tool", "non_existent"],
        agent.id,
      );
      expect(result).toEqual([]);
    });

    test("returns MCP tools with server metadata for assigned tools", async ({
      makeUser,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const agent = await makeAgent();

      const catalogItem = await makeInternalMcpCatalog({
        name: "github-mcp-server",
        serverUrl: "https://api.githubcopilot.com/mcp/",
      });

      // Create an MCP server with GitHub metadata
      const mcpServer = await makeMcpServer({
        name: "test-github-server",
        catalogId: catalogItem.id,
        ownerId: user.id,
      });

      // Create an MCP tool
      const mcpTool = await makeTool({
        name: "github_mcp_server__list_issues",
        description: "List GitHub issues",
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string" },
            count: { type: "number" },
          },
        },
        catalogId: catalogItem.id,
        mcpServerId: mcpServer.id,
      });

      // Assign tool to agent
      await AgentToolModel.create(agent.id, mcpTool.id);

      const result = await ToolModel.getMcpToolsAssignedToAgent(
        ["github_mcp_server__list_issues"],
        agent.id,
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        toolName: "github_mcp_server__list_issues",
        mcpServerName: `test-github-server`,
        mcpServerSecretId: null,
        mcpServerCatalogId: catalogItem.id,
        mcpServerId: mcpServer.id,
        responseModifierTemplate: null,
        credentialSourceMcpServerId: null,
        executionSourceMcpServerId: null,
        catalogId: catalogItem.id,
        catalogName: "github-mcp-server",
      });
    });

    test("filters to only requested tool names", async ({
      makeUser,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const agent = await makeAgent();

      const catalogItem = await makeInternalMcpCatalog({
        name: "github-mcp-server",
        serverUrl: "https://api.githubcopilot.com/mcp/",
      });

      // Create an MCP server
      const mcpServer = await makeMcpServer({
        name: "test-server",
        catalogId: catalogItem.id,
        ownerId: user.id,
      });

      // Create multiple MCP tools
      const tool1 = await makeTool({
        name: "tool_one",
        description: "First tool",
        parameters: {},
        catalogId: catalogItem.id,
        mcpServerId: mcpServer.id,
      });

      const tool2 = await makeTool({
        name: "tool_two",
        description: "Second tool",
        parameters: {},
        catalogId: catalogItem.id,
        mcpServerId: mcpServer.id,
      });

      // Assign both tools to agent
      await AgentToolModel.create(agent.id, tool1.id);
      await AgentToolModel.create(agent.id, tool2.id);

      // Request only one tool
      const result = await ToolModel.getMcpToolsAssignedToAgent(
        ["tool_one"],
        agent.id,
      );

      expect(result).toHaveLength(1);
      expect(result[0].toolName).toBe("tool_one");
    });

    test("returns empty array when tools exist but not assigned to agent", async ({
      makeUser,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const agent1 = await makeAgent({ name: "Agent1" });
      const agent2 = await makeAgent({ name: "Agent2" });

      // Create an MCP server and tool
      const catalogItem = await makeInternalMcpCatalog({
        name: "github-mcp-server",
        serverUrl: "https://api.githubcopilot.com/mcp/",
      });
      const mcpServer = await makeMcpServer({
        name: "test-server",
        catalogId: catalogItem.id,
        ownerId: user.id,
      });

      const mcpTool = await makeTool({
        name: "exclusive_tool",
        description: "Exclusive tool",
        parameters: {},
        mcpServerId: mcpServer.id,
      });

      // Assign tool to agent1 only
      await AgentToolModel.create(agent1.id, mcpTool.id);

      // Request tool for agent2 (should return empty)
      const result = await ToolModel.getMcpToolsAssignedToAgent(
        ["exclusive_tool"],
        agent2.id,
      );

      expect(result).toEqual([]);
    });

    test("excludes proxy-sniffed tools (tools with agentId set)", async ({
      makeUser,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const agent = await makeAgent();

      // Create an MCP server
      const catalogItem = await makeInternalMcpCatalog({
        name: "github-mcp-server",
        serverUrl: "https://api.githubcopilot.com/mcp/",
      });
      const mcpServer = await makeMcpServer({
        name: "test-server",
        catalogId: catalogItem.id,
        ownerId: user.id,
      });

      // Create a proxy-sniffed tool (with agentId)
      await makeTool({
        agentId: agent.id,
        name: "proxy_tool",
        description: "Proxy Tool",
        parameters: {},
      });

      // Create an MCP tool (no agentId, linked via mcpServerId)
      const mcpTool = await makeTool({
        name: "mcp_tool",
        description: "MCP Tool",
        parameters: {},
        catalogId: catalogItem.id,
        mcpServerId: mcpServer.id,
      });

      // Assign MCP tool to agent
      await AgentToolModel.create(agent.id, mcpTool.id);

      const result = await ToolModel.getMcpToolsAssignedToAgent(
        ["proxy_tool", "mcp_tool"],
        agent.id,
      );

      // Should only return the MCP tool, not the proxy-sniffed tool
      expect(result).toHaveLength(1);
      expect(result[0].toolName).toBe("mcp_tool");
    });

    test("handles multiple MCP tools with different servers", async ({
      makeUser,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const agent = await makeAgent();

      // Create two MCP servers
      const catalogItem = await makeInternalMcpCatalog({
        name: "github-mcp-server",
        serverUrl: "https://api.githubcopilot.com/mcp/",
      });
      const server1 = await makeMcpServer({
        name: "github-server",
        catalogId: catalogItem.id,
        ownerId: user.id,
      });

      const catalogItem2 = await makeInternalMcpCatalog({
        name: "other-mcp-server",
        serverUrl: "https://api.othercopilot.com/mcp/",
      });
      const server2 = await makeMcpServer({
        name: "other-server",
        catalogId: catalogItem2.id,
      });

      // Create tools for each server
      const githubTool = await makeTool({
        name: "github_list_issues",
        description: "List GitHub issues",
        parameters: {},
        catalogId: catalogItem.id,
        mcpServerId: server1.id,
      });

      const otherTool = await makeTool({
        name: "other_tool",
        description: "Other tool",
        parameters: {},
        catalogId: catalogItem2.id,
        mcpServerId: server2.id,
      });

      // Assign both tools to agent
      await AgentToolModel.create(agent.id, githubTool.id);
      await AgentToolModel.create(agent.id, otherTool.id);

      const result = await ToolModel.getMcpToolsAssignedToAgent(
        ["github_list_issues", "other_tool"],
        agent.id,
      );

      expect(result).toHaveLength(2);
    });
  });
});
