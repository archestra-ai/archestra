import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import AgentToolModel from "./agent-tool";

describe("AgentToolModel.findAllPaginated", () => {
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
      const page1 = await AgentToolModel.findAllPaginated(
        { limit: 2, offset: 0 },
        undefined,
        { excludeArchestraTools: true },
      );
      expect(page1.data).toHaveLength(2);
      expect(page1.pagination.total).toBe(5);
      expect(page1.pagination.currentPage).toBe(1);
      expect(page1.pagination.totalPages).toBe(3);
      expect(page1.pagination.hasNext).toBe(true);
      expect(page1.pagination.hasPrev).toBe(false);

      // Test second page
      const page2 = await AgentToolModel.findAllPaginated(
        { limit: 2, offset: 2 },
        undefined,
        { excludeArchestraTools: true },
      );
      expect(page2.data).toHaveLength(2);
      expect(page2.pagination.currentPage).toBe(2);
      expect(page2.pagination.hasNext).toBe(true);
      expect(page2.pagination.hasPrev).toBe(true);

      // Test last page
      const page3 = await AgentToolModel.findAllPaginated(
        { limit: 2, offset: 4 },
        undefined,
        { excludeArchestraTools: true },
      );
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

      const result = await AgentToolModel.findAllPaginated(
        { limit: 3, offset: 0 },
        undefined,
        { excludeArchestraTools: true },
      );
      expect(result.data).toHaveLength(3);
      expect(result.pagination.limit).toBe(3);
      expect(result.pagination.totalPages).toBe(2);
    });

    test("handles empty results", async () => {
      const result = await AgentToolModel.findAllPaginated({
        limit: 10,
        offset: 0,
      });
      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
      expect(result.pagination.totalPages).toBe(0);
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

      const result = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        { sortBy: "name", sortDirection: "asc" },
        { excludeArchestraTools: true },
      );

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

      const result = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        { sortBy: "name", sortDirection: "desc" },
        { excludeArchestraTools: true },
      );

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

      const result = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        { sortBy: "agent", sortDirection: "asc" },
        { excludeArchestraTools: true },
      );

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

      const resultAsc = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        { sortBy: "origin", sortDirection: "asc" },
      );

      // MCP tools come first (1-mcp), LLM Proxy comes last (2-llm-proxy)
      expect(resultAsc.data[0].tool.catalogId).toBe(catalog.id);
      expect(resultAsc.data[1].tool.catalogId).toBeNull();
    });

    test("sorts by allowUsageWhenUntrustedDataIsPresent", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
    }) => {
      const agent = await makeAgent();
      const tool1 = await makeTool({ name: "tool-1" });
      const tool2 = await makeTool({ name: "tool-2" });
      const tool3 = await makeTool({ name: "tool-3" });

      await makeAgentTool(agent.id, tool1.id, {
        allowUsageWhenUntrustedDataIsPresent: true,
      });
      await makeAgentTool(agent.id, tool2.id, {
        allowUsageWhenUntrustedDataIsPresent: false,
      });
      await makeAgentTool(agent.id, tool3.id, {
        allowUsageWhenUntrustedDataIsPresent: true,
      });

      const resultAsc = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        {
          sortBy: "allowUsageWhenUntrustedDataIsPresent",
          sortDirection: "asc",
        },
        { excludeArchestraTools: true },
      );

      // false comes before true
      expect(resultAsc.data[0].allowUsageWhenUntrustedDataIsPresent).toBe(
        false,
      );
      expect(resultAsc.data[1].allowUsageWhenUntrustedDataIsPresent).toBe(true);
      expect(resultAsc.data[2].allowUsageWhenUntrustedDataIsPresent).toBe(true);

      const resultDesc = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        {
          sortBy: "allowUsageWhenUntrustedDataIsPresent",
          sortDirection: "desc",
        },
        { excludeArchestraTools: true },
      );

      // true comes before false
      expect(resultDesc.data[0].allowUsageWhenUntrustedDataIsPresent).toBe(
        true,
      );
      expect(resultDesc.data[1].allowUsageWhenUntrustedDataIsPresent).toBe(
        true,
      );
      expect(resultDesc.data[2].allowUsageWhenUntrustedDataIsPresent).toBe(
        false,
      );
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

      const result = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        { sortBy: "createdAt", sortDirection: "desc" },
        { excludeArchestraTools: true },
      );

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

      const result = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        undefined,
        { search: "file" },
      );

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

      const resultLower = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        undefined,
        { search: "readfile" },
      );

      const resultUpper = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        undefined,
        { search: "READFILE" },
      );

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

      const result = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        undefined,
        { agentId: agent1.id, excludeArchestraTools: true },
      );

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

      const result = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        undefined,
        { origin: "llm-proxy", excludeArchestraTools: true },
      );

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

      const result = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        undefined,
        { origin: catalog1.id },
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].tool.catalogId).toBe(catalog1.id);
    });

    test("filters by credentialSourceMcpServerId", async ({
      makeAgent,
      makeTool,
      makeAgentTool,
      makeMcpServer,
    }) => {
      const agent = await makeAgent();
      const server1 = await makeMcpServer({ name: "Server 1" });
      const server2 = await makeMcpServer({ name: "Server 2" });

      const tool1 = await makeTool({ name: "tool-1" });
      const tool2 = await makeTool({ name: "tool-2" });
      const tool3 = await makeTool({ name: "tool-3" });

      await makeAgentTool(agent.id, tool1.id, {
        credentialSourceMcpServerId: server1.id,
      });
      await makeAgentTool(agent.id, tool2.id, {
        credentialSourceMcpServerId: server2.id,
      });
      await makeAgentTool(agent.id, tool3.id);

      const result = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        undefined,
        { credentialSourceMcpServerId: server1.id },
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].credentialSourceMcpServerId).toBe(server1.id);
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

      const result = await AgentToolModel.findAllPaginated(
        { limit: 2, offset: 0 },
        { sortBy: "name", sortDirection: "asc" },
        {
          search: "read",
          agentId: agent.id,
          origin: catalog.id,
        },
      );

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

      const result = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        undefined,
        { excludeArchestraTools: true },
        admin.id,
        true,
      );

      expect(result.data).toHaveLength(2);
    });

    test("member only sees agent-tools for agents in their teams", async ({
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
      const team1 = await makeTeam(org.id, admin.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, admin.id, { name: "Team 2" });

      const agent1 = await makeAgent({ name: "Agent 1", teams: [team1.id] });
      const agent2 = await makeAgent({ name: "Agent 2", teams: [team2.id] });

      // Add user to team1 via team membership
      await db
        .insert(schema.teamMembersTable)
        .values({
          id: crypto.randomUUID(),
          teamId: team1.id,
          userId: user.id,
          role: "member",
          createdAt: new Date(),
        })
        .returning();

      const tool = await makeTool();

      await makeAgentTool(agent1.id, tool.id);
      await makeAgentTool(agent2.id, tool.id);

      const result = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        undefined,
        { excludeArchestraTools: true },
        user.id,
        false,
      );

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

      const result = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 0 },
        undefined,
        undefined,
        user.id,
        false,
      );

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

      const result = await AgentToolModel.findAllPaginated(
        { limit: 10, offset: 100 },
        undefined,
        { excludeArchestraTools: true },
      );

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

      const result = await AgentToolModel.findAllPaginated(
        { limit: 1000, offset: 0 },
        undefined,
        { excludeArchestraTools: true },
      );

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

      const result = await AgentToolModel.findAllPaginated(
        { limit: 2, offset: 0 },
        undefined,
        { search: "file" },
      );

      expect(result.data).toHaveLength(2);
      expect(result.pagination.total).toBe(3); // 3 tools match "file"
      expect(result.pagination.totalPages).toBe(2);
    });
  });
});
