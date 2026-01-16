import { beforeEach, describe, expect, test } from "@/test";
import AgentModel from "./agent";
import McpToolCallModel from "./mcp-tool-call";
import TeamModel from "./team";

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
          id: "call_1",
          name: "read_file",
          arguments: { path: "/tmp/test.txt" },
        },
        toolResult: {
          content: "File contents here",
          isError: false,
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
        toolCall: { id: "call_1", name: "test_tool", arguments: {} },
        toolResult: { content: "result", isError: false },
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

  describe("findAllPaginated search filter", () => {
    test("searches in tool name (case-insensitive)", async ({ makeAdmin }) => {
      const admin = await makeAdmin();

      // Create tool call with specific tool name
      await McpToolCallModel.create({
        agentId,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: {
          id: "call_1",
          name: "IMPORTANT_TOOL",
          arguments: { query: "test" },
        },
        toolResult: { content: "result", isError: false },
      });

      // Create tool call with different tool name
      await McpToolCallModel.create({
        agentId,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: {
          id: "call_2",
          name: "other_tool",
          arguments: { query: "test" },
        },
        toolResult: { content: "result", isError: false },
      });

      // Search with lowercase should find uppercase match
      const results = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { search: "important" },
      );

      expect(results.data).toHaveLength(1);
      expect(results.data[0].toolCall?.name).toBe("IMPORTANT_TOOL");
    });

    test("searches in tool arguments", async ({ makeAdmin }) => {
      const admin = await makeAdmin();

      await McpToolCallModel.create({
        agentId,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: {
          id: "call_1",
          name: "read_file",
          arguments: { path: "/path/to/SECRET_FILE.txt" },
        },
        toolResult: { content: "result", isError: false },
      });

      await McpToolCallModel.create({
        agentId,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: {
          id: "call_2",
          name: "read_file",
          arguments: { path: "/path/to/other.txt" },
        },
        toolResult: { content: "result", isError: false },
      });

      const results = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { search: "secret_file" },
      );

      expect(results.data).toHaveLength(1);
    });

    test("searches in tool result content", async ({ makeAdmin }) => {
      const admin = await makeAdmin();

      await McpToolCallModel.create({
        agentId,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: { id: "call_1", name: "read_file", arguments: {} },
        toolResult: {
          content: "This contains UNIQUE_RESULT_STRING",
          isError: false,
        },
      });

      await McpToolCallModel.create({
        agentId,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: { id: "call_2", name: "read_file", arguments: {} },
        toolResult: { content: "Normal content", isError: false },
      });

      const results = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { search: "unique_result_string" },
      );

      expect(results.data).toHaveLength(1);
    });

    test("searches in MCP server name", async ({ makeAdmin }) => {
      const admin = await makeAdmin();

      await McpToolCallModel.create({
        agentId,
        mcpServerName: "SPECIAL_MCP_SERVER",
        method: "tools/call",
        toolCall: { id: "call_1", name: "tool", arguments: {} },
        toolResult: { content: "result", isError: false },
      });

      await McpToolCallModel.create({
        agentId,
        mcpServerName: "regular-server",
        method: "tools/call",
        toolCall: { id: "call_2", name: "tool", arguments: {} },
        toolResult: { content: "result", isError: false },
      });

      const results = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { search: "special_mcp" },
      );

      expect(results.data).toHaveLength(1);
      expect(results.data[0].mcpServerName).toBe("SPECIAL_MCP_SERVER");
    });

    test("returns empty results when search term not found", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();

      await McpToolCallModel.create({
        agentId,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: { id: "call_1", name: "tool", arguments: {} },
        toolResult: { content: "result", isError: false },
      });

      const results = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        admin.id,
        true,
        { search: "nonexistent_xyz_999" },
      );

      expect(results.data).toHaveLength(0);
    });

    test("search respects access control for non-admin users", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      const team = await makeTeam(org.id, admin.id);
      await TeamModel.addMember(team.id, user.id);

      const accessibleAgent = await AgentModel.create({
        name: "Accessible Agent",
        teams: [team.id],
      });
      const inaccessibleAgent = await AgentModel.create({
        name: "Inaccessible Agent",
        teams: [],
      });

      // Create tool calls with same search term in both agents
      await McpToolCallModel.create({
        agentId: accessibleAgent.id,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: { id: "call_1", name: "ACCESS_TEST_TOOL", arguments: {} },
        toolResult: { content: "result", isError: false },
      });

      await McpToolCallModel.create({
        agentId: inaccessibleAgent.id,
        mcpServerName: "test-server",
        method: "tools/call",
        toolCall: { id: "call_2", name: "ACCESS_TEST_TOOL", arguments: {} },
        toolResult: { content: "result", isError: false },
      });

      // Non-admin user should only see accessible agent's tool call
      const results = await McpToolCallModel.findAllPaginated(
        { limit: 100, offset: 0 },
        undefined,
        user.id,
        false,
        { search: "access_test" },
      );

      expect(results.data).toHaveLength(1);
      expect(results.data[0].agentId).toBe(accessibleAgent.id);
    });
  });

  describe("getAllMcpToolCallsForAgent", () => {
    test("returns all tool calls for a specific agent", async () => {
      const otherAgent = await AgentModel.create({
        name: "Other Agent",
        teams: [],
      });

      // Create tool calls for both agents
      await McpToolCallModel.create({
        agentId,
        mcpServerName: "server1",
        method: "tools/call",
        toolCall: { id: "call_1", name: "tool1", arguments: {} },
        toolResult: { content: "result1", isError: false },
      });

      await McpToolCallModel.create({
        agentId: otherAgent.id,
        mcpServerName: "server2",
        method: "tools/call",
        toolCall: { id: "call_2", name: "tool2", arguments: {} },
        toolResult: { content: "result2", isError: false },
      });

      const agentToolCalls =
        await McpToolCallModel.getAllMcpToolCallsForAgent(agentId);
      expect(agentToolCalls).toHaveLength(1);
      expect(agentToolCalls[0].agentId).toBe(agentId);
    });
  });
});
