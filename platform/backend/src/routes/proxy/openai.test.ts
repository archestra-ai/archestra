import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { z } from "zod";
import config from "@/config";
import { AgentModel, AgentToolModel, ToolModel } from "@/models";
import type { OpenAi } from "@/types";
import openAiProxyRoutes, { injectTools } from "./openai";

describe("OpenAI injectTools", () => {
  let agentId: string;

  beforeEach(async () => {
    const agent = await AgentModel.create({ name: "Test Agent", teams: [] });
    agentId = agent.id;
  });

  describe("basic functionality", () => {
    test("returns empty array when no assigned tools and no request tools", async () => {
      const result = await injectTools(undefined, agentId);
      expect(result).toEqual([]);
    });

    test("returns request tools when no assigned tools exist", async () => {
      const requestTools: z.infer<typeof OpenAi.Tools.ToolSchema>[] = [
        {
          type: "function",
          function: {
            name: "test_tool",
            description: "A test tool",
            parameters: { type: "object", properties: {} },
          },
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
        type: "function",
        function: {
          name: "assigned_tool",
          description: "An assigned tool",
          parameters: {
            type: "object",
            properties: { param1: { type: "string" } },
          },
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

      const requestTools: z.infer<typeof OpenAi.Tools.ToolSchema>[] = [
        {
          type: "function",
          function: {
            name: "request_tool",
            description: "A request tool",
            parameters: { type: "object" },
          },
        },
      ];

      const result = await injectTools(requestTools, agentId);

      expect(result).toHaveLength(2);
      const toolNames = result.map((tool) =>
        tool.type === "function" ? tool.function.name : tool.custom.name,
      );
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

      const requestTools: z.infer<typeof OpenAi.Tools.ToolSchema>[] = [
        {
          type: "function",
          function: {
            name: "shared_tool",
            description: "Request version",
            parameters: {
              type: "object",
              properties: { request: { type: "boolean" } },
            },
          },
        },
      ];

      const result = await injectTools(requestTools, agentId);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: "function",
        function: {
          name: "shared_tool",
          description: "Assigned version",
          parameters: {
            type: "object",
            properties: { assigned: { type: "boolean" } },
          },
        },
      });
    });

    test("assigned tools override custom tools with same name", async () => {
      // Create assigned tool
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "shared_custom_tool",
        description: "Assigned version",
        parameters: { type: "object" },
      });

      const tool = await ToolModel.findByName("shared_custom_tool");
      if (!tool) throw new Error("Tool not found");
      await AgentToolModel.createIfNotExists(agentId, tool.id);

      const requestTools: z.infer<typeof OpenAi.Tools.ToolSchema>[] = [
        {
          type: "custom",
          custom: {
            name: "shared_custom_tool",
            description: "Request custom version",
            format: { type: "text" },
          },
        },
      ];

      const result = await injectTools(requestTools, agentId);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: "function",
        function: {
          name: "shared_custom_tool",
          description: "Assigned version",
          parameters: { type: "object" },
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
      if (!tool1 || !tool2) throw new Error("Tool not found");
      await AgentToolModel.createIfNotExists(agentId, tool1.id);
      await AgentToolModel.createIfNotExists(agentId, tool2.id);

      const requestTools: z.infer<typeof OpenAi.Tools.ToolSchema>[] = [
        {
          type: "function",
          function: {
            name: "request_tool_1",
            description: "First request tool",
            parameters: { type: "object" },
          },
        },
        {
          type: "custom",
          custom: {
            name: "request_tool_2",
            description: "Second request tool",
            format: { type: "text" },
          },
        },
      ];

      const result = await injectTools(requestTools, agentId);

      expect(result).toHaveLength(4);
      const toolNames = result.map((tool) =>
        tool.type === "function" ? tool.function.name : tool.custom.name,
      );
      expect(toolNames).toContain("assigned_tool_1");
      expect(toolNames).toContain("assigned_tool_2");
      expect(toolNames).toContain("request_tool_1");
      expect(toolNames).toContain("request_tool_2");
    });
  });

  describe("OpenAI tool format conversion", () => {
    test("assigned MCP tools are converted to function tool format with correct fields", async () => {
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
        type: "function",
        function: {
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

      const result = await injectTools(undefined, agentId);

      expect(result).toHaveLength(1);
      if (result[0].type === "function") {
        expect(result[0].function.description).toBeUndefined();
      }
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

      const result = await injectTools(undefined, agentId);

      expect(result).toHaveLength(1);
      if (result[0].type === "function") {
        expect(result[0].function.description).toBeUndefined();
      }
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
        type: "function",
        function: {
          name: "tool_empty_params",
          description: "Tool with empty params",
          parameters: {},
        },
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
        type: "function",
        function: {
          name: "tool_null_params",
          description: "Tool with null params",
          parameters: {},
        },
      });
    });
  });

  describe("OpenAI tool name extraction", () => {
    test("correctly extracts names from function tools", async () => {
      const requestTools: z.infer<typeof OpenAi.Tools.ToolSchema>[] = [
        {
          type: "function",
          function: {
            name: "function_tool",
            description: "A function tool",
            parameters: { type: "object" },
          },
        },
      ];

      const result = await injectTools(requestTools, agentId);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(requestTools[0]);
    });

    test("correctly extracts names from custom tools", async () => {
      const requestTools: z.infer<typeof OpenAi.Tools.ToolSchema>[] = [
        {
          type: "custom",
          custom: {
            name: "custom_tool",
            description: "A custom tool",
            format: { type: "text" },
          },
        },
      ];

      const result = await injectTools(requestTools, agentId);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(requestTools[0]);
    });

    test("handles mixed function and custom tools", async () => {
      const requestTools: z.infer<typeof OpenAi.Tools.ToolSchema>[] = [
        {
          type: "function",
          function: {
            name: "function_tool",
            description: "A function tool",
            parameters: { type: "object" },
          },
        },
        {
          type: "custom",
          custom: {
            name: "custom_tool",
            description: "A custom tool",
            format: { type: "text" },
          },
        },
      ];

      const result = await injectTools(requestTools, agentId);

      expect(result).toHaveLength(2);
      expect(result).toEqual(requestTools);
    });
  });

  describe("edge cases", () => {
    test("handles empty request tools array", async () => {
      const result = await injectTools([], agentId);
      expect(result).toEqual([]);
    });

    test("handles multiple tools with same name in request tools", async () => {
      // This tests the implementation handles duplicate names in request tools gracefully
      const requestTools: z.infer<typeof OpenAi.Tools.ToolSchema>[] = [
        {
          type: "function",
          function: {
            name: "duplicate_tool",
            description: "First version",
            parameters: { version: 1 },
          },
        },
        {
          type: "function",
          function: {
            name: "duplicate_tool",
            description: "Second version",
            parameters: { version: 2 },
          },
        },
      ];

      const result = await injectTools(requestTools, agentId);

      // The map implementation should keep the last one
      expect(result).toHaveLength(1);
      if (result[0].type === "function") {
        expect(result[0].function.parameters).toEqual({ version: 2 });
      }
    });

    test("handles function tool overriding custom tool with same name", async () => {
      const requestTools: z.infer<typeof OpenAi.Tools.ToolSchema>[] = [
        {
          type: "custom",
          custom: {
            name: "shared_name",
            description: "Custom version",
            format: { type: "text" },
          },
        },
        {
          type: "function",
          function: {
            name: "shared_name",
            description: "Function version",
            parameters: { type: "object" },
          },
        },
      ];

      const result = await injectTools(requestTools, agentId);

      // The function tool should override the custom tool
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: "function",
        function: {
          name: "shared_name",
          description: "Function version",
          parameters: { type: "object" },
        },
      });
    });

    test("assigned tools are always function type regardless of request tool type", async () => {
      // Create assigned tool
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "assigned_func",
        description: "Assigned function",
        parameters: { type: "object" },
      });

      const tool = await ToolModel.findByName("assigned_func");
      if (!tool) throw new Error("Tool not found");
      await AgentToolModel.createIfNotExists(agentId, tool.id);

      const requestTools: z.infer<typeof OpenAi.Tools.ToolSchema>[] = [
        {
          type: "custom",
          custom: {
            name: "assigned_func",
            description: "This should be overridden",
            format: { type: "text" },
          },
        },
      ];

      const result = await injectTools(requestTools, agentId);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: "function",
        function: {
          name: "assigned_func",
          description: "Assigned function",
          parameters: { type: "object" },
        },
      });
    });
  });
});

