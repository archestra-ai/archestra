import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { ToolModel } from "@/models";
import { type Tool, UuidIdSchema } from "@/types";

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
    logging?: {};
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

const archestraMcpServerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const { endpoint: endpointPrefix } = config.archestraMcpServer;
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

export default archestraMcpServerRoutes;
