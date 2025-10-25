import { beforeEach, describe, expect, test } from "vitest";
import type { z } from "zod";
import { AgentModel, AgentToolModel, ToolModel } from "@/models";
import type { Anthropic } from "@/types";
import { injectTools } from "./anthropic";

describe("Anthropic injectTools", () => {
  let agentId: string;

  beforeEach(async () => {
    // Create test agent
    const agent = await AgentModel.create({
      name: "Test Agent",
      teams: [],
    });
    agentId = agent.id;
  });

  describe("basic functionality", () => {
    test("returns empty array when no assigned tools and no request tools", async () => {
      const result = await injectTools(undefined, agentId);
      expect(result).toEqual([]);
    });

    test("returns request tools when no assigned tools exist", async () => {
      const requestTools: z.infer<typeof Anthropic.Tools.ToolSchema>[] = [
        {
          name: "test_tool",
          type: "custom",
          description: "A test tool",
          input_schema: { type: "object", properties: {} },
        },
      ];

      const result = await injectTools(requestTools, agentId);
      expect(result).toEqual(requestTools);
    });

    test("returns assigned tools when no request tools provided", async () => {
      // Create assigned tool
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "assigned_tool",
        description: "An assigned tool",
        parameters: {
          type: "object",
          properties: { param1: { type: "string" } },
        },
      });

      const tool = await ToolModel.findByName("assigned_tool");
      if (!tool) throw new Error("Tool not found");
      await AgentToolModel.createIfNotExists(agentId, tool.id);

      const result = await injectTools(undefined, agentId);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: "assigned_tool",
        type: "custom",
        description: "An assigned tool",
        input_schema: {
          type: "object",
          properties: { param1: { type: "string" } },
        },
      });
    });

    test("properly merges assigned and request tools", async () => {
      // Create assigned tool
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "assigned_tool",
        description: "An assigned tool",
        parameters: { type: "object" },
      });

      const tool = await ToolModel.findByName("assigned_tool");
      if (!tool) throw new Error("Tool not found");
      await AgentToolModel.createIfNotExists(agentId, tool.id);

      const requestTools: z.infer<typeof Anthropic.Tools.ToolSchema>[] = [
        {
          name: "request_tool",
          type: "custom",
          description: "A request tool",
          input_schema: { type: "object" },
        },
      ];

      const result = await injectTools(requestTools, agentId);

      expect(result).toHaveLength(2);
      const toolNames = result.map((tool) => tool.name);
      expect(toolNames).toContain("assigned_tool");
      expect(toolNames).toContain("request_tool");
    });
  });

  describe("tool priority", () => {
    test("assigned tools take priority over request tools with same name", async () => {
      // Create assigned tool
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "shared_tool",
        description: "Assigned version",
        parameters: {
          type: "object",
          properties: { assigned: { type: "boolean" } },
        },
      });

      const tool = await ToolModel.findByName("shared_tool");
      if (!tool) throw new Error("Tool not found");
      await AgentToolModel.createIfNotExists(agentId, tool.id);

      const requestTools: z.infer<typeof Anthropic.Tools.ToolSchema>[] = [
        {
          name: "shared_tool",
          type: "custom",
          description: "Request version",
          input_schema: {
            type: "object",
            properties: { request: { type: "boolean" } },
          },
        },
      ];

      const result = await injectTools(requestTools, agentId);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: "shared_tool",
        type: "custom",
        description: "Assigned version",
        input_schema: {
          type: "object",
          properties: { assigned: { type: "boolean" } },
        },
      });
    });

    test("different tools are merged correctly", async () => {
      // Create multiple assigned tools
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "assigned_tool_1",
        description: "First assigned tool",
        parameters: { type: "object" },
      });

      await ToolModel.createToolIfNotExists({
        agentId,
        name: "assigned_tool_2",
        description: "Second assigned tool",
        parameters: { type: "object" },
      });

      const tool1 = await ToolModel.findByName("assigned_tool_1");
      const tool2 = await ToolModel.findByName("assigned_tool_2");

      if (!tool1) throw new Error("Tool not found");
      if (!tool2) throw new Error("Tool not found");

      await AgentToolModel.createIfNotExists(agentId, tool1.id);
      await AgentToolModel.createIfNotExists(agentId, tool2.id);

      const requestTools: z.infer<typeof Anthropic.Tools.ToolSchema>[] = [
        {
          name: "request_tool_1",
          type: "custom",
          description: "First request tool",
          input_schema: { type: "object" },
        },
        {
          name: "request_tool_2",
          type: "custom",
          description: "Second request tool",
          input_schema: { type: "object" },
        },
      ];

      const result = await injectTools(requestTools, agentId);

      expect(result).toHaveLength(4);
      const toolNames = result.map((tool) => tool.name);
      expect(toolNames).toContain("assigned_tool_1");
      expect(toolNames).toContain("assigned_tool_2");
      expect(toolNames).toContain("request_tool_1");
      expect(toolNames).toContain("request_tool_2");
    });
  });

  describe("Anthropic tool format conversion", () => {
    test("assigned MCP tools are converted to CustomTool format with correct fields", async () => {
      // Create assigned tool with complex parameters
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "mcp_tool",
        description: "An MCP tool",
        parameters: {
          type: "object",
          properties: {
            input: { type: "string", description: "Input parameter" },
            count: { type: "number", minimum: 1 },
          },
          required: ["input"],
        },
      });

      const tool = await ToolModel.findByName("mcp_tool");
      if (!tool) throw new Error("Tool not found");
      await AgentToolModel.createIfNotExists(agentId, tool.id);

      const result = await injectTools(undefined, agentId);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: "mcp_tool",
        type: "custom",
        description: "An MCP tool",
        input_schema: {
          type: "object",
          properties: {
            input: { type: "string", description: "Input parameter" },
            count: { type: "number", minimum: 1 },
          },
          required: ["input"],
        },
      });
    });

    test("handles undefined description correctly", async () => {
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "tool_no_desc",
        description: undefined,
        parameters: { type: "object" },
      });

      const tool = await ToolModel.findByName("tool_no_desc");
      if (!tool) throw new Error("Tool not found");
      await AgentToolModel.createIfNotExists(agentId, tool.id);

      const result = (await injectTools(undefined, agentId)) as z.infer<
        typeof Anthropic.Tools.CustomToolSchema
      >[];

      expect(result).toHaveLength(1);
      expect(result[0].description).toBeUndefined();
    });

    test("handles null description correctly", async () => {
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "tool_null_desc",
        description: null,
        parameters: { type: "object" },
      });

      const tool = await ToolModel.findByName("tool_null_desc");
      if (!tool) throw new Error("Tool not found");
      await AgentToolModel.createIfNotExists(agentId, tool.id);

      const result = (await injectTools(undefined, agentId)) as z.infer<
        typeof Anthropic.Tools.CustomToolSchema
      >[];

      expect(result).toHaveLength(1);
      expect(result[0].description).toBeUndefined();
    });

    test("handles empty parameters correctly", async () => {
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "tool_empty_params",
        description: "Tool with empty params",
        parameters: {},
      });

      const tool = await ToolModel.findByName("tool_empty_params");
      if (!tool) throw new Error("Tool not found");
      await AgentToolModel.createIfNotExists(agentId, tool.id);

      const result = await injectTools(undefined, agentId);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: "tool_empty_params",
        type: "custom",
        description: "Tool with empty params",
        input_schema: {},
      });
    });

    test("handles null parameters correctly", async () => {
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "tool_null_params",
        description: "Tool with null params",
        parameters: undefined,
      });

      const tool = await ToolModel.findByName("tool_null_params");
      if (!tool) throw new Error("Tool not found");
      await AgentToolModel.createIfNotExists(agentId, tool.id);

      const result = await injectTools(undefined, agentId);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: "tool_null_params",
        type: "custom",
        description: "Tool with null params",
        input_schema: {},
      });
    });
  });

  describe("edge cases", () => {
    test("handles empty request tools array", async () => {
      const result = await injectTools([], agentId);
      expect(result).toEqual([]);
    });

    test("handles multiple tools with same name in request tools", async () => {
      // This tests the implementation handles duplicate names in request tools gracefully
      const requestTools: z.infer<typeof Anthropic.Tools.ToolSchema>[] = [
        {
          name: "duplicate_tool",
          type: "custom",
          description: "First version",
          input_schema: { version: 1 },
        },
        {
          name: "duplicate_tool",
          type: "custom",
          description: "Second version",
          input_schema: { version: 2 },
        },
      ];

      const result = (await injectTools(requestTools, agentId)) as z.infer<
        typeof Anthropic.Tools.CustomToolSchema
      >[];

      // The map implementation should keep the last one
      expect(result).toHaveLength(1);
      expect(result[0].input_schema).toEqual({ version: 2 });
    });

    test("handles tools with different Anthropic tool types", async () => {
      const requestTools: z.infer<typeof Anthropic.Tools.ToolSchema>[] = [
        {
          name: "bash",
          type: "bash_20250124",
        },
        {
          name: "str_replace_editor",
          type: "text_editor_20250124",
        },
        {
          name: "custom_tool",
          type: "custom",
          description: "Custom tool",
          input_schema: { type: "object" },
        },
      ];

      const result = await injectTools(requestTools, agentId);

      expect(result).toHaveLength(3);
      expect(result.map((tool) => tool.name)).toEqual([
        "bash",
        "str_replace_editor",
        "custom_tool",
      ]);
    });
  });
});