describe("OpenAI proxy streaming", () => {
  let response: Awaited<ReturnType<FastifyInstance["inject"]>>;
  let chunks: OpenAi.Types.ChatCompletionChunk[] = [];
  beforeEach(async () => {
    // Create a test Fastify app
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(openAiProxyRoutes);
    config.benchmark.mockMode = true;

    // Make a streaming request to the route
    response = await app.inject({
      method: "POST",
      url: "/v1/openai/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      },
    });

    chunks = response.body
      .split("\n")
      .filter(
        (line: string) => line.startsWith("data: ") && line !== "data: [DONE]",
      )
      .map((line: string) => JSON.parse(line.substring(6))); // Remove 'data: ' prefix
  });
  test("response has stream content type", async () => {
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
  });
  test("first chunk has role", () => {
    const firstChunk = chunks[0];
    expect(firstChunk.choices[0].delta).toHaveProperty("role", "assistant");
  });
  test("last chunk has finish reason", () => {
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.choices[0]).toHaveProperty("finish_reason");
  });
});

describe("OpenAI proxy routing", () => {
  let app: FastifyInstance;
  let mockUpstream: FastifyInstance;
  let upstreamPort: number;

  beforeEach(async () => {
    // Create a mock upstream server
    mockUpstream = Fastify();

    // Mock OpenAI models endpoint
    mockUpstream.get("/v1/models", async () => ({
      object: "list",
      data: [
        {
          id: "gpt-4",
          object: "model",
          created: 1687882411,
          owned_by: "openai",
        },
        {
          id: "gpt-3.5-turbo",
          object: "model",
          created: 1677610602,
          owned_by: "openai",
        },
      ],
    }));

    // Mock other endpoints
    mockUpstream.get("/v1/models/:model", async (request) => ({
      id: (request.params as { model: string }).model,
      object: "model",
      created: 1687882411,
      owned_by: "openai",
    }));

    await mockUpstream.listen({ port: 0 });
    const address = mockUpstream.server.address();
    upstreamPort = typeof address === "string" ? 0 : address?.port || 0;

    // Create test app with proxy pointing to mock upstream
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Override the upstream URL to point to our mock server
    const originalBaseUrl = config.llm.openai.baseUrl;
    config.llm.openai.baseUrl = `http://localhost:${upstreamPort}`;

    // Register routes with a modified version that uses the mock upstream
    await app.register(async (fastify) => {
      const fastifyHttpProxy = (await import("@fastify/http-proxy")).default;
      const API_PREFIX = "/v1/openai";
      const CHAT_COMPLETIONS_SUFFIX = "chat/completions";

      await fastify.register(fastifyHttpProxy, {
        upstream: `http://localhost:${upstreamPort}`,
        prefix: API_PREFIX,
        rewritePrefix: "/v1",
        preHandler: (request, _reply, next) => {
          if (
            request.method === "POST" &&
            request.url.includes(CHAT_COMPLETIONS_SUFFIX)
          ) {
            next(new Error("skip"));
            return;
          }

          const pathAfterPrefix = request.url.replace(API_PREFIX, "");
          const uuidMatch = pathAfterPrefix.match(
            /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i,
          );

          if (uuidMatch) {
            const remainingPath = uuidMatch[2] || "";
            request.raw.url = `${API_PREFIX}${remainingPath}`;
          }

          next();
        },
      });
    });

    // Restore original config after registration
    config.llm.openai.baseUrl = originalBaseUrl;
  });

  afterEach(async () => {
    await app.close();
    await mockUpstream.close();
  });

  test("proxies /v1/openai/models without UUID", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/openai/models",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(2);
  });

  test("strips UUID and proxies /v1/openai/:uuid/models", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/openai/44f56e01-7167-42c1-88ee-64b566fbc34d/models",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(2);
  });

  test("strips UUID and proxies /v1/openai/:uuid/models/:model", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/openai/44f56e01-7167-42c1-88ee-64b566fbc34d/models/gpt-4",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.id).toBe("gpt-4");
    expect(body.object).toBe("model");
  });

  test("does not strip non-UUID segments", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/openai/not-a-uuid/models",
    });

    // This should try to proxy to /v1/not-a-uuid/models which won't exist
    expect(response.statusCode).toBe(404);
  });

  test("skips proxy for chat/completions routes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/openai/chat/completions",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello!" }],
      },
    });

    // Should get 404 or 500 because we didn't register the actual chat/completions handler
    // This confirms the proxy was skipped (next(new Error("skip")) throws error)
    expect([404, 500]).toContain(response.statusCode);
  });

  test("skips proxy for chat/completions routes with UUID", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/openai/44f56e01-7167-42c1-88ee-64b566fbc34d/chat/completions",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello!" }],
      },
    });

    // Should get 404 or 500 because we didn't register the actual chat/completions handler
    // This confirms the proxy was skipped (next(new Error("skip")) throws error)
    expect([404, 500]).toContain(response.statusCode);
  });
});
