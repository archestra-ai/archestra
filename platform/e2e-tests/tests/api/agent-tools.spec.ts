import { expect, test } from "./fixtures";
import { assignArchestraToolsToProfile } from "./mcp-gateway-utils";

test.describe("Agent Tools API", () => {
  test.describe("GET /api/agent-tools", () => {
    test("returns paginated results by default", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/agent-tools?limit=5",
      });
      const result = await response.json();

      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("pagination");
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.pagination).toHaveProperty("limit", 5);
      expect(result.pagination).toHaveProperty("total");
      expect(result.pagination).toHaveProperty("currentPage");
      expect(result.pagination).toHaveProperty("totalPages");
      expect(result.pagination).toHaveProperty("hasNext");
      expect(result.pagination).toHaveProperty("hasPrev");
    });

    test("filters by agentId while respecting pagination", async ({
      request,
      createAgent,
      makeApiRequest,
    }) => {
      // Create an agent
      const agentResponse = await createAgent(
        request,
        "Test Agent for Filtering",
      );
      const agent = await agentResponse.json();

      // Query agent tools with agentId filter
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/agent-tools?agentId=${agent.id}&limit=10`,
      });
      const result = await response.json();

      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("pagination");
      // All returned tools should belong to the filtered agent
      result.data.forEach(
        (at: { agent: { id: string }; tool: { name: string } }) => {
          expect(at.agent.id).toBe(agent.id);
        },
      );
      // Pagination should still work (not be skipped automatically)
      expect(result.pagination.limit).toBe(10);
    });

    test("skipPagination=true returns all results without pagination limits", async ({
      request,
      createAgent,
      makeApiRequest,
    }) => {
      // Create an agent
      const agentResponse = await createAgent(
        request,
        "Test Agent for Skip Pagination",
      );
      const agent = await agentResponse.json();

      // Assign Archestra tools to the agent so we have tools to test with
      const assignedTools = await assignArchestraToolsToProfile(
        request,
        agent.id,
      );
      expect(assignedTools.length).toBeGreaterThan(0);

      // Query agent tools with skipPagination=true
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/agent-tools?agentId=${agent.id}&skipPagination=true&limit=1`,
      });
      const result = await response.json();

      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("pagination");
      // Even with limit=1, skipPagination should return all tools
      // The pagination metadata should reflect the full dataset
      expect(result.pagination.totalPages).toBe(1);
      expect(result.pagination.hasNext).toBe(false);
      // All data should be returned
      expect(result.pagination.total).toBe(result.data.length);
      // Verify we have the tools we assigned
      expect(result.data.length).toBe(assignedTools.length);
    });

    test("skipPagination respects other filters like agentId", async ({
      request,
      createAgent,
      makeApiRequest,
    }) => {
      // Create two agents
      const agent1Response = await createAgent(request, "Test Agent 1");
      const agent1 = await agent1Response.json();

      const agent2Response = await createAgent(request, "Test Agent 2");
      const agent2 = await agent2Response.json();

      // Query with skipPagination for agent1 only
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/agent-tools?agentId=${agent1.id}&skipPagination=true`,
      });
      const result = await response.json();

      // All results should belong to agent1
      result.data.forEach(
        (at: { agent: { id: string }; tool: { name: string } }) => {
          expect(at.agent.id).toBe(agent1.id);
          expect(at.agent.id).not.toBe(agent2.id);
        },
      );
    });

    test("skipPagination=false (default) uses normal pagination", async ({
      request,
      makeApiRequest,
    }) => {
      // Query without skipPagination - should use normal pagination
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/agent-tools?limit=2&offset=0",
      });
      const result = await response.json();

      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("pagination");
      expect(result.pagination.limit).toBe(2);
      // If there are more than 2 total records, hasNext should be true
      if (result.pagination.total > 2) {
        expect(result.pagination.hasNext).toBe(true);
      }
    });

    test("excludeArchestraTools filter works with skipPagination", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix:
          "/api/agent-tools?skipPagination=true&excludeArchestraTools=true",
      });
      const result = await response.json();

      // No tools should have names starting with "archestra__"
      result.data.forEach((at: { tool: { name: string } }) => {
        expect(at.tool.name.startsWith("archestra__")).toBe(false);
      });
    });
  });
});
