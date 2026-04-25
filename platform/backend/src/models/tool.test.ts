import { randomUUID } from "node:crypto";
import {
  ARCHESTRA_MCP_CATALOG_ID,
  getArchestraMcpCatalogName,
  getArchestraToolFullName,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_ARTIFACT_WRITE_FULL_NAME,
  TOOL_ARTIFACT_WRITE_SHORT_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
  TOOL_TODO_WRITE_SHORT_NAME,
} from "@shared";
import { and, eq } from "drizzle-orm";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { getArchestraMcpCatalogMetadata } from "@/archestra-mcp-server/metadata";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import AgentToolModel from "./agent-tool";
import OrganizationModel from "./organization";
import TeamModel from "./team";
import ToolModel, { parseArchestraBuiltInName } from "./tool";

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

    test("handles server names containing separator (e.g. upstash__context7)", () => {
      const result = ToolModel.unslugifyName(
        "upstash__context7__resolve-library-id",
      );
      expect(result).toBe("resolve-library-id");
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
      makeAgentTool,
    }) => {
      const admin = await makeAdmin();
      const agent1 = await makeAgent({ name: "Agent1" });
      const agent2 = await makeAgent({ name: "Agent2" });

      const tool1 = await makeTool({
        name: "tool1",
        description: "Tool 1",
      });
      await makeAgentTool(agent1.id, tool1.id);

      const tool2 = await makeTool({
        name: "tool2",
        description: "Tool 2",
        parameters: {},
      });
      await makeAgentTool(agent2.id, tool2.id);

      const tools = await ToolModel.findAll(admin.id, true);
      // Expects exactly 2 proxy-discovered tools (Archestra tools are no longer auto-assigned)
      expect(tools.length).toBe(2);
    });

    test("non-admin only sees MCP tools, not proxy tools", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
      makeAgent,
      makeTool,
      makeAgentTool,
      makeInternalMcpCatalog,
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

      const catalog = await makeInternalMcpCatalog();

      // Proxy tools (no catalogId) — not visible to non-admins
      const proxyTool1 = await makeTool({
        name: "tool1",
        description: "Tool 1",
        parameters: {},
      });
      await makeAgentTool(agent1.id, proxyTool1.id);

      const proxyTool2 = await makeTool({
        name: "tool2",
        description: "Tool 2",
        parameters: {},
      });
      await makeAgentTool(agent2.id, proxyTool2.id);

      // MCP tool (catalogId set) — visible to non-admins
      const mcpTool = await makeTool({
        name: "mcp-tool",
        description: "MCP Tool",
        catalogId: catalog.id,
      });
      await makeAgentTool(agent1.id, mcpTool.id);

      // Non-admin user only sees MCP tools, not proxy tools
      const tools = await ToolModel.findAll(user1.id, false);
      expect(tools).toHaveLength(1);
      expect(tools[0].id).toBe(mcpTool.id);
    });

    test("member with no access sees only MCP tools", async ({
      makeUser,
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const user = await makeUser();
      const agent1 = await makeAgent({ name: "Agent1" });

      // Proxy tool — not visible to non-admins
      const tool1 = await makeTool({
        name: "tool1",
        description: "Tool 1",
      });
      await makeAgentTool(agent1.id, tool1.id);

      const tools = await ToolModel.findAll(user.id, false);
      expect(tools).toHaveLength(0);
    });

    test("findById returns tool for admin", async ({
      makeAdmin,
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const admin = await makeAdmin();
      const agent = await makeAgent();

      const tool = await makeTool({
        name: "test-tool",
        description: "Test Tool",
        parameters: {},
      });
      await makeAgentTool(agent.id, tool.id);

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
      makeAgentTool,
    }) => {
      const user = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      // Create team and add user
      const team = await makeTeam(org.id, admin.id);
      await TeamModel.addMember(team.id, user.id);

      const agent = await makeAgent({ teams: [team.id] });

      const tool = await makeTool({
        name: "test-tool",
        description: "Test Tool",
        parameters: {},
      });
      await makeAgentTool(agent.id, tool.id);

      // Proxy tools with agentId=null are visible to all (same as MCP tools)
      const found = await ToolModel.findById(tool.id, user.id, false);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(tool.id);
    });

    test("findByName returns tool for admin", async ({
      makeAdmin,
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const admin = await makeAdmin();
      const agent = await makeAgent();

      const tool = await makeTool({
        name: "unique-tool",
        description: "Unique Tool",
        parameters: {},
      });
      await makeAgentTool(agent.id, tool.id);

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
      makeAgentTool,
    }) => {
      const user = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      // Create team and add user
      const team = await makeTeam(org.id, admin.id);
      await TeamModel.addMember(team.id, user.id);

      const agent = await makeAgent({ teams: [team.id] });

      const tool = await makeTool({
        name: "user-tool",
        description: "User Tool",
        parameters: {},
      });
      await makeAgentTool(agent.id, tool.id);

      const found = await ToolModel.findByName("user-tool", user.id, false);
      expect(found).not.toBeNull();
      expect(found?.name).toBe("user-tool");
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
      makeAgentTool,
    }) => {
      const _user = await makeUser();
      const agent = await makeAgent();

      // Create a proxy-sniffed tool (no catalogId) and assign via junction
      const proxyTool = await makeTool({
        name: "proxy_tool",
        description: "Proxy Tool",
        parameters: {},
      });
      await makeAgentTool(agent.id, proxyTool.id);

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
      await makeMcpServer({
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
        mcpServerId: null,
        catalogId: catalogItem.id,
        catalogName: "github-mcp-server",
        credentialResolutionMode: "static",
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
      await makeMcpServer({
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
      });

      const tool2 = await makeTool({
        name: "tool_two",
        description: "Second tool",
        parameters: {},
        catalogId: catalogItem.id,
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
      await makeMcpServer({
        name: "test-server",
        catalogId: catalogItem.id,
        ownerId: user.id,
      });

      const mcpTool = await makeTool({
        name: "exclusive_tool",
        description: "Exclusive tool",
        parameters: {},
        catalogId: catalogItem.id,
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

    test("excludes proxy-sniffed tools (tools without catalogId)", async ({
      makeUser,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
      makeAgentTool,
    }) => {
      const user = await makeUser();
      const agent = await makeAgent();

      // Create an MCP server
      const catalogItem = await makeInternalMcpCatalog({
        name: "github-mcp-server",
        serverUrl: "https://api.githubcopilot.com/mcp/",
      });
      await makeMcpServer({
        name: "test-server",
        catalogId: catalogItem.id,
        ownerId: user.id,
      });

      // Create a shared proxy tool (agentId=null, catalogId=null)
      const proxyTool = await makeTool({
        name: "proxy_tool",
        description: "Proxy Tool",
        parameters: {},
      });
      await makeAgentTool(agent.id, proxyTool.id);

      // Create an MCP tool (linked via catalogId)
      const mcpTool = await makeTool({
        name: "mcp_tool",
        description: "MCP Tool",
        parameters: {},
        catalogId: catalogItem.id,
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
      await makeMcpServer({
        name: "github-server",
        catalogId: catalogItem.id,
        ownerId: user.id,
      });

      const catalogItem2 = await makeInternalMcpCatalog({
        name: "other-mcp-server",
        serverUrl: "https://api.othercopilot.com/mcp/",
      });
      await makeMcpServer({
        name: "other-server",
        catalogId: catalogItem2.id,
      });

      // Create tools for each server
      const githubTool = await makeTool({
        name: "github_list_issues",
        description: "List GitHub issues",
        parameters: {},
        catalogId: catalogItem.id,
      });

      const otherTool = await makeTool({
        name: "other_tool",
        description: "Other tool",
        parameters: {},
        catalogId: catalogItem2.id,
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

  describe("findByNameForAgent", () => {
    test("returns tool when assigned to the agent", async ({
      makeAgent,
      makeTool,
      makeInternalMcpCatalog,
    }) => {
      const agent = await makeAgent();
      const catalogItem = await makeInternalMcpCatalog({
        name: "test-catalog",
        serverUrl: "https://example.com/mcp/",
      });

      const tool = await makeTool({
        name: "my_tool",
        description: "A test tool",
        parameters: { type: "object", properties: {} },
        catalogId: catalogItem.id,
      });

      await AgentToolModel.create(agent.id, tool.id);

      const result = await ToolModel.findByNameForAgent("my_tool", agent.id);

      expect(result).toEqual(
        expect.objectContaining({ id: tool.id, name: "my_tool" }),
      );
    });

    test("returns null when tool exists but is not assigned to the agent", async ({
      makeAgent,
      makeTool,
      makeInternalMcpCatalog,
    }) => {
      const agent = await makeAgent();
      const catalogItem = await makeInternalMcpCatalog({
        name: "test-catalog",
        serverUrl: "https://example.com/mcp/",
      });

      await makeTool({
        name: "unassigned_tool",
        description: "Not assigned",
        parameters: {},
        catalogId: catalogItem.id,
      });

      const result = await ToolModel.findByNameForAgent(
        "unassigned_tool",
        agent.id,
      );

      expect(result).toBeNull();
    });

    test("returns null when tool does not exist", async ({ makeAgent }) => {
      const agent = await makeAgent();

      const result = await ToolModel.findByNameForAgent(
        "nonexistent_tool",
        agent.id,
      );

      expect(result).toBeNull();
    });

    test("scopes to the correct agent", async ({
      makeAgent,
      makeTool,
      makeInternalMcpCatalog,
    }) => {
      const agent1 = await makeAgent({ name: "Agent1" });
      const agent2 = await makeAgent({ name: "Agent2" });
      const catalogItem = await makeInternalMcpCatalog({
        name: "test-catalog",
        serverUrl: "https://example.com/mcp/",
      });

      const tool = await makeTool({
        name: "scoped_tool",
        description: "Scoped tool",
        parameters: {},
        catalogId: catalogItem.id,
      });

      // Assign only to agent1
      await AgentToolModel.create(agent1.id, tool.id);

      const result1 = await ToolModel.findByNameForAgent(
        "scoped_tool",
        agent1.id,
      );
      const result2 = await ToolModel.findByNameForAgent(
        "scoped_tool",
        agent2.id,
      );

      expect(result1).toEqual(
        expect.objectContaining({ id: tool.id, name: "scoped_tool" }),
      );
      expect(result2).toBeNull();
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
      await makeMcpServer({
        name: "server1",
        catalogId: catalogItem.id,
        ownerId: user.id,
      });

      await makeMcpServer({
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
      });

      const tool2 = await makeTool({
        name: "another_tool",
        description: "Another Tool",
        parameters: {},
        catalogId: catalogItem.id,
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
      await makeMcpServer({
        catalogId: catalog.id,
      });

      const toolsToCreate = [
        {
          name: "tool-1",
          description: "First tool",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
        },
        {
          name: "tool-2",
          description: "Second tool",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
        },
        {
          name: "tool-3",
          description: "Third tool",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
        },
      ];

      const createdTools =
        await ToolModel.bulkCreateToolsIfNotExists(toolsToCreate);

      expect(createdTools).toHaveLength(3);
      expect(createdTools.map((t) => t.name)).toContain("tool-1");
      expect(createdTools.map((t) => t.name)).toContain("tool-2");
      expect(createdTools.map((t) => t.name)).toContain("tool-3");

      // Verify all tools have correct catalogId
      createdTools.forEach((tool) => {
        expect(tool.catalogId).toBe(catalog.id);
        expect(tool.agentId).toBeNull();
      });
    });

    test("returns existing tools when some tools already exist", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      await makeMcpServer({
        catalogId: catalog.id,
      });

      // Create one tool manually
      const existingTool = await makeTool({
        name: "tool-1",
        catalogId: catalog.id,
      });

      const toolsToCreate = [
        {
          name: "tool-1", // Already exists
          description: "First tool",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
        },
        {
          name: "tool-2", // New
          description: "Second tool",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
        },
        {
          name: "tool-3", // New
          description: "Third tool",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
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
      await makeMcpServer({
        catalogId: catalog.id,
      });

      const toolsToCreate = [
        {
          name: "tool-c",
          description: "Tool C",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
        },
        {
          name: "tool-a",
          description: "Tool A",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
        },
        {
          name: "tool-b",
          description: "Tool B",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
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
      await makeMcpServer({
        catalogId: catalog.id,
      });

      const toolsToCreate = [
        {
          name: "conflict-tool",
          description: "Tool that might conflict",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
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

    test("upgrades proxy-discovered tools by setting catalogId (same tool IDs, no duplicates)", async ({
      makeInternalMcpCatalog,
      makeTool,
      makeAgent,
      makeAgentTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const agent = await makeAgent();

      // Create proxy-discovered tools (catalogId=NULL)
      const proxyTool1 = await makeTool({
        name: "proxy-upgrade-1",
        description: "Proxy tool 1",
      });
      const proxyTool2 = await makeTool({
        name: "proxy-upgrade-2",
        description: "Proxy tool 2",
      });

      // Assign proxy tools to agent (simulating proxy discovery)
      await makeAgentTool(agent.id, proxyTool1.id);
      await makeAgentTool(agent.id, proxyTool2.id);

      // Now bulk-create the same tools as MCP tools (simulating MCP server install)
      const result = await ToolModel.bulkCreateToolsIfNotExists([
        {
          name: "proxy-upgrade-1",
          description: "MCP tool 1",
          parameters: {},
          catalogId: catalog.id,
        },
        {
          name: "proxy-upgrade-2",
          description: "MCP tool 2",
          parameters: {},
          catalogId: catalog.id,
        },
      ]);

      // Should return the same tool IDs (upgraded, not duplicated)
      expect(result).toHaveLength(2);
      expect(result.find((t) => t.name === "proxy-upgrade-1")?.id).toBe(
        proxyTool1.id,
      );
      expect(result.find((t) => t.name === "proxy-upgrade-2")?.id).toBe(
        proxyTool2.id,
      );

      // Tools should now have the catalogId set
      for (const tool of result) {
        expect(tool.catalogId).toBe(catalog.id);
      }

      // Agent-tool links should still be intact
      const agentToolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
      expect(agentToolIds).toContain(proxyTool1.id);
      expect(agentToolIds).toContain(proxyTool2.id);
    });

    test("handles mix of proxy tools and genuinely new tools", async ({
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();

      // Create one proxy-discovered tool
      const proxyTool = await makeTool({
        name: "mixed-proxy-tool",
        description: "Proxy tool",
      });

      // Bulk-create with one proxy tool and one genuinely new tool
      const result = await ToolModel.bulkCreateToolsIfNotExists([
        {
          name: "mixed-proxy-tool",
          description: "MCP tool (was proxy)",
          parameters: {},
          catalogId: catalog.id,
        },
        {
          name: "mixed-new-tool",
          description: "Brand new MCP tool",
          parameters: {},
          catalogId: catalog.id,
        },
      ]);

      expect(result).toHaveLength(2);

      // Proxy tool should be upgraded (same ID)
      const upgradedTool = result.find((t) => t.name === "mixed-proxy-tool");
      expect(upgradedTool?.id).toBe(proxyTool.id);
      expect(upgradedTool?.catalogId).toBe(catalog.id);

      // New tool should be created
      const newTool = result.find((t) => t.name === "mixed-new-tool");
      expect(newTool).toBeDefined();
      expect(newTool?.catalogId).toBe(catalog.id);
    });

    test("does not touch tools that already have a different catalogId", async ({
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const catalog1 = await makeInternalMcpCatalog({ name: "Catalog 1" });
      const catalog2 = await makeInternalMcpCatalog({ name: "Catalog 2" });

      // Create a tool that already belongs to catalog1
      const existingTool = await makeTool({
        name: "already-owned-tool",
        description: "Owned by catalog1",
        catalogId: catalog1.id,
      });

      // Try to bulk-create same-named tool for catalog2
      const result = await ToolModel.bulkCreateToolsIfNotExists([
        {
          name: "already-owned-tool",
          description: "Should not steal from catalog1",
          parameters: {},
          catalogId: catalog2.id,
        },
      ]);

      // Should create a new tool for catalog2 (not upgrade catalog1's tool)
      // The proxy upgrade only targets catalogId=NULL tools
      expect(result).toHaveLength(1);
      // The original tool should still belong to catalog1
      const originalTool = await ToolModel.findById(existingTool.id);
      expect(originalTool?.catalogId).toBe(catalog1.id);
    });
  });

  describe("createToolIfNotExists - proxy to MCP upgrade", () => {
    test("upgrades existing proxy tool when MCP tool with same name is created", async ({
      makeTool,
      makeAgentTool,
      makeAgent,
      makeInternalMcpCatalog,
    }) => {
      const agent = await makeAgent();
      const catalog = await makeInternalMcpCatalog();

      // Create a shared proxy tool and link to agent
      const proxyTool = await makeTool({
        name: "upgradeable-tool",
        description: "Proxy description",
        parameters: { type: "object" },
      });
      await makeAgentTool(agent.id, proxyTool.id);

      // Now create an MCP tool with the same name — should upgrade the proxy tool
      const mcpTool = await makeTool({
        name: "upgradeable-tool",
        catalogId: catalog.id,
        description: "MCP description",
      });

      // Same row was reused
      expect(mcpTool.id).toBe(proxyTool.id);
      expect(mcpTool.catalogId).toBe(catalog.id);
      expect(mcpTool.description).toBe("MCP description");

      // Agent-tool link still intact
      const agentTools = await ToolModel.getToolsByAgent(agent.id);
      expect(agentTools.some((t) => t.id === proxyTool.id)).toBe(true);
    });

    test("does not upgrade when MCP tool with same catalog already exists", async ({
      makeTool,
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog();

      // Create MCP tool directly
      const mcpTool = await makeTool({
        name: "existing-mcp-tool",
        catalogId: catalog.id,
        description: "Original MCP",
      });

      // Creating again with same catalog+name returns existing
      const result = await ToolModel.createToolIfNotExists({
        name: "existing-mcp-tool",
        catalogId: catalog.id,
        description: "Duplicate attempt",
        parameters: {},
      });

      expect(result.id).toBe(mcpTool.id);
      expect(result.description).toBe("Original MCP");
    });
  });

  describe("bulkCreateProxyToolsIfNotExists", () => {
    test("creates multiple shared proxy tools in bulk", async ({
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

      // Verify all tools are shared (agentId=null) and have null catalogId
      for (const tool of createdTools) {
        expect(tool.agentId).toBeNull();
        expect(tool.catalogId).toBeNull();
      }
    });

    test("returns existing tools when some tools already exist", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      // Create one shared proxy tool manually and assign to agent
      const existingTool = await makeTool({
        name: "proxy-tool-1",
        description: "Existing tool",
      });
      await makeAgentTool(agent.id, existingTool.id);

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

    test("shares tools between different agents (same tool row reused)", async ({
      makeAgent,
    }) => {
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });

      // Create same-named tool for agent1
      const result1 = await ToolModel.bulkCreateProxyToolsIfNotExists(
        [{ name: "shared-name-tool", description: "Tool for agent 1" }],
        agent1.id,
      );

      // Create same-named tool for agent2
      const result2 = await ToolModel.bulkCreateProxyToolsIfNotExists(
        [{ name: "shared-name-tool", description: "Tool for agent 2" }],
        agent2.id,
      );

      // Both agents should get the SAME shared tool row (agentId=null)
      expect(result1).toHaveLength(1);
      expect(result2).toHaveLength(1);
      expect(result1[0].id).toBe(result2[0].id);
      expect(result1[0].agentId).toBeNull();
      expect(result2[0].agentId).toBeNull();
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

  describe("assignDefaultArchestraToolsToAgent", () => {
    test("assigns all default tools including query_knowledge_sources, but getMcpToolsByAgent filters it out when agent has no knowledge sources", async ({
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      // First seed Archestra tools (but don't assign to agent)
      const tempAgent = await makeAgent({ name: "Temp Agent for Seeding" });
      await seedAndAssignArchestraTools(tempAgent.id);

      // Create a new agent WITHOUT a knowledgeBaseId
      const agent = await makeAgent({ name: "Test Agent" });

      // Assign default tools (always includes query_knowledge_sources now)
      await ToolModel.assignDefaultArchestraToolsToAgent(agent.id);

      // Verify the tool was assigned in the junction table
      const assignedToolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
      expect(assignedToolIds.length).toBeGreaterThanOrEqual(3);

      // But getMcpToolsByAgent filters it out because the agent has no knowledge sources
      const mcpTools = await ToolModel.getMcpToolsByAgent(agent.id);
      const toolNames = mcpTools.map((t) => t.name);

      // Should have artifact_write and todo_write
      expect(toolNames).toContain(TOOL_ARTIFACT_WRITE_FULL_NAME);
      expect(toolNames).toContain(TOOL_TODO_WRITE_FULL_NAME);

      // query_knowledge_sources is filtered out at query time because agent has no knowledge sources
      expect(toolNames).not.toContain(TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME);
    });

    test("includes query_knowledge_sources when agent has a knowledge base assigned", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      seedAndAssignArchestraTools,
    }) => {
      // First seed Archestra tools
      const tempAgent = await makeAgent({ name: "Temp Agent for Seeding" });
      await seedAndAssignArchestraTools(tempAgent.id);

      // Create an organization and knowledge base
      const org = await makeOrganization();
      const kg = await makeKnowledgeBase(org.id);

      // Create a new agent and assign the knowledge base
      const agent = await makeAgent({
        name: "Knowledge Base Enabled Agent",
        organizationId: org.id,
      });
      await db
        .insert(schema.agentKnowledgeBasesTable)
        .values({ agentId: agent.id, knowledgeBaseId: kg.id });

      // Assign default tools
      await ToolModel.assignDefaultArchestraToolsToAgent(agent.id);

      // Get the tools assigned to the agent
      const mcpTools = await ToolModel.getMcpToolsByAgent(agent.id);
      const toolNames = mcpTools.map((t) => t.name);

      // Should have all three default tools including query_knowledge_sources
      expect(toolNames).toContain(TOOL_ARTIFACT_WRITE_FULL_NAME);
      expect(toolNames).toContain(TOOL_TODO_WRITE_FULL_NAME);
      expect(toolNames).toContain(TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME);
    });

    test("is idempotent - does not create duplicates", async ({
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      const tempAgent = await makeAgent({ name: "Temp Agent for Seeding" });
      await seedAndAssignArchestraTools(tempAgent.id);

      const agent = await makeAgent({ name: "Test Agent" });

      await ToolModel.assignDefaultArchestraToolsToAgent(agent.id);
      const toolIdsAfterFirst = await AgentToolModel.findToolIdsByAgent(
        agent.id,
      );

      await ToolModel.assignDefaultArchestraToolsToAgent(agent.id);
      const toolIdsAfterSecond = await AgentToolModel.findToolIdsByAgent(
        agent.id,
      );

      expect(toolIdsAfterSecond.length).toBe(toolIdsAfterFirst.length);
    });

    test("does nothing when tools are not seeded", async ({ makeAgent }) => {
      // Create agent without seeding Archestra tools first
      const agent = await makeAgent({ name: "Agent Without Seeded Tools" });

      // This should not throw, just skip assignment
      await ToolModel.assignDefaultArchestraToolsToAgent(agent.id);

      const toolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
      expect(toolIds).toHaveLength(0);
    });

    test("assigns white-labeled default tools by their branded names", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      await OrganizationModel.patch(org.id, { appName: "Acme Copilot" });
      await ToolModel.syncArchestraBuiltInCatalog({
        organization: { appName: "Acme Copilot", iconLogo: null },
      });

      const agent = await makeAgent({ organizationId: org.id });
      await ToolModel.assignDefaultArchestraToolsToAgent(agent.id);

      const assignedToolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
      const assignedTools = await ToolModel.getByIds(assignedToolIds);

      expect(assignedTools.map((tool) => tool.name).sort()).toEqual(
        (
          [
            TOOL_ARTIFACT_WRITE_SHORT_NAME,
            TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
            TOOL_TODO_WRITE_SHORT_NAME,
          ] as const
        )
          .map((shortName) =>
            getArchestraToolFullName(shortName, {
              appName: "Acme Copilot",
              fullWhiteLabeling: true,
            }),
          )
          .sort(),
      );
    });
  });

  describe("knowledge base tool visibility", () => {
    test("getMcpToolsByAgent excludes query_knowledge_sources when agent has no knowledge base assigned", async ({
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      // Create agent WITHOUT a knowledgeBaseId
      const agent = await makeAgent();
      await seedAndAssignArchestraTools(agent.id);

      const tools = await ToolModel.getMcpToolsByAgent(agent.id);
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).not.toContain(TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME);
      // Other Archestra tools should still be present
      expect(toolNames).toContain(TOOL_ARTIFACT_WRITE_FULL_NAME);
      expect(toolNames).toContain(TOOL_TODO_WRITE_FULL_NAME);
    });

    test("getMcpToolsByAgent includes query_knowledge_sources when agent has a knowledge base assigned", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      seedAndAssignArchestraTools,
    }) => {
      // Create an organization and knowledge base
      const org = await makeOrganization();
      const kg = await makeKnowledgeBase(org.id);

      // Create agent and assign the knowledge base
      const agent = await makeAgent({ organizationId: org.id });
      await db
        .insert(schema.agentKnowledgeBasesTable)
        .values({ agentId: agent.id, knowledgeBaseId: kg.id });

      await seedAndAssignArchestraTools(agent.id);

      const tools = await ToolModel.getMcpToolsByAgent(agent.id);
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain(TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME);
    });

    test("getMcpToolsByAgent includes query_knowledge_sources when agent has a directly-assigned connector", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      seedAndAssignArchestraTools,
    }) => {
      const org = await makeOrganization();
      // Create a KB + connector so the connector exists in the DB
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      // Create agent WITHOUT a knowledge base, but with a direct connector assignment
      const agent = await makeAgent({ organizationId: org.id });
      await db
        .insert(schema.agentConnectorAssignmentsTable)
        .values({ agentId: agent.id, connectorId: connector.id });

      await seedAndAssignArchestraTools(agent.id);

      const tools = await ToolModel.getMcpToolsByAgent(agent.id);
      const toolNames = tools.map((t) => t.name);

      // query_knowledge_sources should be injected for direct connector assignments
      expect(toolNames).toContain(TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME);
      // Other default tools should still be present
      expect(toolNames).toContain(TOOL_ARTIFACT_WRITE_FULL_NAME);
      expect(toolNames).toContain(TOOL_TODO_WRITE_FULL_NAME);
    });

    test("getMcpToolsByAgent excludes query_knowledge_sources when agent has no knowledge base and no direct connectors", async ({
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      // Create agent with neither KB nor direct connector assignments
      const agent = await makeAgent();
      await seedAndAssignArchestraTools(agent.id);

      const tools = await ToolModel.getMcpToolsByAgent(agent.id);
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).not.toContain(TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME);
    });

    test("getMcpToolsByAgent includes query_knowledge_sources when agent has both a knowledge base and a direct connector", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      seedAndAssignArchestraTools,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      // Create agent with BOTH a knowledge base AND a direct connector assignment
      const agent = await makeAgent({ organizationId: org.id });
      await db
        .insert(schema.agentKnowledgeBasesTable)
        .values({ agentId: agent.id, knowledgeBaseId: kb.id });
      await db
        .insert(schema.agentConnectorAssignmentsTable)
        .values({ agentId: agent.id, connectorId: connector.id });

      await seedAndAssignArchestraTools(agent.id);

      const tools = await ToolModel.getMcpToolsByAgent(agent.id);
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain(TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME);
      // Should not have duplicates
      const kbToolCount = toolNames.filter(
        (n) => n === TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
      ).length;
      expect(kbToolCount).toBe(1);
    });

    test("getMcpToolsByAgent includes query_knowledge_sources with multiple direct connectors", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      seedAndAssignArchestraTools,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb.id, org.id, {
        connectorType: "jira",
      });
      const connector2 = await makeKnowledgeBaseConnector(kb.id, org.id, {
        connectorType: "confluence",
      });

      // Agent with multiple direct connectors, no KB assignment
      const agent = await makeAgent({ organizationId: org.id });
      await db.insert(schema.agentConnectorAssignmentsTable).values([
        { agentId: agent.id, connectorId: connector1.id },
        { agentId: agent.id, connectorId: connector2.id },
      ]);

      await seedAndAssignArchestraTools(agent.id);

      const tools = await ToolModel.getMcpToolsByAgent(agent.id);
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain(TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME);
    });

    test("getMcpToolsByAgent auto-injects query_knowledge_sources even with no other tools assigned", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      seedAndAssignArchestraTools,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      // Seed the archestra tools (so query_knowledge_sources exists in DB)
      // but do NOT assign them to the agent
      const tempAgent = await makeAgent({ name: "Temp Agent for Seeding" });
      await seedAndAssignArchestraTools(tempAgent.id);

      // Agent with a direct connector but NO tools assigned
      const agent = await makeAgent({ organizationId: org.id });
      await db
        .insert(schema.agentConnectorAssignmentsTable)
        .values({ agentId: agent.id, connectorId: connector.id });

      const tools = await ToolModel.getMcpToolsByAgent(agent.id);
      const toolNames = tools.map((t) => t.name);

      // query_knowledge_sources should still be auto-injected
      expect(toolNames).toContain(TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME);
      // No other tools should be present since none were assigned
      expect(toolNames).toHaveLength(1);
    });

    test("getMcpToolsByAgent removes query_knowledge_sources after connector unassignment", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      seedAndAssignArchestraTools,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const agent = await makeAgent({ organizationId: org.id });
      await db
        .insert(schema.agentConnectorAssignmentsTable)
        .values({ agentId: agent.id, connectorId: connector.id });
      await seedAndAssignArchestraTools(agent.id);

      // Verify tool is present
      let tools = await ToolModel.getMcpToolsByAgent(agent.id);
      expect(tools.map((t) => t.name)).toContain(
        TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
      );

      // Unassign the connector
      await db
        .delete(schema.agentConnectorAssignmentsTable)
        .where(
          and(
            eq(schema.agentConnectorAssignmentsTable.agentId, agent.id),
            eq(schema.agentConnectorAssignmentsTable.connectorId, connector.id),
          ),
        );

      // Tool should no longer appear
      tools = await ToolModel.getMcpToolsByAgent(agent.id);
      expect(tools.map((t) => t.name)).not.toContain(
        TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
      );
    });

    test("findByCatalogId excludes built-in tools that are not user-assignable", async ({
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      const agent = await makeAgent();
      await seedAndAssignArchestraTools(agent.id);

      const { ARCHESTRA_MCP_CATALOG_ID } = await import("@shared");
      const tools = await ToolModel.findByCatalogId(ARCHESTRA_MCP_CATALOG_ID);
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).not.toContain(TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME);
      expect(toolNames).not.toContain(TOOL_SEARCH_TOOLS_FULL_NAME);
      expect(toolNames).not.toContain(TOOL_RUN_TOOL_FULL_NAME);
      expect(toolNames).toContain(TOOL_ARTIFACT_WRITE_FULL_NAME);
    });

    test("getToolsByAgent and findByCatalogId use branded knowledge-tool filtering after white-label sync", async ({
      makeOrganization,
      makeAgent,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      await OrganizationModel.patch(org.id, { appName: "Acme Copilot" });
      await ToolModel.syncArchestraBuiltInCatalog({
        organization: { appName: "Acme Copilot", iconLogo: null },
      });

      const kb = await makeKnowledgeBase(org.id);
      const agent = await makeAgent({ organizationId: org.id });
      await db
        .insert(schema.agentKnowledgeBasesTable)
        .values({ agentId: agent.id, knowledgeBaseId: kb.id });
      await ToolModel.assignArchestraToolsToAgent(
        agent.id,
        ARCHESTRA_MCP_CATALOG_ID,
      );

      const brandedKbToolName = getArchestraToolFullName(
        TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
        {
          appName: "Acme Copilot",
          fullWhiteLabeling: true,
        },
      );

      const visibleTools = await ToolModel.getToolsByAgent(agent.id);
      const visibleMcpTools = await ToolModel.getMcpToolsByAgent(agent.id);
      const catalogTools = await ToolModel.findByCatalogId(
        ARCHESTRA_MCP_CATALOG_ID,
      );

      expect(visibleTools.map((tool) => tool.name)).not.toContain(
        brandedKbToolName,
      );
      expect(visibleMcpTools.map((tool) => tool.name)).toContain(
        brandedKbToolName,
      );
      expect(catalogTools.map((tool) => tool.name)).not.toContain(
        brandedKbToolName,
      );
    });

    test("assignArchestraToolsToAgent always assigns query_knowledge_sources (filtered at query time)", async ({
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      // Seed tools first (seeding is independent of visibility filtering)
      const tempAgent = await makeAgent({ name: "Temp Agent for Seeding" });
      await seedAndAssignArchestraTools(tempAgent.id);

      // Create a new agent WITHOUT a knowledgeBaseId and assign all Archestra tools
      const agent = await makeAgent({ name: "Test Agent" });
      const { ARCHESTRA_MCP_CATALOG_ID } = await import("@shared");
      await ToolModel.assignArchestraToolsToAgent(
        agent.id,
        ARCHESTRA_MCP_CATALOG_ID,
      );

      // Tool is assigned (in junction table) but filtered out by getMcpToolsByAgent
      // since the agent has no knowledge base assigned
      const tools = await ToolModel.getMcpToolsByAgent(agent.id);
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).not.toContain(TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME);
      expect(toolNames).toContain(TOOL_ARTIFACT_WRITE_FULL_NAME);
    });
  });

  describe("syncToolsForCatalog", () => {
    test("creates new tools when none exist", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      await makeMcpServer({ catalogId: catalog.id });

      const toolsToSync = [
        {
          name: "tool-1",
          description: "First tool",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
        },
        {
          name: "tool-2",
          description: "Second tool",
          parameters: { type: "object", properties: {} },
          catalogId: catalog.id,
        },
      ];

      const result = await ToolModel.syncToolsForCatalog(toolsToSync);

      expect(result.created).toHaveLength(2);
      expect(result.updated).toHaveLength(0);
      expect(result.unchanged).toHaveLength(0);
      expect(result.created.map((t) => t.name)).toContain("tool-1");
      expect(result.created.map((t) => t.name)).toContain("tool-2");
    });

    test("updates existing tools when description changes", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      await makeMcpServer({ catalogId: catalog.id });

      // Create existing tool
      const existingTool = await makeTool({
        name: "tool-1",
        description: "Original description",
        parameters: { type: "object" },
        catalogId: catalog.id,
      });

      const toolsToSync = [
        {
          name: "tool-1",
          description: "Updated description",
          parameters: { type: "object" },
          catalogId: catalog.id,
        },
      ];

      const result = await ToolModel.syncToolsForCatalog(toolsToSync);

      expect(result.created).toHaveLength(0);
      expect(result.updated).toHaveLength(1);
      expect(result.unchanged).toHaveLength(0);
      expect(result.updated[0].id).toBe(existingTool.id);
      expect(result.updated[0].description).toBe("Updated description");
    });

    test("updates existing tools when parameters change", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      await makeMcpServer({ catalogId: catalog.id });

      // Create existing tool
      const existingTool = await makeTool({
        name: "tool-1",
        description: "Tool description",
        parameters: { type: "object", properties: { a: { type: "string" } } },
        catalogId: catalog.id,
      });

      const toolsToSync = [
        {
          name: "tool-1",
          description: "Tool description",
          parameters: {
            type: "object",
            properties: { a: { type: "string" }, b: { type: "number" } },
          },
          catalogId: catalog.id,
        },
      ];

      const result = await ToolModel.syncToolsForCatalog(toolsToSync);

      expect(result.created).toHaveLength(0);
      expect(result.updated).toHaveLength(1);
      expect(result.unchanged).toHaveLength(0);
      expect(result.updated[0].id).toBe(existingTool.id);
    });

    test("leaves tools unchanged when nothing changes", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      await makeMcpServer({ catalogId: catalog.id });

      // Create existing tool
      const existingTool = await makeTool({
        name: "tool-1",
        description: "Tool description",
        parameters: { type: "object" },
        catalogId: catalog.id,
      });

      const toolsToSync = [
        {
          name: "tool-1",
          description: "Tool description",
          parameters: { type: "object" },
          catalogId: catalog.id,
        },
      ];

      const result = await ToolModel.syncToolsForCatalog(toolsToSync);

      expect(result.created).toHaveLength(0);
      expect(result.updated).toHaveLength(0);
      expect(result.unchanged).toHaveLength(1);
      expect(result.unchanged[0].id).toBe(existingTool.id);
    });

    test("handles mix of create, update, and unchanged", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      await makeMcpServer({ catalogId: catalog.id });

      // Create existing tools
      const unchangedTool = await makeTool({
        name: "tool-unchanged",
        description: "No change",
        parameters: { type: "object" },
        catalogId: catalog.id,
      });

      const updateTool = await makeTool({
        name: "tool-update",
        description: "Old description",
        parameters: { type: "object" },
        catalogId: catalog.id,
      });

      const toolsToSync = [
        {
          name: "tool-unchanged",
          description: "No change",
          parameters: { type: "object" },
          catalogId: catalog.id,
        },
        {
          name: "tool-update",
          description: "New description",
          parameters: { type: "object" },
          catalogId: catalog.id,
        },
        {
          name: "tool-new",
          description: "Brand new tool",
          parameters: { type: "object" },
          catalogId: catalog.id,
        },
      ];

      const result = await ToolModel.syncToolsForCatalog(toolsToSync);

      expect(result.created).toHaveLength(1);
      expect(result.updated).toHaveLength(1);
      expect(result.unchanged).toHaveLength(1);

      expect(result.created[0].name).toBe("tool-new");
      expect(result.updated[0].id).toBe(updateTool.id);
      expect(result.unchanged[0].id).toBe(unchangedTool.id);
    });

    test("preserves tool IDs during update (for policy preservation)", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
      makeToolPolicy,
      makeAgent,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      await makeMcpServer({ catalogId: catalog.id });
      const agent = await makeAgent();

      // Create existing tool with policy
      const existingTool = await makeTool({
        name: "tool-with-policy",
        description: "Has policy",
        parameters: { type: "object" },
        catalogId: catalog.id,
      });

      // Create a tool invocation policy for this tool
      await makeToolPolicy(existingTool.id, {
        action: "block_always",
        reason: "Test policy",
      });

      // Assign tool to agent
      await AgentToolModel.create(agent.id, existingTool.id);

      // Sync with updated description
      const toolsToSync = [
        {
          name: "tool-with-policy",
          description: "Updated description",
          parameters: { type: "object" },
          catalogId: catalog.id,
        },
      ];

      const result = await ToolModel.syncToolsForCatalog(toolsToSync);

      expect(result.updated).toHaveLength(1);
      expect(result.updated[0].id).toBe(existingTool.id);

      // Verify agent-tool assignment still exists (key verification for policy preservation)
      const agentToolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
      expect(agentToolIds).toContain(existingTool.id);
    });

    test("returns empty arrays for empty input", async () => {
      const result = await ToolModel.syncToolsForCatalog([]);

      expect(result.created).toHaveLength(0);
      expect(result.updated).toHaveLength(0);
      expect(result.unchanged).toHaveLength(0);
      expect(result.deleted).toHaveLength(0);
    });

    test("renames tools when catalog name changes (preserves ID and assignments)", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
      makeAgent,
    }) => {
      const catalog = await makeInternalMcpCatalog({
        name: "old-catalog-name",
      });
      await makeMcpServer({ catalogId: catalog.id });
      const agent = await makeAgent();

      // Create existing tool with old catalog name prefix
      const existingTool = await makeTool({
        name: "old-catalog-name__query-docs",
        description: "Query docs",
        parameters: { type: "object" },
        catalogId: catalog.id,
      });

      // Assign tool to agent
      await AgentToolModel.create(agent.id, existingTool.id);

      // Sync with new catalog name (simulating catalog rename)
      const toolsToSync = [
        {
          name: "new-catalog-name__query-docs", // Same raw name, different prefix
          description: "Query docs",
          parameters: { type: "object" },
          catalogId: catalog.id,
        },
      ];

      const result = await ToolModel.syncToolsForCatalog(toolsToSync);

      // Should update (rename) the existing tool, not create a new one
      expect(result.created).toHaveLength(0);
      expect(result.updated).toHaveLength(1);
      expect(result.unchanged).toHaveLength(0);
      expect(result.deleted).toHaveLength(0);

      // Verify the tool was renamed but kept the same ID
      expect(result.updated[0].id).toBe(existingTool.id);
      expect(result.updated[0].name).toBe("new-catalog-name__query-docs");

      // Verify agent-tool assignment still exists (uses same tool ID)
      const agentToolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
      expect(agentToolIds).toContain(existingTool.id);
    });

    test("deletes orphaned tools that are no longer returned by MCP server", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      await makeMcpServer({ catalogId: catalog.id });

      // Create existing tools
      const tool1 = await makeTool({
        name: "catalog__tool-1",
        description: "Tool 1",
        parameters: { type: "object" },
        catalogId: catalog.id,
      });

      await makeTool({
        name: "catalog__tool-2",
        description: "Tool 2 - will be removed",
        parameters: { type: "object" },
        catalogId: catalog.id,
      });

      // Sync with only one tool (simulating tool-2 being removed from MCP server)
      const toolsToSync = [
        {
          name: "catalog__tool-1",
          description: "Tool 1",
          parameters: { type: "object" },
          catalogId: catalog.id,
        },
      ];

      const result = await ToolModel.syncToolsForCatalog(toolsToSync);

      // tool-1 should be unchanged, tool-2 should be deleted
      expect(result.unchanged).toHaveLength(1);
      expect(result.unchanged[0].id).toBe(tool1.id);
      expect(result.deleted).toHaveLength(1);
      expect(result.deleted[0].name).toBe("catalog__tool-2");
    });

    test("cleans up duplicate tools after catalog rename (legacy duplicates)", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      await makeMcpServer({ catalogId: catalog.id });

      // Create legacy tool with old catalog name prefix
      // This simulates a tool that existed before catalog was renamed
      await makeTool({
        name: "old-name__query-docs",
        description: "Old tool with legacy name",
        parameters: { type: "object" },
        catalogId: catalog.id,
      });

      // Sync with the new name (after catalog rename)
      const toolsToSync = [
        {
          name: "new-name__query-docs",
          description: "New tool",
          parameters: { type: "object" },
          catalogId: catalog.id,
          rawToolName: "query-docs",
        },
      ];

      const result = await ToolModel.syncToolsForCatalog(toolsToSync);

      // The old tool should be updated with the new name (matched by rawToolName)
      // Note: If the old tool didn't have rawToolName stored, it would be deleted
      // and the new tool would be created instead
      const survivingTools = [...result.unchanged, ...result.updated];

      // Verify exactly one tool survives with the new name
      expect(survivingTools.length + result.created.length).toBe(1);
      const finalTool = survivingTools[0] || result.created[0];
      expect(finalTool.name).toBe("new-name__query-docs");
    });

    test("creates default policies for newly created tools", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      await makeMcpServer({ catalogId: catalog.id });

      const toolsToSync = [
        {
          name: "new-tool",
          description: "New tool",
          parameters: { type: "object" },
          catalogId: catalog.id,
        },
      ];

      const result = await ToolModel.syncToolsForCatalog(toolsToSync);

      expect(result.created).toHaveLength(1);

      // Verify the tool was created (default policies are created internally by createDefaultPolicies)
      const createdTool = result.created[0];
      expect(createdTool.id).toBeDefined();
      expect(createdTool.name).toBe("new-tool");
    });

    test("creates new tools with meta field", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const mcpServer = await makeMcpServer({ catalogId: catalog.id });

      const meta = {
        _meta: { ui: { resourceUri: "mcp://widget/stats" } },
        annotations: { audience: ["user"] },
      };

      const toolsToSync = [
        {
          name: "tool-with-meta",
          description: "Tool with UI metadata",
          parameters: { type: "object" },
          catalogId: catalog.id,
          mcpServerId: mcpServer.id,
          meta,
        },
      ];

      const result = await ToolModel.syncToolsForCatalog(toolsToSync);

      expect(result.created).toHaveLength(1);
      expect(result.created[0].meta).toEqual(meta);
    });

    test("updates tools when meta changes", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const mcpServer = await makeMcpServer({ catalogId: catalog.id });

      await makeTool({
        name: "tool-meta-update",
        description: "Tool",
        parameters: { type: "object" },
        catalogId: catalog.id,
      });

      const newMeta = {
        _meta: { ui: { resourceUri: "mcp://widget/new-ui" } },
      };

      const toolsToSync = [
        {
          name: "tool-meta-update",
          description: "Tool",
          parameters: { type: "object" },
          catalogId: catalog.id,
          mcpServerId: mcpServer.id,
          meta: newMeta,
        },
      ];

      const result = await ToolModel.syncToolsForCatalog(toolsToSync);

      expect(result.updated).toHaveLength(1);
      expect(result.unchanged).toHaveLength(0);
      expect(result.updated[0].meta).toEqual(newMeta);
    });

    test("treats null and undefined meta as equivalent (unchanged)", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeTool,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      const mcpServer = await makeMcpServer({ catalogId: catalog.id });

      // Tool created without meta (stored as null in DB)
      await makeTool({
        name: "tool-null-meta",
        description: "Tool",
        parameters: { type: "object" },
        catalogId: catalog.id,
      });

      // Sync without providing meta (undefined) — should be unchanged
      const toolsToSync = [
        {
          name: "tool-null-meta",
          description: "Tool",
          parameters: { type: "object" },
          catalogId: catalog.id,
          mcpServerId: mcpServer.id,
        },
      ];

      const result = await ToolModel.syncToolsForCatalog(toolsToSync);

      expect(result.unchanged).toHaveLength(1);
      expect(result.updated).toHaveLength(0);
    });
  });

  describe("getMcpToolsAssignedToAgentBySuffix", () => {
    test("returns empty array when no tools match suffix", async ({
      makeAgent,
      makeUser,
    }) => {
      await makeUser();
      const agent = await makeAgent();

      const result = await ToolModel.getMcpToolsAssignedToAgentBySuffix(
        "nonexistent-tool",
        agent.id,
      );

      expect(result).toEqual([]);
    });

    test("finds tool by raw name suffix", async ({
      makeAgent,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const agent = await makeAgent();

      const catalogItem = await makeInternalMcpCatalog({
        name: "system-server",
        serverUrl: "https://example.com/mcp/",
      });

      const tool = await makeTool({
        name: `system${MCP_SERVER_TOOL_NAME_SEPARATOR}refresh-stats`,
        description: "Refresh stats",
        parameters: { type: "object" },
        catalogId: catalogItem.id,
      });

      await AgentToolModel.create(agent.id, tool.id);

      const result = await ToolModel.getMcpToolsAssignedToAgentBySuffix(
        "refresh-stats",
        agent.id,
      );

      expect(result).toHaveLength(1);
      expect(result[0].toolName).toBe(
        `system${MCP_SERVER_TOOL_NAME_SEPARATOR}refresh-stats`,
      );
      expect(result[0].catalogId).toBe(catalogItem.id);
      expect(result[0].catalogName).toBe("system-server");
    });

    test("does not match proxy-sniffed tools without catalogId", async ({
      makeUser,
      makeAgent,
      makeTool,
    }) => {
      await makeUser();
      const agent = await makeAgent();

      // Proxy-sniffed tool has agentId set but no catalogId
      const tool = await makeTool({
        name: `server${MCP_SERVER_TOOL_NAME_SEPARATOR}some-tool`,
        description: "Proxy tool",
        parameters: {},
        agentId: agent.id,
      });

      await AgentToolModel.create(agent.id, tool.id);

      const result = await ToolModel.getMcpToolsAssignedToAgentBySuffix(
        "some-tool",
        agent.id,
      );

      expect(result).toEqual([]);
    });

    test("returns at most one result (limit 1)", async ({
      makeAgent,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const agent = await makeAgent();

      const catalog1 = await makeInternalMcpCatalog({
        name: "server-a",
        serverUrl: "https://a.com/mcp/",
      });
      const catalog2 = await makeInternalMcpCatalog({
        name: "server-b",
        serverUrl: "https://b.com/mcp/",
      });

      const tool1 = await makeTool({
        name: `server-a${MCP_SERVER_TOOL_NAME_SEPARATOR}list-items`,
        description: "List items A",
        parameters: {},
        catalogId: catalog1.id,
      });
      const tool2 = await makeTool({
        name: `server-b${MCP_SERVER_TOOL_NAME_SEPARATOR}list-items`,
        description: "List items B",
        parameters: {},
        catalogId: catalog2.id,
      });

      await AgentToolModel.create(agent.id, tool1.id);
      await AgentToolModel.create(agent.id, tool2.id);

      const result = await ToolModel.getMcpToolsAssignedToAgentBySuffix(
        "list-items",
        agent.id,
      );

      expect(result).toHaveLength(1);
    });
  });

  describe("findToolsByUiResourceUri", () => {
    test("returns empty array when agent has no tools", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();

      const result = await ToolModel.findToolsByUiResourceUri(
        agent.id,
        "mcp://widget/stats",
      );

      expect(result).toEqual([]);
    });

    test("finds tools matching ui/resourceUri in meta", async ({
      makeAgent,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const agent = await makeAgent();

      const catalogItem = await makeInternalMcpCatalog({
        name: "widget-server",
        serverUrl: "https://example.com/mcp/",
      });

      const tool = await makeTool({
        name: "widget-server__show-dashboard",
        description: "Show dashboard",
        parameters: {},
        catalogId: catalogItem.id,
      });

      // Update meta directly via syncToolsForCatalog to set the resourceUri
      const resourceUri = "mcp://widget/dashboard";
      await ToolModel.syncToolsForCatalog([
        {
          name: "widget-server__show-dashboard",
          description: "Show dashboard",
          parameters: {},
          catalogId: catalogItem.id,
          meta: { _meta: { ui: { resourceUri } } },
        },
      ]);

      await AgentToolModel.create(agent.id, tool.id);

      const result = await ToolModel.findToolsByUiResourceUri(
        agent.id,
        resourceUri,
      );

      expect(result).toHaveLength(1);
      expect(result[0].tool.id).toBe(tool.id);
    });

    test("does not return tools with non-matching resourceUri", async ({
      makeAgent,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const agent = await makeAgent();

      const catalogItem = await makeInternalMcpCatalog({
        name: "widget-server",
        serverUrl: "https://example.com/mcp/",
      });

      const tool = await makeTool({
        name: "widget-server__show-chart",
        description: "Show chart",
        parameters: {},
        catalogId: catalogItem.id,
      });

      await ToolModel.syncToolsForCatalog([
        {
          name: "widget-server__show-chart",
          description: "Show chart",
          parameters: {},
          catalogId: catalogItem.id,
          meta: { _meta: { ui: { resourceUri: "mcp://widget/chart" } } },
        },
      ]);

      await AgentToolModel.create(agent.id, tool.id);

      const result = await ToolModel.findToolsByUiResourceUri(
        agent.id,
        "mcp://widget/completely-different",
      );

      expect(result).toEqual([]);
    });

    test("does not return tools without meta", async ({
      makeAgent,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const agent = await makeAgent();

      const catalogItem = await makeInternalMcpCatalog({
        name: "plain-server",
        serverUrl: "https://example.com/mcp/",
      });

      const tool = await makeTool({
        name: "plain-server__plain-tool",
        description: "No UI metadata",
        parameters: {},
        catalogId: catalogItem.id,
      });

      await AgentToolModel.create(agent.id, tool.id);

      const result = await ToolModel.findToolsByUiResourceUri(
        agent.id,
        "mcp://widget/any",
      );

      expect(result).toEqual([]);
    });
  });

  describe("bulkCreateToolsIfNotExists", () => {
    test("stores meta field when creating tools", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const catalog = await makeInternalMcpCatalog();
      await makeMcpServer({ catalogId: catalog.id });

      const meta = {
        _meta: { ui: { resourceUri: "mcp://app/view" } },
        annotations: { readOnlyHint: true },
      };

      const result = await ToolModel.bulkCreateToolsIfNotExists([
        {
          name: "bulk-tool-with-meta",
          description: "Tool with meta",
          parameters: { type: "object" },
          catalogId: catalog.id,
          meta,
        },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].meta).toEqual(meta);
    });

    test("updates meta on existing tools when it changed", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog();

      const originalMeta = {
        _meta: { ui: { resourceUri: "mcp://app/original" } },
      };

      // Create the tool first
      const [created] = await ToolModel.bulkCreateToolsIfNotExists([
        {
          name: "bulk-tool-existing",
          description: "Tool",
          parameters: {},
          catalogId: catalog.id,
          meta: originalMeta,
        },
      ]);

      const updatedMeta = {
        _meta: { ui: { resourceUri: "mcp://app/different" } },
      };

      // Call again with different meta — should update meta on existing tool
      const result = await ToolModel.bulkCreateToolsIfNotExists([
        {
          name: "bulk-tool-existing",
          description: "Tool",
          parameters: {},
          catalogId: catalog.id,
          meta: updatedMeta,
        },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(created.id);
      expect(result[0].meta).toEqual(updatedMeta);
    });

    test("preserves meta on existing tools when it has not changed", async ({
      makeInternalMcpCatalog,
    }) => {
      const catalog = await makeInternalMcpCatalog();

      const meta = {
        _meta: { ui: { resourceUri: "mcp://app/original" } },
      };

      // Create the tool first
      const [created] = await ToolModel.bulkCreateToolsIfNotExists([
        {
          name: "bulk-tool-same-meta",
          description: "Tool",
          parameters: {},
          catalogId: catalog.id,
          meta,
        },
      ]);

      // Call again with the same meta — should return existing tool unchanged
      const result = await ToolModel.bulkCreateToolsIfNotExists([
        {
          name: "bulk-tool-same-meta",
          description: "Tool",
          parameters: {},
          catalogId: catalog.id,
          meta,
        },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(created.id);
      expect(result[0].meta).toEqual(meta);
    });
  });

  describe("parseArchestraBuiltInName", () => {
    test("parses default built-in tool names", () => {
      expect(parseArchestraBuiltInName("archestra__create_agent")).toEqual({
        serverName: "archestra",
        shortName: "create_agent",
      });
    });

    test("parses white-labeled built-in tool names", () => {
      expect(parseArchestraBuiltInName("acme_copilot__create_agent")).toEqual({
        serverName: "acme_copilot",
        shortName: "create_agent",
      });
    });

    test("returns null shortName for non-built-in tool names", () => {
      expect(parseArchestraBuiltInName("github__list_issues")).toEqual({
        serverName: "github",
        shortName: null,
      });
    });
  });

  describe("seedArchestraTools", () => {
    test("creates the built-in catalog entry with current metadata", async () => {
      const catalogId = randomUUID();
      archestraMcpBranding.syncFromOrganization(null);
      const metadata = getArchestraMcpCatalogMetadata();

      await ToolModel.seedArchestraTools(catalogId);

      const [catalog] = await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(eq(schema.internalMcpCatalogTable.id, catalogId));

      expect(catalog).toBeDefined();
      expect(catalog?.name).toBe(metadata.name);
      expect(catalog?.description).toBe(metadata.description);
      expect(catalog?.docsUrl).toBe(metadata.docsUrl);
      expect(catalog?.serverType).toBe(metadata.serverType);
      expect(catalog?.requiresAuth).toBe(metadata.requiresAuth);
    });

    test("updates stale built-in catalog metadata on reseed", async () => {
      const catalogId = randomUUID();
      archestraMcpBranding.syncFromOrganization(null);
      const metadata = getArchestraMcpCatalogMetadata();

      await db.insert(schema.internalMcpCatalogTable).values({
        id: catalogId,
        name: "Old Archestra",
        description: "Outdated description",
        docsUrl: "https://example.com/old-docs",
        serverType: "builtin",
        requiresAuth: true,
      });

      await ToolModel.seedArchestraTools(catalogId);

      const [catalog] = await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(eq(schema.internalMcpCatalogTable.id, catalogId));

      expect(catalog).toBeDefined();
      expect(catalog?.name).toBe(metadata.name);
      expect(catalog?.description).toBe(metadata.description);
      expect(catalog?.docsUrl).toBe(metadata.docsUrl);
      expect(catalog?.serverType).toBe(metadata.serverType);
      expect(catalog?.requiresAuth).toBe(metadata.requiresAuth);
    });

    test("rebrands built-in catalog metadata and tool names on sync for white-labeled orgs", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      await OrganizationModel.patch(org.id, {
        appName: "Acme Copilot",
        iconLogo: "https://cdn.example.com/logo.png",
      });

      await ToolModel.syncArchestraBuiltInCatalog({
        organization: {
          appName: "Acme Copilot",
          iconLogo: "https://cdn.example.com/logo.png",
        },
      });

      const [catalog] = await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(
          eq(
            schema.internalMcpCatalogTable.id,
            "00000000-0000-4000-8000-000000000001",
          ),
        );
      const [artifactTool] = await db
        .select()
        .from(schema.toolsTable)
        .where(
          eq(
            schema.toolsTable.name,
            getArchestraToolFullName(TOOL_ARTIFACT_WRITE_SHORT_NAME, {
              appName: "Acme Copilot",
              fullWhiteLabeling: true,
            }),
          ),
        );

      expect(catalog?.name).toBe(
        getArchestraMcpCatalogName({
          appName: "Acme Copilot",
          fullWhiteLabeling: true,
        }),
      );
      expect(catalog?.docsUrl).toBeNull();
      expect(catalog?.icon).toBe("https://cdn.example.com/logo.png");
      expect(catalog?.description).not.toContain("Archestra");
      expect(artifactTool).toBeDefined();
    });
  });

  describe("findAllWithAssignments", () => {
    test("returns deterministic order for tools with identical createdAt timestamps", async ({
      makeAdmin,
      makeAgent,
      makeAgentTool,
    }) => {
      const admin = await makeAdmin();
      const agent = await makeAgent({ name: "TestAgent" });

      // Create multiple tools with the exact same createdAt timestamp
      const sharedTimestamp = new Date("2024-01-01T00:00:00Z");
      const toolNames = ["tool-c", "tool-a", "tool-b"];
      const tools = [];
      for (const name of toolNames) {
        const tool = await ToolModel.create({
          name,
          description: `Description for ${name}`,
          parameters: {},
          createdAt: sharedTimestamp,
          updatedAt: sharedTimestamp,
        });
        await makeAgentTool(agent.id, tool.id);
        tools.push(tool);
      }

      // Fetch multiple times and verify ordering is identical
      const result1 = await ToolModel.findAllWithAssignments({
        userId: admin.id,
        isAgentAdmin: true,
      });
      const result2 = await ToolModel.findAllWithAssignments({
        userId: admin.id,
        isAgentAdmin: true,
      });

      const ids1 = result1.data.map((t) => t.id);
      const ids2 = result2.data.map((t) => t.id);
      expect(ids1).toEqual(ids2);
    });

    test("excludes the white-labeled knowledge tool from assignment listings", async ({
      makeOrganization,
      makeAgent,
      makeAgentTool,
    }) => {
      const org = await makeOrganization();
      await OrganizationModel.patch(org.id, { appName: "Acme Copilot" });
      await ToolModel.syncArchestraBuiltInCatalog({
        organization: { appName: "Acme Copilot", iconLogo: null },
      });

      const agent = await makeAgent({ organizationId: org.id });
      const [kbTool] = await db
        .select()
        .from(schema.toolsTable)
        .where(
          eq(
            schema.toolsTable.name,
            getArchestraToolFullName(TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME, {
              appName: "Acme Copilot",
              fullWhiteLabeling: true,
            }),
          ),
        );

      expect(kbTool).toBeDefined();
      await makeAgentTool(agent.id, kbTool?.id);

      const result = await ToolModel.findAllWithAssignments({
        filters: {},
      });

      expect(
        result.data.some(
          (tool) =>
            tool.name ===
            getArchestraToolFullName(TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME, {
              appName: "Acme Copilot",
              fullWhiteLabeling: true,
            }),
        ),
      ).toBe(false);
    });
  });
});
