import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { describe, expect, test } from "@/test";
import AgentToolModel from "./agent-tool";
import TeamModel from "./team";
import ToolModel from "./tool";

describe("ToolModel", () => {
  describe("slugifyName", () => {
    test("creates valid tool name from simple server and tool names", () => {
      const result = ToolModel.slugifyName("github", "list_repos");
      expect(result).toBe(`github${MCP_SERVER_TOOL_NAME_SEPARATOR}list_repos`);
    });

    test("converts to lowercase", () => {
      const result = ToolModel.slugifyName("GitHub", "ListRepos");
      expect(result).toBe(`github${MCP_SERVER_TOOL_NAME_SEPARATOR}listrepos`);
    });

    test("replaces spaces with underscores", () => {
      const result = ToolModel.slugifyName("My Server", "list all repos");
      expect(result).toBe(
        `my_server${MCP_SERVER_TOOL_NAME_SEPARATOR}list_all_repos`,
      );
    });

    test("removes brackets from server name", () => {
      const result = ToolModel.slugifyName(
        "[AI SRE Demo] Kubernetes MCP Server",
        "list_namespaces",
      );
      expect(result).toBe(
        `ai_sre_demo_kubernetes_mcp_server${MCP_SERVER_TOOL_NAME_SEPARATOR}list_namespaces`,
      );
    });

    test("removes parentheses from server name", () => {
      const result = ToolModel.slugifyName("Server (Production)", "get_status");
      expect(result).toBe(
        `server_production${MCP_SERVER_TOOL_NAME_SEPARATOR}get_status`,
      );
    });

    test("removes special characters while preserving hyphens", () => {
      const result = ToolModel.slugifyName("my-server!@#$%", "tool-name");
      expect(result).toBe(
        `my-server${MCP_SERVER_TOOL_NAME_SEPARATOR}tool-name`,
      );
    });

    test("collapses multiple consecutive spaces into single underscore", () => {
      const result = ToolModel.slugifyName("My   Server", "list    repos");
      // Multiple spaces become a single underscore for cleaner names
      expect(result).toBe(
        `my_server${MCP_SERVER_TOOL_NAME_SEPARATOR}list_repos`,
      );
    });

    test("handles tabs and newlines as whitespace", () => {
      const result = ToolModel.slugifyName("My\tServer", "list\nrepos");
      expect(result).toBe(
        `my_server${MCP_SERVER_TOOL_NAME_SEPARATOR}list_repos`,
      );
    });

    test("preserves numbers in names", () => {
      const result = ToolModel.slugifyName("Server123", "tool456");
      expect(result).toBe(`server123${MCP_SERVER_TOOL_NAME_SEPARATOR}tool456`);
    });

    test("handles empty tool name", () => {
      const result = ToolModel.slugifyName("server", "");
      expect(result).toBe(`server${MCP_SERVER_TOOL_NAME_SEPARATOR}`);
    });

    test("produces names matching LLM provider pattern", () => {
      // Anthropic pattern: ^[a-zA-Z0-9_-]{1,128}$
      const pattern = /^[a-zA-Z0-9_-]+$/;

      const testCases = [
        ["[AI SRE Demo] Kubernetes MCP Server", "list_namespaces"],
        ["Server (v2.0)", "get_data"],
        ["My Server!", "tool@name"],
        ["Test & Demo", "run#test"],
        ["Unicode: 日本語", "tool"],
      ];

      for (const [serverName, toolName] of testCases) {
        const result = ToolModel.slugifyName(serverName, toolName);
        expect(result).toMatch(pattern);
      }
    });
  });

  describe("unslugifyName", () => {
    test("extracts tool name from slugified name", () => {
      const slugified = `server${MCP_SERVER_TOOL_NAME_SEPARATOR}list_repos`;
      const result = ToolModel.unslugifyName(slugified);
      expect(result).toBe("list_repos");
    });

    test("handles tool names containing separator", () => {
      const slugified = `server${MCP_SERVER_TOOL_NAME_SEPARATOR}tool${MCP_SERVER_TOOL_NAME_SEPARATOR}name`;
      const result = ToolModel.unslugifyName(slugified);
      expect(result).toBe(`tool${MCP_SERVER_TOOL_NAME_SEPARATOR}name`);
    });

    test("returns original name if no separator found", () => {
      const result = ToolModel.unslugifyName("simple_tool_name");
      expect(result).toBe("simple_tool_name");
    });

    test("handles empty string after separator", () => {
      const slugified = `server${MCP_SERVER_TOOL_NAME_SEPARATOR}`;
      const result = ToolModel.unslugifyName(slugified);
      expect(result).toBe("");
    });
  });

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
      // Expects exactly 2 proxy-discovered tools (Archestra tools are no longer auto-assigned)
      expect(tools.length).toBe(2);
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
        useDynamicTeamCredential: false,
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

  describe("assignArchestraToolsToAgent", () => {
    test("assigns Archestra built-in tools to agent in bulk", async ({
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      const agent = await makeAgent();

      // Agents should NOT have Archestra tools auto-assigned (they must be explicitly assigned)
      const toolIdsBeforeAssign = await AgentToolModel.findToolIdsByAgent(
        agent.id,
      );
      expect(toolIdsBeforeAssign.length).toBe(0);

      // Explicitly assign Archestra tools
      await seedAndAssignArchestraTools(agent.id);

      // Verify Archestra tools are assigned after explicit assignment
      const mcpTools = await ToolModel.getMcpToolsByAgent(agent.id);
      const archestraToolNames = mcpTools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("archestra__"));

      expect(archestraToolNames.length).toBeGreaterThan(0);
      expect(archestraToolNames).toContain("archestra__whoami");
    });

    test("is idempotent - does not create duplicates", async ({
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      const agent = await makeAgent();

      await seedAndAssignArchestraTools(agent.id);
      const toolIdsAfterFirst = await AgentToolModel.findToolIdsByAgent(
        agent.id,
      );

      await seedAndAssignArchestraTools(agent.id);
      const toolIdsAfterSecond = await AgentToolModel.findToolIdsByAgent(
        agent.id,
      );

      expect(toolIdsAfterSecond.length).toBe(toolIdsAfterFirst.length);
    });
  });

  describe("findByMcpServerId", () => {
    test("returns tools with assigned agents efficiently", async ({
      makeUser,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });

      const catalogItem = await makeInternalMcpCatalog({
        name: "test-catalog",
        serverUrl: "https://api.test.com/mcp/",
      });

      const mcpServer = await makeMcpServer({
        name: "test-server",
        catalogId: catalogItem.id,
        ownerId: user.id,
      });

      const tool1 = await makeTool({
        name: "tool1",
        description: "Tool 1",
        parameters: {},
        catalogId: catalogItem.id,
        mcpServerId: mcpServer.id,
      });

      const tool2 = await makeTool({
        name: "tool2",
        description: "Tool 2",
        parameters: {},
        catalogId: catalogItem.id,
        mcpServerId: mcpServer.id,
      });

      // Assign tools to agents
      await AgentToolModel.create(agent1.id, tool1.id);
      await AgentToolModel.create(agent1.id, tool2.id);
      await AgentToolModel.create(agent2.id, tool1.id);

      const result = await ToolModel.findByMcpServerId(mcpServer.id);

      expect(result).toHaveLength(2);

      const tool1Result = result.find((t) => t.name === "tool1");
      expect(tool1Result?.assignedAgentCount).toBe(2);
      expect(tool1Result?.assignedAgents.map((a) => a.id)).toContain(agent1.id);
      expect(tool1Result?.assignedAgents.map((a) => a.id)).toContain(agent2.id);

      const tool2Result = result.find((t) => t.name === "tool2");
      expect(tool2Result?.assignedAgentCount).toBe(1);
      expect(tool2Result?.assignedAgents.map((a) => a.id)).toContain(agent1.id);
    });

    test("returns empty array when MCP server has no tools", async ({
      makeUser,
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const user = await makeUser();
      const catalogItem = await makeInternalMcpCatalog({
        name: "empty-catalog",
        serverUrl: "https://api.empty.com/mcp/",
      });

      const mcpServer = await makeMcpServer({
        name: "empty-server",
        catalogId: catalogItem.id,
        ownerId: user.id,
      });

      const result = await ToolModel.findByMcpServerId(mcpServer.id);
      expect(result).toHaveLength(0);
    });
  });

  describe("findByCatalogId", () => {
    test("returns tools with assigned agents for catalog efficiently", async ({
      makeUser,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const user = await makeUser();
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });

      const catalogItem = await makeInternalMcpCatalog({
        name: "shared-catalog",
        serverUrl: "https://api.shared.com/mcp/",
      });

      // Create two servers with the same catalog
      const mcpServer1 = await makeMcpServer({
        name: "server1",
        catalogId: catalogItem.id,
        ownerId: user.id,
      });

      const mcpServer2 = await makeMcpServer({
        name: "server2",
        catalogId: catalogItem.id,
        ownerId: user.id,
      });

      // Create tools for both servers (same catalog)
      const tool1 = await makeTool({
        name: "shared_tool",
        description: "Shared Tool",
        parameters: {},
        catalogId: catalogItem.id,
        mcpServerId: mcpServer1.id,
      });

      const tool2 = await makeTool({
        name: "another_tool",
        description: "Another Tool",
        parameters: {},
        catalogId: catalogItem.id,
        mcpServerId: mcpServer2.id,
      });

      // Assign tools to agents
      await AgentToolModel.create(agent1.id, tool1.id);
      await AgentToolModel.create(agent2.id, tool1.id);
      await AgentToolModel.create(agent1.id, tool2.id);

      const result = await ToolModel.findByCatalogId(catalogItem.id);

      expect(result).toHaveLength(2);

      const sharedToolResult = result.find((t) => t.name === "shared_tool");
      expect(sharedToolResult?.assignedAgentCount).toBe(2);
      expect(sharedToolResult?.assignedAgents.map((a) => a.id)).toContain(
        agent1.id,
      );
      expect(sharedToolResult?.assignedAgents.map((a) => a.id)).toContain(
        agent2.id,
      );

      const anotherToolResult = result.find((t) => t.name === "another_tool");
      expect(anotherToolResult?.assignedAgentCount).toBe(1);
      expect(anotherToolResult?.assignedAgents.map((a) => a.id)).toContain(
        agent1.id,
      );
    });

    test("returns empty array when catalog has no tools", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalogItem = await makeInternalMcpCatalog({
        name: "empty-catalog",
        serverUrl: "https://api.empty.com/mcp/",
      });

      const result = await ToolModel.findByCatalogId(catalogItem.id);
      expect(result).toHaveLength(0);
    });
  });

  describe("bulkCreateToolsIfNotExists", () => {
    test("creates multiple tools for an MCP server in bulk", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const mcpServer = await makeMcpServer({
        catalogId: catalog.id,
      });

      const toolsToCreate = [
        {
          name: "tool-1",
          description: "First tool",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
          mcpServerId: mcpServer.id,
        },
        {
          name: "tool-2",
          description: "Second tool",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
          mcpServerId: mcpServer.id,
        },
        {
          name: "tool-3",
          description: "Third tool",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
          mcpServerId: mcpServer.id,
        },
      ];

      const createdTools =
        await ToolModel.bulkCreateToolsIfNotExists(toolsToCreate);

      expect(createdTools).toHaveLength(3);
      expect(createdTools.map((t) => t.name)).toContain("tool-1");
      expect(createdTools.map((t) => t.name)).toContain("tool-2");
      expect(createdTools.map((t) => t.name)).toContain("tool-3");

      // Verify all tools have correct catalogId and mcpServerId
      createdTools.forEach((tool) => {
        expect(tool.catalogId).toBe(catalog.id);
        expect(tool.mcpServerId).toBe(mcpServer.id);
        expect(tool.agentId).toBeNull();
      });
    });

    test("returns existing tools when some tools already exist", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const mcpServer = await makeMcpServer({
        catalogId: catalog.id,
      });

      // Create one tool manually
      const existingTool = await makeTool({
        name: "tool-1",
        catalogId: catalog.id,
        mcpServerId: mcpServer.id,
      });

      const toolsToCreate = [
        {
          name: "tool-1", // Already exists
          description: "First tool",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
          mcpServerId: mcpServer.id,
        },
        {
          name: "tool-2", // New
          description: "Second tool",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
          mcpServerId: mcpServer.id,
        },
        {
          name: "tool-3", // New
          description: "Third tool",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
          mcpServerId: mcpServer.id,
        },
      ];

      const createdTools =
        await ToolModel.bulkCreateToolsIfNotExists(toolsToCreate);

      expect(createdTools).toHaveLength(3);
      // Should return the existing tool
      expect(createdTools.find((t) => t.id === existingTool.id)).toBeDefined();
      // Should create new tools
      expect(createdTools.map((t) => t.name)).toContain("tool-2");
      expect(createdTools.map((t) => t.name)).toContain("tool-3");
    });

    test("maintains input order in returned tools", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const mcpServer = await makeMcpServer({
        catalogId: catalog.id,
      });

      const toolsToCreate = [
        {
          name: "tool-c",
          description: "Tool C",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
          mcpServerId: mcpServer.id,
        },
        {
          name: "tool-a",
          description: "Tool A",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
          mcpServerId: mcpServer.id,
        },
        {
          name: "tool-b",
          description: "Tool B",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
          mcpServerId: mcpServer.id,
        },
      ];

      const createdTools =
        await ToolModel.bulkCreateToolsIfNotExists(toolsToCreate);

      expect(createdTools).toHaveLength(3);
      // Should maintain input order
      expect(createdTools[0].name).toBe("tool-c");
      expect(createdTools[1].name).toBe("tool-a");
      expect(createdTools[2].name).toBe("tool-b");
    });

    test("handles empty tools array", async () => {
      const createdTools = await ToolModel.bulkCreateToolsIfNotExists([]);
      expect(createdTools).toHaveLength(0);
    });

    test("handles conflict during insert and fetches existing tools", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const mcpServer = await makeMcpServer({
        catalogId: catalog.id,
      });

      const toolsToCreate = [
        {
          name: "conflict-tool",
          description: "Tool that might conflict",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
          mcpServerId: mcpServer.id,
        },
      ];

      // Create tools in parallel to simulate race condition
      const [result1, result2] = await Promise.all([
        ToolModel.bulkCreateToolsIfNotExists(toolsToCreate),
        ToolModel.bulkCreateToolsIfNotExists(toolsToCreate),
      ]);

      // Both should return the same tool (one created, one fetched)
      expect(result1).toHaveLength(1);
      expect(result2).toHaveLength(1);
      expect(result1[0].name).toBe("conflict-tool");
      expect(result2[0].name).toBe("conflict-tool");
    });
  });

  describe("bulkCreateProxyToolsIfNotExists", () => {
    test("creates multiple proxy-sniffed tools for an agent in bulk", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const toolsToCreate = [
        {
          name: "proxy-tool-1",
          description: "First proxy tool",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "proxy-tool-2",
          description: "Second proxy tool",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "proxy-tool-3",
          description: "Third proxy tool",
          parameters: { type: "object", properties: {} },
        },
      ];

      const createdTools = await ToolModel.bulkCreateProxyToolsIfNotExists(
        toolsToCreate,
        agent.id,
      );

      expect(createdTools).toHaveLength(3);
      expect(createdTools.map((t) => t.name)).toContain("proxy-tool-1");
      expect(createdTools.map((t) => t.name)).toContain("proxy-tool-2");
      expect(createdTools.map((t) => t.name)).toContain("proxy-tool-3");

      // Verify all tools have correct agentId and null catalogId
      for (const tool of createdTools) {
        expect(tool.agentId).toBe(agent.id);
        expect(tool.catalogId).toBeNull();
        expect(tool.mcpServerId).toBeNull();
      }
    });

    test("returns existing tools when some tools already exist", async ({
      makeAgent,
      makeTool,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      // Create one tool manually
      const existingTool = await makeTool({
        name: "proxy-tool-1",
        agentId: agent.id,
        description: "Existing tool",
      });

      const toolsToCreate = [
        {
          name: "proxy-tool-1", // Already exists
          description: "First proxy tool (updated)",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "proxy-tool-2",
          description: "Second proxy tool",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "proxy-tool-3",
          description: "Third proxy tool",
          parameters: { type: "object", properties: {} },
        },
      ];

      const createdTools = await ToolModel.bulkCreateProxyToolsIfNotExists(
        toolsToCreate,
        agent.id,
      );

      expect(createdTools).toHaveLength(3);
      // Should return the existing tool
      expect(createdTools.find((t) => t.id === existingTool.id)).toBeDefined();
      // Should create new tools
      expect(createdTools.map((t) => t.name)).toContain("proxy-tool-2");
      expect(createdTools.map((t) => t.name)).toContain("proxy-tool-3");
    });

    test("maintains input order in returned tools", async ({ makeAgent }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const toolsToCreate = [
        {
          name: "proxy-tool-c",
          description: "Tool C",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "proxy-tool-a",
          description: "Tool A",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "proxy-tool-b",
          description: "Tool B",
          parameters: { type: "object", properties: {} },
        },
      ];

      const createdTools = await ToolModel.bulkCreateProxyToolsIfNotExists(
        toolsToCreate,
        agent.id,
      );

      expect(createdTools).toHaveLength(3);
      // Should maintain input order
      expect(createdTools[0].name).toBe("proxy-tool-c");
      expect(createdTools[1].name).toBe("proxy-tool-a");
      expect(createdTools[2].name).toBe("proxy-tool-b");
    });

    test("handles empty tools array", async ({ makeAgent }) => {
      const agent = await makeAgent({ name: "Test Agent" });
      const createdTools = await ToolModel.bulkCreateProxyToolsIfNotExists(
        [],
        agent.id,
      );
      expect(createdTools).toHaveLength(0);
    });

    test("handles conflict during insert and fetches existing tools", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const toolsToCreate = [
        {
          name: "conflict-proxy-tool",
          description: "Tool that might conflict",
          parameters: { type: "object", properties: {} },
        },
      ];

      // Create tools in parallel to simulate race condition
      const [result1, result2] = await Promise.all([
        ToolModel.bulkCreateProxyToolsIfNotExists(toolsToCreate, agent.id),
        ToolModel.bulkCreateProxyToolsIfNotExists(toolsToCreate, agent.id),
      ]);

      // Both should return the same tool (one created, one fetched)
      expect(result1).toHaveLength(1);
      expect(result2).toHaveLength(1);
      expect(result1[0].name).toBe("conflict-proxy-tool");
      expect(result2[0].name).toBe("conflict-proxy-tool");
    });

    test("does not mix tools between different agents", async ({
      makeAgent,
    }) => {
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });

      // Create same-named tool for agent1
      await ToolModel.bulkCreateProxyToolsIfNotExists(
        [{ name: "shared-name-tool", description: "Tool for agent 1" }],
        agent1.id,
      );

      // Create same-named tool for agent2
      const result = await ToolModel.bulkCreateProxyToolsIfNotExists(
        [{ name: "shared-name-tool", description: "Tool for agent 2" }],
        agent2.id,
      );

      // Should create a new tool for agent2 (not return agent1's tool)
      expect(result).toHaveLength(1);
      expect(result[0].agentId).toBe(agent2.id);
      expect(result[0].name).toBe("shared-name-tool");
    });

    test("handles tools with optional parameters", async ({ makeAgent }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const toolsToCreate = [
        {
          name: "tool-with-all-fields",
          description: "Has description",
          parameters: { type: "object" },
        },
        {
          name: "tool-without-description",
          // No description
        },
        {
          name: "tool-without-parameters",
          description: "Has description but no parameters",
          // No parameters
        },
      ];

      const createdTools = await ToolModel.bulkCreateProxyToolsIfNotExists(
        toolsToCreate,
        agent.id,
      );

      expect(createdTools).toHaveLength(3);

      const toolWithAll = createdTools.find(
        (t) => t.name === "tool-with-all-fields",
      );
      expect(toolWithAll?.description).toBe("Has description");
      expect(toolWithAll?.parameters).toEqual({ type: "object" });

      const toolWithoutDesc = createdTools.find(
        (t) => t.name === "tool-without-description",
      );
      expect(toolWithoutDesc?.description).toBeNull();

      const toolWithoutParams = createdTools.find(
        (t) => t.name === "tool-without-parameters",
      );
      expect(toolWithoutParams?.description).toBe(
        "Has description but no parameters",
      );
    });
  });
});
