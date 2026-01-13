import { describe, expect, test } from "@/test";
import AgentToolModel from "./agent-tool";

describe("AgentToolModel.findAll", () => {
  describe("Pagination", () => {
    test("returns paginated results with correct metadata", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();
      const tools = await Promise.all([
        makeTool({ name: "tool-1" }),
        makeTool({ name: "tool-2" }),
        makeTool({ name: "tool-3" }),
        makeTool({ name: "tool-4" }),
        makeTool({ name: "tool-5" }),
      ]);

      // Create agent-tool relationships
      for (const tool of tools) {
        await makeAgentTool(agent.id, tool.id);
      }

      // Test first page
      const page1 = await AgentToolModel.findAll({
        pagination: { limit: 2, offset: 0 },
        filters: { excludeArchestraTools: true },
      });
      expect(page1.data).toHaveLength(2);
      expect(page1.pagination.total).toBe(5);
      expect(page1.pagination.currentPage).toBe(1);
      expect(page1.pagination.totalPages).toBe(3);
      expect(page1.pagination.hasNext).toBe(true);
      expect(page1.pagination.hasPrev).toBe(false);

      // Test second page
      const page2 = await AgentToolModel.findAll({
        pagination: { limit: 2, offset: 2 },
        filters: { excludeArchestraTools: true },
      });
      expect(page2.data).toHaveLength(2);
      expect(page2.pagination.currentPage).toBe(2);
      expect(page2.pagination.hasNext).toBe(true);
      expect(page2.pagination.hasPrev).toBe(true);

      // Test last page
      const page3 = await AgentToolModel.findAll({
        pagination: { limit: 2, offset: 4 },
        filters: { excludeArchestraTools: true },
      });
      expect(page3.data).toHaveLength(1);
      expect(page3.pagination.currentPage).toBe(3);
      expect(page3.pagination.hasNext).toBe(false);
      expect(page3.pagination.hasPrev).toBe(true);
    });

    test("respects custom page size", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();
      const tools = await Promise.all([
        makeTool({ name: "tool-1" }),
        makeTool({ name: "tool-2" }),
        makeTool({ name: "tool-3" }),
        makeTool({ name: "tool-4" }),
        makeTool({ name: "tool-5" }),
      ]);

      for (const tool of tools) {
        await makeAgentTool(agent.id, tool.id);
      }

      const result = await AgentToolModel.findAll({
        pagination: { limit: 3, offset: 0 },
        filters: { excludeArchestraTools: true },
      });
      expect(result.data).toHaveLength(3);
      expect(result.pagination.limit).toBe(3);
      expect(result.pagination.totalPages).toBe(2);
    });

    test("handles empty results", async () => {
      const result = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
      });
      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
      expect(result.pagination.totalPages).toBe(0);
      expect(result.pagination.hasNext).toBe(false);
      expect(result.pagination.hasPrev).toBe(false);
    });
  });

  describe("Skip Pagination", () => {
    test("returns all results when skipPagination is true", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();
      const tools = await Promise.all([
        makeTool({ name: "tool-1" }),
        makeTool({ name: "tool-2" }),
        makeTool({ name: "tool-3" }),
        makeTool({ name: "tool-4" }),
        makeTool({ name: "tool-5" }),
      ]);

      for (const tool of tools) {
        await makeAgentTool(agent.id, tool.id);
      }

      // With skipPagination, should return all 5 tools even with limit: 2
      const result = await AgentToolModel.findAll({
        pagination: { limit: 2, offset: 0 },
        filters: { excludeArchestraTools: true },
        skipPagination: true,
      });

      expect(result.data).toHaveLength(5);
      expect(result.pagination.total).toBe(5);
      expect(result.pagination.totalPages).toBe(1);
      expect(result.pagination.hasNext).toBe(false);
      expect(result.pagination.hasPrev).toBe(false);
    });

    test("skipPagination respects filters", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });
      const tool1 = await makeTool({ name: "tool-1" });
      const tool2 = await makeTool({ name: "tool-2" });
      const tool3 = await makeTool({ name: "tool-3" });

      // Assign tools to different agents
      await makeAgentTool(agent1.id, tool1.id);
      await makeAgentTool(agent1.id, tool2.id);
      await makeAgentTool(agent2.id, tool3.id);

      // With skipPagination and agentId filter, should return only agent1's tools
      const result = await AgentToolModel.findAll({
        filters: { agentId: agent1.id, excludeArchestraTools: true },
        skipPagination: true,
      });

      expect(result.data).toHaveLength(2);
      expect(result.data.every((at) => at.agent.id === agent1.id)).toBe(true);
    });

    test("skipPagination with default pagination parameter works", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();
      const tools = await Promise.all([
        makeTool({ name: "tool-1" }),
        makeTool({ name: "tool-2" }),
        makeTool({ name: "tool-3" }),
      ]);

      for (const tool of tools) {
        await makeAgentTool(agent.id, tool.id);
      }

      // Call without explicit pagination - should still return all results
      const result = await AgentToolModel.findAll({
        filters: { excludeArchestraTools: true },
        skipPagination: true,
      });

      expect(result.data).toHaveLength(3);
      expect(result.pagination.total).toBe(3);
    });

    test("skipPagination with empty results does not cause division by zero", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();

      // Query for a specific agent with no tools assigned, using skipPagination
      // This should not produce NaN values in pagination metadata
      const result = await AgentToolModel.findAll({
        filters: { agentId: agent.id, excludeArchestraTools: true },
        skipPagination: true,
      });

      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
      // These should be valid numbers, not NaN
      expect(Number.isNaN(result.pagination.totalPages)).toBe(false);
      expect(Number.isNaN(result.pagination.currentPage)).toBe(false);
      expect(result.pagination.totalPages).toBe(0);
      expect(result.pagination.currentPage).toBe(1);
      expect(result.pagination.hasNext).toBe(false);
      expect(result.pagination.hasPrev).toBe(false);
    });
  });

  describe("Sorting", () => {
    test("sorts by tool name ascending", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();
      const toolC = await makeTool({ name: "c-tool" });
      const toolA = await makeTool({ name: "a-tool" });
      const toolB = await makeTool({ name: "b-tool" });

      await makeAgentTool(agent.id, toolC.id);
      await makeAgentTool(agent.id, toolA.id);
      await makeAgentTool(agent.id, toolB.id);

      const result = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        sorting: { sortBy: "name", sortDirection: "asc" },
        filters: { excludeArchestraTools: true },
      });

      expect(result.data[0].tool.name).toBe("a-tool");
      expect(result.data[1].tool.name).toBe("b-tool");
      expect(result.data[2].tool.name).toBe("c-tool");
    });

    test("sorts by tool name descending", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();
      const toolC = await makeTool({ name: "c-tool" });
      const toolA = await makeTool({ name: "a-tool" });
      const toolB = await makeTool({ name: "b-tool" });

      await makeAgentTool(agent.id, toolC.id);
      await makeAgentTool(agent.id, toolA.id);
      await makeAgentTool(agent.id, toolB.id);

      const result = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        sorting: { sortBy: "name", sortDirection: "desc" },
        filters: { excludeArchestraTools: true },
      });

      expect(result.data[0].tool.name).toBe("c-tool");
      expect(result.data[1].tool.name).toBe("b-tool");
      expect(result.data[2].tool.name).toBe("a-tool");
    });

    test("sorts by agent name", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agentZ = await makeAgent({ name: "Z-Agent" });
      const agentA = await makeAgent({ name: "A-Agent" });
      const agentM = await makeAgent({ name: "M-Agent" });
      const tool = await makeTool();

      await makeAgentTool(agentZ.id, tool.id);
      await makeAgentTool(agentA.id, tool.id);
      await makeAgentTool(agentM.id, tool.id);

      const result = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        sorting: { sortBy: "agent", sortDirection: "asc" },
        filters: { excludeArchestraTools: true },
      });

      expect(result.data[0].agent.name).toBe("A-Agent");
      expect(result.data[1].agent.name).toBe("M-Agent");
      expect(result.data[2].agent.name).toBe("Z-Agent");
    });

    test("sorts by origin (MCP vs LLM Proxy)", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
      makeInternalMcpCatalog,
    }) => {
      const agent = await makeAgent();
      const catalog = await makeInternalMcpCatalog();

      // LLM Proxy tool (no catalogId)
      const llmProxyTool = await makeTool({ name: "llm-proxy-tool" });

      // MCP tool (with catalogId)
      const mcpTool = await makeTool({
        name: "mcp-tool",
        catalogId: catalog.id,
      });

      await makeAgentTool(agent.id, llmProxyTool.id);
      await makeAgentTool(agent.id, mcpTool.id);

      const resultAsc = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        sorting: { sortBy: "origin", sortDirection: "asc" },
      });

      // MCP tools come first (1-mcp), LLM Proxy comes last (2-llm-proxy)
      expect(resultAsc.data[0].tool.catalogId).toBe(catalog.id);
      expect(resultAsc.data[1].tool.catalogId).toBeNull();
    });

    test("sorts by createdAt by default", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();
      const tool1 = await makeTool({ name: "tool-1" });
      const tool2 = await makeTool({ name: "tool-2" });
      const tool3 = await makeTool({ name: "tool-3" });

      const agentTool1 = await makeAgentTool(agent.id, tool1.id);
      // Add small delays to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));
      const agentTool2 = await makeAgentTool(agent.id, tool2.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const agentTool3 = await makeAgentTool(agent.id, tool3.id);

      const result = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        sorting: { sortBy: "createdAt", sortDirection: "desc" },
        filters: { excludeArchestraTools: true },
      });

      // Most recent first
      expect(result.data[0].id).toBe(agentTool3.id);
      expect(result.data[1].id).toBe(agentTool2.id);
      expect(result.data[2].id).toBe(agentTool1.id);
    });
  });

  describe("Filtering", () => {
    test("filters by search query (tool name)", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();
      const tool1 = await makeTool({ name: "read-file-tool" });
      const tool2 = await makeTool({ name: "write-file-tool" });
      const tool3 = await makeTool({ name: "database-query" });

      await makeAgentTool(agent.id, tool1.id);
      await makeAgentTool(agent.id, tool2.id);
      await makeAgentTool(agent.id, tool3.id);

      const result = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        filters: { search: "file", excludeArchestraTools: true },
      });

      expect(result.data).toHaveLength(2);
      expect(result.data[0].tool.name).toContain("file");
      expect(result.data[1].tool.name).toContain("file");
    });

    test("search is case-insensitive", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();
      const tool = await makeTool({ name: "ReadFile" });

      await makeAgentTool(agent.id, tool.id);

      const resultLower = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        filters: { search: "readfile" },
      });

      const resultUpper = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        filters: { search: "READFILE" },
      });

      expect(resultLower.data).toHaveLength(1);
      expect(resultUpper.data).toHaveLength(1);
    });

    test("filters by agentId", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });
      const tool = await makeTool();

      await makeAgentTool(agent1.id, tool.id);
      await makeAgentTool(agent2.id, tool.id);

      const result = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        filters: { agentId: agent1.id, excludeArchestraTools: true },
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].agent.id).toBe(agent1.id);
    });

    test("filters by origin (llm-proxy)", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
      makeInternalMcpCatalog,
    }) => {
      const agent = await makeAgent();
      const catalog = await makeInternalMcpCatalog();

      const llmProxyTool = await makeTool({ name: "llm-proxy-tool" });
      const mcpTool = await makeTool({
        name: "mcp-tool",
        catalogId: catalog.id,
      });

      await makeAgentTool(agent.id, llmProxyTool.id);
      await makeAgentTool(agent.id, mcpTool.id);

      const result = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        filters: { origin: "llm-proxy", excludeArchestraTools: true },
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].tool.catalogId).toBeNull();
    });

    test("filters by origin (catalogId)", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
      makeInternalMcpCatalog,
    }) => {
      const agent = await makeAgent();
      const catalog1 = await makeInternalMcpCatalog({ name: "Catalog 1" });
      const catalog2 = await makeInternalMcpCatalog({ name: "Catalog 2" });

      const tool1 = await makeTool({ name: "tool-1", catalogId: catalog1.id });
      const tool2 = await makeTool({ name: "tool-2", catalogId: catalog2.id });
      const llmProxyTool = await makeTool({ name: "llm-tool" });

      await makeAgentTool(agent.id, tool1.id);
      await makeAgentTool(agent.id, tool2.id);
      await makeAgentTool(agent.id, llmProxyTool.id);

      const result = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        filters: { origin: catalog1.id },
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].tool.catalogId).toBe(catalog1.id);
    });

    test("filters by mcpServerOwnerId", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
      makeMcpServer,
      makeUser,
    }) => {
      const agent = await makeAgent();
      const owner = await makeUser();
      const otherOwner = await makeUser();

      const ownerServer1 = await makeMcpServer({
        name: "Server 1",
        ownerId: owner.id,
      });
      const ownerServer2 = await makeMcpServer({
        name: "Server 2",
        ownerId: owner.id,
      });
      const otherOwnerServer = await makeMcpServer({
        name: "Server 3",
        ownerId: otherOwner.id,
      });

      const tool1 = await makeTool({ name: "tool-1" });
      const tool2 = await makeTool({ name: "tool-2" });
      const tool3 = await makeTool({ name: "tool-3" });
      const tool4 = await makeTool({ name: "tool-4" });

      await makeAgentTool(agent.id, tool1.id, {
        credentialSourceMcpServerId: ownerServer1.id,
      });
      await makeAgentTool(agent.id, tool2.id, {
        executionSourceMcpServerId: ownerServer2.id,
      });
      await makeAgentTool(agent.id, tool3.id, {
        credentialSourceMcpServerId: otherOwnerServer.id,
      });
      await makeAgentTool(agent.id, tool4.id);

      const result = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        filters: { mcpServerOwnerId: owner.id },
      });

      expect(result.data).toHaveLength(2);
      expect(
        result.data.some(
          (agentTool) =>
            agentTool.credentialSourceMcpServerId === ownerServer1.id,
        ),
      ).toBe(true);
      expect(
        result.data.some(
          (agentTool) =>
            agentTool.executionSourceMcpServerId === ownerServer2.id,
        ),
      ).toBe(true);
      expect(
        result.data.every(
          (agentTool) =>
            agentTool.credentialSourceMcpServerId === ownerServer1.id ||
            agentTool.executionSourceMcpServerId === ownerServer2.id,
        ),
      ).toBe(true);
    });

    test("excludeArchestraTools excludes tools with archestra__ prefix", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();

      // Create regular tools
      const regularTool1 = await makeTool({ name: "exclude_test_regular_1" });
      const regularTool2 = await makeTool({ name: "exclude_test_regular_2" });

      // Create Archestra tools (double underscore prefix) with unique names
      const archestraTool1 = await makeTool({
        name: "archestra__exclude_test_tool_1",
      });
      const archestraTool2 = await makeTool({
        name: "archestra__exclude_test_tool_2",
      });

      // Create tools with similar names that should NOT be excluded
      const singleUnderscoreTool = await makeTool({
        name: "archestra_single_underscore_test",
      });
      const noUnderscoreTool = await makeTool({
        name: "archestranounderscore_test",
      });

      await makeAgentTool(agent.id, regularTool1.id);
      await makeAgentTool(agent.id, regularTool2.id);
      await makeAgentTool(agent.id, archestraTool1.id);
      await makeAgentTool(agent.id, archestraTool2.id);
      await makeAgentTool(agent.id, singleUnderscoreTool.id);
      await makeAgentTool(agent.id, noUnderscoreTool.id);

      // With excludeArchestraTools: true - should exclude archestra__ tools
      const resultExcluded = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        filters: { agentId: agent.id, excludeArchestraTools: true },
      });

      expect(resultExcluded.data).toHaveLength(4);
      const excludedToolNames = resultExcluded.data.map((at) => at.tool.name);
      expect(excludedToolNames).toContain("exclude_test_regular_1");
      expect(excludedToolNames).toContain("exclude_test_regular_2");
      expect(excludedToolNames).toContain("archestra_single_underscore_test");
      expect(excludedToolNames).toContain("archestranounderscore_test");
      expect(excludedToolNames).not.toContain("archestra__exclude_test_tool_1");
      expect(excludedToolNames).not.toContain("archestra__exclude_test_tool_2");

      // Without excludeArchestraTools - should include all tools including archestra__ ones
      const resultIncluded = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        filters: { agentId: agent.id },
      });

      const includedToolNames = resultIncluded.data.map((at) => at.tool.name);
      expect(includedToolNames).toContain("archestra__exclude_test_tool_1");
      expect(includedToolNames).toContain("archestra__exclude_test_tool_2");
    });
  });

  describe("Combined Filters, Sorting, and Pagination", () => {
    test("applies multiple filters, sorting, and pagination together", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
      makeInternalMcpCatalog,
    }) => {
      const agent = await makeAgent();
      const catalog = await makeInternalMcpCatalog();

      // Create MCP tools with "read" in name
      const tool1 = await makeTool({
        name: "read-file",
        catalogId: catalog.id,
      });
      const tool2 = await makeTool({
        name: "read-database",
        catalogId: catalog.id,
      });
      const tool3 = await makeTool({
        name: "write-file",
        catalogId: catalog.id,
      });
      const tool4 = await makeTool({
        name: "read-config",
        catalogId: catalog.id,
      });

      await makeAgentTool(agent.id, tool1.id);
      await makeAgentTool(agent.id, tool2.id);
      await makeAgentTool(agent.id, tool3.id);
      await makeAgentTool(agent.id, tool4.id);

      const result = await AgentToolModel.findAll({
        pagination: { limit: 2, offset: 0 },
        sorting: { sortBy: "name", sortDirection: "asc" },
        filters: {
          search: "read",
          agentId: agent.id,
          origin: catalog.id,
        },
      });

      expect(result.data).toHaveLength(2);
      expect(result.pagination.total).toBe(3);
      // Sorted alphabetically, so "read-config" and "read-database"
      expect(result.data[0].tool.name).toBe("read-config");
      expect(result.data[1].tool.name).toBe("read-database");
    });
  });

  describe("Access Control", () => {
    test("admin sees all agent-tools", async ({
      makeAdmin,
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const admin = await makeAdmin();
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });
      const tool = await makeTool();

      await makeAgentTool(agent1.id, tool.id);
      await makeAgentTool(agent2.id, tool.id);

      const result = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        filters: { excludeArchestraTools: true },
        userId: admin.id,
        isAgentAdmin: true,
      });

      expect(result.data).toHaveLength(2);
    });

    test("member only sees agent-tools for agents in their teams", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
      makeTeamMember,
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const user = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();
      const team1 = await makeTeam(org.id, admin.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, admin.id, { name: "Team 2" });

      const agent1 = await makeAgent({
        name: "Agent 1",
        teams: [team1.id],
      });
      const agent2 = await makeAgent({
        name: "Agent 2",
        teams: [team2.id],
      });

      // Add user to team1 via team membership
      await makeTeamMember(team1.id, user.id);

      const tool = await makeTool();

      await makeAgentTool(agent1.id, tool.id);
      await makeAgentTool(agent2.id, tool.id);

      const result = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        filters: { excludeArchestraTools: true },
        userId: user.id,
        isAgentAdmin: false,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].agent.id).toBe(agent1.id);
    });

    test("member with no team access sees empty results", async ({
      makeUser,
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const user = await makeUser();
      const agent = await makeAgent();
      const tool = await makeTool();

      await makeAgentTool(agent.id, tool.id);

      const result = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 0 },
        userId: user.id,
        isAgentAdmin: false,
      });

      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
    });
  });

  describe("Edge Cases", () => {
    test("handles offset beyond total results", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();
      const tool = await makeTool();

      await makeAgentTool(agent.id, tool.id);

      const result = await AgentToolModel.findAll({
        pagination: { limit: 10, offset: 100 },
        filters: { excludeArchestraTools: true },
      });

      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.hasNext).toBe(false);
    });

    test("handles very large limit", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();
      const tool1 = await makeTool({ name: "tool-1" });
      const tool2 = await makeTool({ name: "tool-2" });

      await makeAgentTool(agent.id, tool1.id);
      await makeAgentTool(agent.id, tool2.id);

      const result = await AgentToolModel.findAll({
        pagination: { limit: 1000, offset: 0 },
        filters: { excludeArchestraTools: true },
      });

      expect(result.data).toHaveLength(2);
    });

    test("returns correct pagination metadata with filters", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();
      const tools = await Promise.all([
        makeTool({ name: "read-file" }),
        makeTool({ name: "write-file" }),
        makeTool({ name: "delete-file" }),
        makeTool({ name: "database-query" }),
      ]);

      for (const tool of tools) {
        await makeAgentTool(agent.id, tool.id);
      }

      const result = await AgentToolModel.findAll({
        pagination: { limit: 2, offset: 0 },
        filters: { search: "file", excludeArchestraTools: true },
      });

      expect(result.data).toHaveLength(2);
      expect(result.pagination.total).toBe(3); // 3 tools match "file"
      expect(result.pagination.totalPages).toBe(2);
    });
  });

  describe("createManyIfNotExists", () => {
    test("creates multiple agent-tool relationships in bulk", async ({
      makeAgent,
      makeTool,
    }) => {
      const agent = await makeAgent();
      const tools = await Promise.all([
        makeTool({ name: "tool-1" }),
        makeTool({ name: "tool-2" }),
        makeTool({ name: "tool-3" }),
      ]);

      const initialToolIds = await AgentToolModel.findToolIdsByAgent(agent.id);

      await AgentToolModel.createManyIfNotExists(
        agent.id,
        tools.map((t) => t.id),
      );

      const finalToolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
      expect(finalToolIds.length).toBe(initialToolIds.length + 3);
      expect(finalToolIds).toContain(tools[0].id);
      expect(finalToolIds).toContain(tools[1].id);
      expect(finalToolIds).toContain(tools[2].id);
    });

    test("skips existing relationships and only creates new ones", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();
      const tool1 = await makeTool({ name: "tool-1" });
      const tool2 = await makeTool({ name: "tool-2" });
      const tool3 = await makeTool({ name: "tool-3" });

      const initialToolIds = await AgentToolModel.findToolIdsByAgent(agent.id);

      // Create one relationship manually
      await makeAgentTool(agent.id, tool1.id);

      // Try to create all three relationships in bulk
      await AgentToolModel.createManyIfNotExists(agent.id, [
        tool1.id,
        tool2.id,
        tool3.id,
      ]);

      const finalToolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
      expect(finalToolIds.length).toBe(initialToolIds.length + 3);
      expect(finalToolIds).toContain(tool1.id);
      expect(finalToolIds).toContain(tool2.id);
      expect(finalToolIds).toContain(tool3.id);
    });

    test("handles empty tool IDs array", async ({ makeAgent }) => {
      const agent = await makeAgent();

      const initialToolIds = await AgentToolModel.findToolIdsByAgent(agent.id);

      await AgentToolModel.createManyIfNotExists(agent.id, []);

      const finalToolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
      expect(finalToolIds.length).toBe(initialToolIds.length);
    });
  });

  describe("bulkCreateForAgentsAndTools", () => {
    test("creates agent-tool relationships for multiple agents and tools in bulk", async ({
      makeAgent,
      makeTool,
    }) => {
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });
      const tool1 = await makeTool({ name: "tool-1" });
      const tool2 = await makeTool({ name: "tool-2" });

      await AgentToolModel.bulkCreateForAgentsAndTools(
        [agent1.id, agent2.id],
        [tool1.id, tool2.id],
      );

      // Verify all combinations were created
      const agent1Tools = await AgentToolModel.findToolIdsByAgent(agent1.id);
      const agent2Tools = await AgentToolModel.findToolIdsByAgent(agent2.id);

      expect(agent1Tools).toContain(tool1.id);
      expect(agent1Tools).toContain(tool2.id);
      expect(agent2Tools).toContain(tool1.id);
      expect(agent2Tools).toContain(tool2.id);
    });

    test("applies options to all created relationships", async ({
      makeAgent,
      makeTool,
      makeMcpServer,
    }) => {
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });
      const tool1 = await makeTool({ name: "bulk-test-tool-1" });
      const tool2 = await makeTool({ name: "bulk-test-tool-2" });
      const mcpServer = await makeMcpServer();

      await AgentToolModel.bulkCreateForAgentsAndTools(
        [agent1.id, agent2.id],
        [tool1.id, tool2.id],
        {
          executionSourceMcpServerId: mcpServer.id,
        },
      );

      // Verify options were applied by checking specific tool assignments
      const agent1Tools = await AgentToolModel.findToolIdsByAgent(agent1.id);
      const agent2Tools = await AgentToolModel.findToolIdsByAgent(agent2.id);

      expect(agent1Tools).toContain(tool1.id);
      expect(agent1Tools).toContain(tool2.id);
      expect(agent2Tools).toContain(tool1.id);
      expect(agent2Tools).toContain(tool2.id);

      // Verify options by querying the assignments directly
      const allAssignments = await AgentToolModel.findAll({
        skipPagination: true,
      });
      const relevantAssignments = allAssignments.data.filter(
        (at) =>
          [agent1.id, agent2.id].includes(at.agent.id) &&
          [tool1.id, tool2.id].includes(at.tool.id),
      );

      expect(relevantAssignments).toHaveLength(4);
      relevantAssignments.forEach((assignment) => {
        expect(assignment.executionSourceMcpServerId).toBe(mcpServer.id);
      });
    });

    test("skips existing relationships and only creates new ones", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });
      const tool1 = await makeTool({ name: "tool-1" });
      const tool2 = await makeTool({ name: "tool-2" });
      const tool3 = await makeTool({ name: "tool-3" });

      // Create one relationship manually
      await makeAgentTool(agent1.id, tool1.id);

      // Try to create all combinations in bulk
      await AgentToolModel.bulkCreateForAgentsAndTools(
        [agent1.id, agent2.id],
        [tool1.id, tool2.id, tool3.id],
      );

      // Verify all relationships exist (including the pre-existing one)
      const agent1Tools = await AgentToolModel.findToolIdsByAgent(agent1.id);
      const agent2Tools = await AgentToolModel.findToolIdsByAgent(agent2.id);

      expect(agent1Tools).toContain(tool1.id);
      expect(agent1Tools).toContain(tool2.id);
      expect(agent1Tools).toContain(tool3.id);
      expect(agent2Tools).toContain(tool1.id);
      expect(agent2Tools).toContain(tool2.id);
      expect(agent2Tools).toContain(tool3.id);
    });

    test("handles empty agent IDs array", async ({ makeTool }) => {
      const tool1 = await makeTool({ name: "tool-1" });

      await AgentToolModel.bulkCreateForAgentsAndTools([], [tool1.id]);

      // Should not throw and should not create any relationships
      const allAssignments = await AgentToolModel.findAll({
        skipPagination: true,
      });
      const relevantAssignments = allAssignments.data.filter(
        (at) => at.tool.id === tool1.id,
      );
      expect(relevantAssignments).toHaveLength(0);
    });

    test("handles empty tool IDs array", async ({
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      const agent1 = await makeAgent({ name: "Agent 1" });

      // Seed and assign Archestra tools first
      await seedAndAssignArchestraTools(agent1.id);

      await AgentToolModel.bulkCreateForAgentsAndTools([agent1.id], []);

      // Should not throw and should not create any relationships beyond Archestra tools
      const agent1Tools = await AgentToolModel.findToolIdsByAgent(agent1.id);
      // Only Archestra tools should be present
      expect(agent1Tools.length).toBeGreaterThan(0);
    });
  });
});
