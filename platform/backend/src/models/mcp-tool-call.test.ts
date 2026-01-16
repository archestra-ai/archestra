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
});
