import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { ToolModel } from "@/models";
import mcpClientService from "@/services/mcp-client";
import { type CommonToolCall, type Tool, UuidIdSchema } from "@/types";

/**
 * JSON-RPC 2.0 request schema
 */
const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

/**
 * JSON-RPC 2.0 response schema
 */
const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

/**
 * Transform database tool record to MCP tool format
 */
const transformToolToMcpFormat = (tool: Tool) => ({
  name: tool.name,
  description: tool.description || `Tool: ${tool.name}`,
  inputSchema: tool.parameters || {
    type: "object",
    properties: {},
    required: [],
  },
});

/**
 * Handle MCP initialize request
 */
async function handleInitialize(): Promise<{
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
    prompts?: { listChanged?: boolean };
    resources?: { listChanged?: boolean };
    logging?: Record<string, never>;
  };
  serverInfo: {
    name: string;
    version: string;
  };
}> {
  return {
    protocolVersion: "2025-06-18",
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: {
      name: "archestra-mcp-server",
      version: config.api.version,
    },
  };
}

/**
 * Handle MCP tools/list request
 */
async function handleToolsList(agentId: string): Promise<{ tools: unknown[] }> {
  try {
    const tools = await ToolModel.getToolsByAgent(agentId);
    const mcpTools = tools.map(transformToolToMcpFormat);

    return {
      tools: mcpTools,
    };
  } catch (error) {
    throw {
      code: -32603, // Internal error
      message: "Failed to fetch agent tools",
      data: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Handle MCP tools/call request
 */
async function handleToolsCall(
  toolName: string,
  toolArguments: Record<string, unknown>,
  agentId: string,
): Promise<{
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}> {
  try {
    // Generate a unique ID for this tool call
    const toolCallId = `mcp-call-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Create CommonToolCall for McpClientService
    const toolCall: CommonToolCall = {
      id: toolCallId,
      name: toolName,
      arguments: toolArguments,
    };

    // Execute the tool call via McpClientService (assumes GitHub MCP tools)
    const results = await mcpClientService.executeToolCalls(
      [toolCall],
      agentId,
    );

    if (results.length === 0) {
      throw {
        code: -32603, // Internal error
        message: `Tool '${toolName}' not found or not assigned to agent`,
      };
    }

    const result = results[0];

    if (result.isError) {
      throw {
        code: -32603, // Internal error
        message: result.error || "Tool execution failed",
      };
    }

    // Transform CommonToolResult to MCP response format
    return {
      content: Array.isArray(result.content)
        ? result.content
        : [{ type: "text", text: JSON.stringify(result.content) }],
      isError: false,
    };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      throw error; // Re-throw JSON-RPC errors
    }

    throw {
      code: -32603, // Internal error
      message: "Tool execution failed",
      data: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Process JSON-RPC request for MCP
 */
async function processJsonRpcRequest(
  request: JsonRpcRequest,
  agentId: string,
): Promise<JsonRpcResponse> {
  const response: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: request.id,
  };

  try {
    switch (request.method) {
      case "initialize":
        response.result = await handleInitialize();
        break;
      case "tools/list":
        response.result = await handleToolsList(agentId);
        break;
      case "tools/call": {
        const params = request.params;
        if (!params || typeof params !== "object") {
          response.error = {
            code: -32602, // Invalid params
            message: "Missing or invalid params for tools/call",
          };
          break;
        }

        const { name: toolName, arguments: toolArguments } = params as {
          name?: unknown;
          arguments?: unknown;
        };

        if (typeof toolName !== "string") {
          response.error = {
            code: -32602, // Invalid params
            message: "Tool name must be a string",
          };
          break;
        }

        if (typeof toolArguments !== "object" || toolArguments === null) {
          response.error = {
            code: -32602, // Invalid params
            message: "Tool arguments must be an object",
          };
          break;
        }

        response.result = await handleToolsCall(
          toolName,
          toolArguments as Record<string, unknown>,
          agentId,
        );
        break;
      }
      default:
        response.error = {
          code: -32601, // Method not found
          message: `Method '${request.method}' not found`,
        };
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      response.error = error as JsonRpcResponse["error"];
    } else {
      response.error = {
        code: -32603, // Internal error
        message: "Internal error",
        data: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  return response;
}

const mcpGatewayRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const { endpoint: endpointPrefix } = config.mcpGateway;
  const endpoint = `${endpointPrefix}/:agentId`;
  const params = z.object({
    agentId: UuidIdSchema,
  });

  // GET endpoint for SSE transport discovery/server info
  fastify.get(
    endpoint,
    {
      schema: {
        params,
        response: {
          200: z.object({
            name: z.string(),
            version: z.string(),
            agentId: z.string(),
            transport: z.string(),
            capabilities: z.object({
              tools: z.boolean(),
            }),
          }),
        },
      },
    },
    async (request, reply) => {
      reply.type("application/json");
      return {
        name: `archestra-agent-${request.params.agentId}`,
        version: config.api.version,
        agentId: request.params.agentId,
        transport: "http",
        capabilities: {
          tools: true,
        },
      };
    },
  );

  // POST endpoint for JSON-RPC requests
  fastify.post(
    endpoint,
    {
      schema: {
        params,
        body: JsonRpcRequestSchema,
        response: {
          200: JsonRpcResponseSchema,
          500: JsonRpcResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const response = await processJsonRpcRequest(
        request.body,
        request.params.agentId,
      );
      reply.type("application/json");
      return response;
    },
  );
};

export default mcpGatewayRoutes;
