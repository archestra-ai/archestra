import { beforeEach, describe, expect, test } from "@/test";
import AgentModel from "./agent";
import McpToolCallModel from "./mcp-tool-call";

describe("McpToolCallModel", () => {
  let agentId: string;

  beforeEach(async ({ makeAgent }) => {
    // Create test agent
    const agent = await makeAgent();
    agentId = agent.id;
  });

  describe("create", () => {
    test("can create an MCP tool call", async () => {
      const mcpToolCall = await McpToolCallModel.create({
        agentId,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: {
          id: "test-id-1",
          name: "testTool",
          arguments: { param1: "value1" },
        },
        toolResult: {
          isError: false,
          content: "Success",
        },
      });

      expect(mcpToolCall).toBeDefined();
      expect(mcpToolCall.id).toBeDefined();
      expect(mcpToolCall.agentId).toBe(agentId);
      expect(mcpToolCall.mcpServerName).toBe("test-server");
      expect(mcpToolCall.method).toBe("tools/call");
    });
  });

  describe("findById", () => {
    test("returns MCP tool call by id", async () => {
      const created = await McpToolCallModel.create({
        agentId,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: { id: "test-id", name: "testTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      const found = await McpToolCallModel.findById(created.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });

    test("returns null for non-existent id", async () => {
      const found = await McpToolCallModel.findById(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(found).toBeNull();
    });
  });

  describe("date range filtering", () => {
    test("filters by startDate", async ({ makeAdmin }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Create an MCP tool call
      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: { id: "test-id", name: "testTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      // Filter for tool calls from yesterday onwards
      const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const toolCalls = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { startDate },
      );

      expect(toolCalls.data.length).toBeGreaterThanOrEqual(1);
    });

    test("filters by endDate", async ({ makeAdmin }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Create an MCP tool call
      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: { id: "test-id", name: "testTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      // Filter for tool calls before a past date (should exclude all current tool calls)
      const pastDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const toolCalls = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { endDate: pastDate },
      );

      // Should not include the just-created tool call
      expect(
        toolCalls.data.every(
          (tc) => new Date(tc.createdAt).getTime() <= pastDate.getTime(),
        ),
      ).toBe(true);
    });

    test("filters by date range (startDate and endDate)", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Create an MCP tool call
      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: { id: "test-id", name: "testTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      // Filter for tool calls in a date range that includes now
      const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const endDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const toolCalls = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { startDate, endDate },
      );

      expect(toolCalls.data.length).toBeGreaterThanOrEqual(1);
      expect(
        toolCalls.data.every((tc) => {
          const createdAt = new Date(tc.createdAt).getTime();
          return (
            createdAt >= startDate.getTime() && createdAt <= endDate.getTime()
          );
        }),
      ).toBe(true);
    });
  });

  describe("getAllMcpToolCallsForAgentPaginated with date filtering", () => {
    test("filters by date range for specific agent", async () => {
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      // Create an MCP tool call
      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: { id: "test-id", name: "testTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      // Filter for tool calls in a date range that includes now
      const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const endDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const toolCalls =
        await McpToolCallModel.getAllMcpToolCallsForAgentPaginated(
          agent.id,
          { limit: 100, offset: 0 },
          undefined,
          undefined,
          { startDate, endDate },
        );

      expect(toolCalls.data.length).toBeGreaterThanOrEqual(1);
      expect(toolCalls.data.every((tc) => tc.agentId === agent.id)).toBe(true);
    });
  });

  describe("search filtering", () => {
    test("searches by mcpServerName (case insensitive)", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "MyTestServer",
        method: "tools/call",
        toolCall: { id: "test-id", name: "someTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "OtherServer",
        method: "tools/call",
        toolCall: { id: "test-id-2", name: "otherTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      // Search with lowercase
      const toolCalls = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { search: "mytestserver" },
      );

      expect(toolCalls.data).toHaveLength(1);
      expect(toolCalls.data[0].mcpServerName).toBe("MyTestServer");
    });

    test("searches by tool name (case insensitive)", async ({ makeAdmin }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "server1",
        method: "tools/call",
        toolCall: { id: "test-id", name: "FileSearchTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "server2",
        method: "tools/call",
        toolCall: { id: "test-id-2", name: "EmailSender", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      // Search with mixed case
      const toolCalls = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { search: "filesearch" },
      );

      expect(toolCalls.data).toHaveLength(1);
      expect(toolCalls.data[0].toolCall?.name).toBe("FileSearchTool");
    });

    test("searches by tool arguments", async ({ makeAdmin }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "server1",
        method: "tools/call",
        toolCall: {
          id: "test-id",
          name: "searchTool",
          arguments: { query: "important document", maxResults: 10 },
        },
        toolResult: { isError: false, content: "Success" },
      });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "server2",
        method: "tools/call",
        toolCall: {
          id: "test-id-2",
          name: "otherTool",
          arguments: { path: "/some/path" },
        },
        toolResult: { isError: false, content: "Success" },
      });

      // Search by argument value
      const toolCalls = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { search: "important document" },
      );

      expect(toolCalls.data).toHaveLength(1);
      expect(toolCalls.data[0].toolCall?.name).toBe("searchTool");
    });

    test("searches by method field (case insensitive)", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "server1",
        method: "tools/call",
        toolCall: { id: "test-id", name: "someTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "server2",
        method: "tools/list",
        toolCall: null,
        toolResult: { tools: [{ name: "tool1" }] },
      });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "server3",
        method: "initialize",
        toolCall: null,
        toolResult: { capabilities: {} },
      });

      // Search with mixed case
      const toolCalls = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { search: "TOOLS/LIST" },
      );

      expect(toolCalls.data).toHaveLength(1);
      expect(toolCalls.data[0].method).toBe("tools/list");
    });

    test("searches by toolResult content (case insensitive)", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "server1",
        method: "tools/call",
        toolCall: { id: "test-id", name: "searchTool", arguments: {} },
        toolResult: {
          isError: false,
          content: "Found UniqueResultContent12345 in the database",
        },
      });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "server2",
        method: "tools/call",
        toolCall: { id: "test-id-2", name: "otherTool", arguments: {} },
        toolResult: { isError: false, content: "Normal result" },
      });

      // Search by tool result content
      const toolCalls = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { search: "uniqueresultcontent12345" },
      );

      expect(toolCalls.data).toHaveLength(1);
      expect(toolCalls.data[0].toolCall?.name).toBe("searchTool");
    });

    test("searches by toolResult with structured data", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "server1",
        method: "tools/list",
        toolCall: null,
        toolResult: {
          tools: [
            { name: "SearchableToolInResult999", description: "A tool" },
            { name: "AnotherTool", description: "Another tool" },
          ],
        },
      });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "server2",
        method: "tools/list",
        toolCall: null,
        toolResult: {
          tools: [{ name: "RegularTool", description: "Regular tool" }],
        },
      });

      // Search for a tool name that appears in the result structure
      const toolCalls = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { search: "SearchableToolInResult999" },
      );

      expect(toolCalls.data).toHaveLength(1);
      expect(toolCalls.data[0].mcpServerName).toBe("server1");
    });

    test("search returns multiple matches", async ({ makeAdmin }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "file-server",
        method: "tools/call",
        toolCall: { id: "test-id", name: "readFile", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "other-server",
        method: "tools/call",
        toolCall: { id: "test-id-2", name: "writeFile", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "unrelated",
        method: "tools/call",
        toolCall: { id: "test-id-3", name: "sendEmail", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      // Search for "file" - should match server name and tool names
      const toolCalls = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { search: "file" },
      );

      expect(toolCalls.data).toHaveLength(2);
    });

    test("search with no matches returns empty", async ({ makeAdmin }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: { id: "test-id", name: "testTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      const toolCalls = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { search: "nonexistent" },
      );

      expect(toolCalls.data).toHaveLength(0);
    });

    test("search works with getAllMcpToolCallsForAgentPaginated", async () => {
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "DatabaseServer",
        method: "tools/call",
        toolCall: { id: "test-id", name: "queryTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "OtherServer",
        method: "tools/call",
        toolCall: { id: "test-id-2", name: "otherTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      const toolCalls =
        await McpToolCallModel.getAllMcpToolCallsForAgentPaginated(
          agent.id,
          { limit: 100, offset: 0 },
          undefined,
          undefined,
          { search: "database" },
        );

      expect(toolCalls.data).toHaveLength(1);
      expect(toolCalls.data[0].mcpServerName).toBe("DatabaseServer");
    });

    test("search combined with date filter", async ({ makeAdmin }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({ name: "Agent", teams: [] });

      await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "TargetServer",
        method: "tools/call",
        toolCall: { id: "test-id", name: "targetTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const endDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const toolCalls = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { search: "target", startDate, endDate },
      );

      expect(toolCalls.data.length).toBeGreaterThanOrEqual(1);
      expect(toolCalls.data[0].mcpServerName).toBe("TargetServer");
    });
  });

  describe("preserves MCP tool calls when agent is deleted", () => {
    test("MCP tool call is preserved with null agentId when agent is deleted", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();
      const agent = await AgentModel.create({
        name: "Agent To Delete",
        teams: [],
      });

      // Create an MCP tool call for the agent
      const toolCall = await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: { id: "test-id", name: "testTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      // Delete the agent
      await AgentModel.delete(agent.id);

      // Admin should still be able to see the tool call with null agentId
      const found = await McpToolCallModel.findById(
        toolCall.id,
        admin.id,
        true,
      );

      expect(found).toBeDefined();
      expect(found?.id).toBe(toolCall.id);
      expect(found?.agentId).toBeNull();
      expect(found?.mcpServerName).toBe("test-server");
    });

    test("non-admin cannot see MCP tool call with deleted agent (null agentId)", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      // Give user access to the team
      const team = await makeTeam(org.id, admin.id);
      const TeamModel = (await import("./team")).default;
      await TeamModel.addMember(team.id, user.id);

      const agent = await AgentModel.create({
        name: "Agent To Delete",
        teams: [team.id],
      });

      // Create an MCP tool call for the agent
      const toolCall = await McpToolCallModel.create({
        agentId: agent.id,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: { id: "test-id", name: "testTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      // User can see the tool call before agent deletion
      const beforeDelete = await McpToolCallModel.findById(
        toolCall.id,
        user.id,
        false,
      );
      expect(beforeDelete).not.toBeNull();

      // Delete the agent
      await AgentModel.delete(agent.id);

      // Non-admin should NOT see the tool call with null agentId
      const afterDelete = await McpToolCallModel.findById(
        toolCall.id,
        user.id,
        false,
      );
      expect(afterDelete).toBeNull();

      // But admin should still see it
      const adminView = await McpToolCallModel.findById(
        toolCall.id,
        admin.id,
        true,
      );
      expect(adminView).not.toBeNull();
      expect(adminView?.agentId).toBeNull();
    });

    test("findAllPaginated includes MCP tool calls with deleted agents for admin", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();
      const agentToDelete = await AgentModel.create({
        name: "Agent To Delete",
        teams: [],
      });
      const agentToKeep = await AgentModel.create({
        name: "Agent To Keep",
        teams: [],
      });

      // Create tool calls for both agents
      await McpToolCallModel.create({
        agentId: agentToDelete.id,
        mcpServerName: "deleted-server",
        method: "tools/call",
        toolCall: { id: "test-id", name: "testTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      await McpToolCallModel.create({
        agentId: agentToKeep.id,
        mcpServerName: "kept-server",
        method: "tools/call",
        toolCall: { id: "test-id-2", name: "testTool", arguments: {} },
        toolResult: { isError: false, content: "Success" },
      });

      // Delete one agent
      await AgentModel.delete(agentToDelete.id);

      // Admin should see both tool calls
      const toolCalls = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
      );

      expect(toolCalls.data).toHaveLength(2);

      const deletedAgentCall = toolCalls.data.find(
        (tc) => tc.mcpServerName === "deleted-server",
      );
      const existingAgentCall = toolCalls.data.find(
        (tc) => tc.mcpServerName === "kept-server",
      );

      expect(deletedAgentCall).toBeDefined();
      expect(deletedAgentCall?.agentId).toBeNull();

      expect(existingAgentCall).toBeDefined();
      expect(existingAgentCall?.agentId).toBe(agentToKeep.id);
    });
  });
});
