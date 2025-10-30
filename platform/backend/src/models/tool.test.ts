import {
  createTestAdmin,
  createTestOrganization,
  createTestUser,
} from "@/test-utils";
import AgentModel from "./agent";
import AgentToolModel from "./agent-tool";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import McpServerModel from "./mcp-server";
import TeamModel from "./team";
import ToolModel from "./tool";

describe("ToolModel", () => {
  describe("Access Control", () => {
    test("admin can see all tools", async () => {
      const adminId = await createTestAdmin();

      const agent1 = await AgentModel.create({
        name: "Agent1",
        teams: [],
      });
      const agent2 = await AgentModel.create({
        name: "Agent2",
        teams: [],
      });

      await ToolModel.create({
        agentId: agent1.id,
        name: "tool1",
        description: "Tool 1",
        parameters: {},
      });

      await ToolModel.create({
        agentId: agent2.id,
        name: "tool2",
        description: "Tool 2",
        parameters: {},
      });

      const tools = await ToolModel.findAll(adminId, true);
      expect(tools).toHaveLength(2);
    });

    test("member only sees tools for accessible agents", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();
      const adminId = await createTestAdmin();
      const orgId = await createTestOrganization();

      // Create teams and add users
      const team1 = await TeamModel.create({
        name: "Team 1",
        organizationId: orgId,
        createdBy: adminId,
      });
      await TeamModel.addMember(team1.id, user1Id);

      const team2 = await TeamModel.create({
        name: "Team 2",
        organizationId: orgId,
        createdBy: adminId,
      });
      await TeamModel.addMember(team2.id, user2Id);

      // Create agents with team assignments
      const agent1 = await AgentModel.create({
        name: "Agent1",
        teams: [team1.id],
      });
      const agent2 = await AgentModel.create({
        name: "Agent2",
        teams: [team2.id],
      });

      const tool1 = await ToolModel.create({
        agentId: agent1.id,
        name: "tool1",
        description: "Tool 1",
        parameters: {},
      });

      await ToolModel.create({
        agentId: agent2.id,
        name: "tool2",
        description: "Tool 2",
        parameters: {},
      });

      const tools = await ToolModel.findAll(user1Id, false);
      expect(tools).toHaveLength(1);
      expect(tools[0].id).toBe(tool1.id);
    });

    test("member with no access sees no tools", async () => {
      const _user1Id = await createTestUser();
      const user2Id = await createTestUser();

      const agent1 = await AgentModel.create({
        name: "Agent1",
        teams: [],
      });

      await ToolModel.create({
        agentId: agent1.id,
        name: "tool1",
        description: "Tool 1",
        parameters: {},
      });

      const tools = await ToolModel.findAll(user2Id, false);
      expect(tools).toHaveLength(0);
    });

    test("findById returns tool for admin", async () => {
      const _user1Id = await createTestUser();
      const adminId = await createTestAdmin();

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      const tool = await ToolModel.create({
        agentId: agent.id,
        name: "test-tool",
        description: "Test Tool",
        parameters: {},
      });

      const found = await ToolModel.findById(tool.id, adminId, true);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(tool.id);
    });

    test("findById returns tool for user with agent access", async () => {
      const user1Id = await createTestUser();
      const adminId = await createTestAdmin();
      const orgId = await createTestOrganization();

      // Create team and add user
      const team = await TeamModel.create({
        name: "Test Team",
        organizationId: orgId,
        createdBy: adminId,
      });
      await TeamModel.addMember(team.id, user1Id);

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [team.id],
      });

      const tool = await ToolModel.create({
        agentId: agent.id,
        name: "test-tool",
        description: "Test Tool",
        parameters: {},
      });

      const found = await ToolModel.findById(tool.id, user1Id, false);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(tool.id);
    });

    test("findById returns null for user without agent access", async () => {
      const _user1Id = await createTestUser();
      const user2Id = await createTestUser();

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      const tool = await ToolModel.create({
        agentId: agent.id,
        name: "test-tool",
        description: "Test Tool",
        parameters: {},
      });

      const found = await ToolModel.findById(tool.id, user2Id, false);
      expect(found).toBeNull();
    });

    test("findByName returns tool for admin", async () => {
      const _user1Id = await createTestUser();
      const adminId = await createTestAdmin();

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      await ToolModel.create({
        agentId: agent.id,
        name: "unique-tool",
        description: "Unique Tool",
        parameters: {},
      });

      const found = await ToolModel.findByName("unique-tool", adminId, true);
      expect(found).not.toBeNull();
      expect(found?.name).toBe("unique-tool");
    });

    test("findByName returns tool for user with agent access", async () => {
      const user1Id = await createTestUser();
      const adminId = await createTestAdmin();
      const orgId = await createTestOrganization();

      // Create team and add user
      const team = await TeamModel.create({
        name: "Test Team",
        organizationId: orgId,
        createdBy: adminId,
      });
      await TeamModel.addMember(team.id, user1Id);

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [team.id],
      });

      await ToolModel.create({
        agentId: agent.id,
        name: "user-tool",
        description: "User Tool",
        parameters: {},
      });

      const found = await ToolModel.findByName("user-tool", user1Id, false);
      expect(found).not.toBeNull();
      expect(found?.name).toBe("user-tool");
    });

    test("findByName returns null for user without agent access", async () => {
      const _user1Id = await createTestUser();
      const user2Id = await createTestUser();

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      await ToolModel.create({
        agentId: agent.id,
        name: "restricted-tool",
        description: "Restricted Tool",
        parameters: {},
      });

      const found = await ToolModel.findByName(
        "restricted-tool",
        user2Id,
        false,
      );
      expect(found).toBeNull();
    });
  });

  describe("getMcpToolsAssignedToAgent", () => {
    test("returns empty array when no tools provided", async () => {
      const _userId = await createTestUser();
      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      const result = await ToolModel.getMcpToolsAssignedToAgent([], agent.id);
      expect(result).toEqual([]);
    });

    test("returns empty array when no MCP tools assigned to agent", async () => {
      const _userId = await createTestUser();
      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      // Create a proxy-sniffed tool (no mcpServerId)
      await ToolModel.create({
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

    test("returns MCP tools with server metadata for assigned tools", async () => {
      const _userId = await createTestUser();
      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      const catalogItem = await InternalMcpCatalogModel.create({
        name: "github-mcp-server",
        serverType: "remote",
        serverUrl: "https://api.githubcopilot.com/mcp/",
      });

      // Create an MCP server with GitHub metadata
      const mcpServer = await McpServerModel.create({
        name: "test-github-server",
        catalogId: catalogItem.id,
      });

      // Create an MCP tool
      const mcpTool = await ToolModel.create({
        name: "github_mcp_server__list_issues",
        description: "List GitHub issues",
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string" },
            count: { type: "number" },
          },
        },
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
        mcpServerName: "test-github-server",
        mcpServerSecretId: null,
        mcpServerCatalogId: catalogItem.id,
        mcpServerId: mcpServer.id,
        responseModifierTemplate: null,
      });
    });

    test("filters to only requested tool names", async () => {
      const _userId = await createTestUser();
      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      const catalogItem = await InternalMcpCatalogModel.create({
        name: "github-mcp-server",
        serverType: "remote",
        serverUrl: "https://api.githubcopilot.com/mcp/",
      });

      // Create an MCP server
      const mcpServer = await McpServerModel.create({
        name: "test-server",
        catalogId: catalogItem.id,
      });

      // Create multiple MCP tools
      const tool1 = await ToolModel.create({
        name: "tool_one",
        description: "First tool",
        parameters: {},
        mcpServerId: mcpServer.id,
      });

      const tool2 = await ToolModel.create({
        name: "tool_two",
        description: "Second tool",
        parameters: {},
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

    test("returns empty array when tools exist but not assigned to agent", async () => {
      const _user1Id = await createTestUser();
      const _user2Id = await createTestUser();

      const agent1 = await AgentModel.create({
        name: "Agent1",
        teams: [],
      });

      const agent2 = await AgentModel.create({
        name: "Agent2",
        teams: [],
      });

      // Create an MCP server and tool
      const catalogItem = await InternalMcpCatalogModel.create({
        name: "github-mcp-server",
        serverType: "remote",
        serverUrl: "https://api.githubcopilot.com/mcp/",
      });
      const mcpServer = await McpServerModel.create({
        name: "test-server",
        catalogId: catalogItem.id,
      });

      const mcpTool = await ToolModel.create({
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

    test("excludes proxy-sniffed tools (tools with agentId set)", async () => {
      const _userId = await createTestUser();
      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      // Create an MCP server
      const catalogItem = await InternalMcpCatalogModel.create({
        name: "github-mcp-server",
        serverType: "remote",
        serverUrl: "https://api.githubcopilot.com/mcp/",
      });
      const mcpServer = await McpServerModel.create({
        name: "test-server",
        catalogId: catalogItem.id,
      });

      // Create a proxy-sniffed tool (with agentId)
      await ToolModel.create({
        agentId: agent.id,
        name: "proxy_tool",
        description: "Proxy Tool",
        parameters: {},
      });

      // Create an MCP tool (no agentId, linked via mcpServerId)
      const mcpTool = await ToolModel.create({
        name: "mcp_tool",
        description: "MCP Tool",
        parameters: {},
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

    test("handles multiple MCP tools with different servers", async () => {
      const _userId = await createTestUser();
      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      // Create two MCP servers
      const catalogItem = await InternalMcpCatalogModel.create({
        name: "github-mcp-server",
        serverType: "remote",
        serverUrl: "https://api.githubcopilot.com/mcp/",
      });
      const server1 = await McpServerModel.create({
        name: "github-server",
        catalogId: catalogItem.id,
      });

      const catalogItem2 = await InternalMcpCatalogModel.create({
        name: "other-mcp-server",
        serverType: "remote",
        serverUrl: "https://api.othercopilot.com/mcp/",
      });
      const server2 = await McpServerModel.create({
        name: "other-server",
        catalogId: catalogItem2.id,
      });

      // Create tools for each server
      const githubTool = await ToolModel.create({
        name: "github_list_issues",
        description: "List GitHub issues",
        parameters: {},
        mcpServerId: server1.id,
      });

      const otherTool = await ToolModel.create({
        name: "other_tool",
        description: "Other tool",
        parameters: {},
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
