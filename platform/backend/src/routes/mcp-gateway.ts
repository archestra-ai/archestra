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
  const sseEndpoint = `${endpointPrefix}/:agentId/sse`;
  const params = z.object({
    agentId: UuidIdSchema,
  });

  // Session storage (in-memory for now, could be moved to Redis/DB)
  const sessions = new Map<string, { agentId: string; createdAt: number }>();

  // Helper to generate session ID
  const generateSessionId = () => {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  };

  // Helper to send SSE event
  const formatSSEEvent = (data: unknown, eventId?: string): string => {
    let message = "";
    if (eventId) {
      message += `id: ${eventId}\n`;
    }
    message += `data: ${JSON.stringify(data)}\n\n`;
    return message;
  };

  // GET endpoint for SSE stream (MCP Streamable HTTP transport)
  const handleGet = async (request: any, reply: any) => {
    const { agentId } = request.params;
    const acceptHeader = request.headers.accept || "";
    const sessionId = request.headers["mcp-session-id"];

    console.log("GET request", { agentId, acceptHeader, sessionId });

    // Check if client wants SSE stream
    if (acceptHeader.includes("text/event-stream")) {
      // Return SSE stream
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Keep connection alive with periodic comments
      const keepAlive = setInterval(() => {
        reply.raw.write(": keepalive\n\n");
      }, 15000);

      // Clean up on close
      request.raw.on("close", () => {
        clearInterval(keepAlive);
      });

      return reply.raw;
    }

    // Fallback: return server info as JSON
    reply.type("application/json");
    return {
      name: `archestra-agent-${agentId}`,
      version: config.api.version,
      agentId,
      transport: "streamable-http",
      capabilities: {
        tools: true,
      },
    };
  };

  // POST endpoint for JSON-RPC requests (MCP Streamable HTTP transport)
  const handlePost = async (request: any, reply: any) => {
    const { agentId } = request.params;
    const acceptHeader = request.headers.accept || "";
    let sessionId = request.headers["mcp-session-id"] as string | undefined;

    console.log("POST request", {
      agentId,
      method: request.body.method,
      sessionId,
    });

    const response = await processJsonRpcRequest(request.body, agentId);
    console.log("response", response);

    // Handle session management for initialize request
    if (request.body.method === "initialize" && !sessionId) {
      sessionId = generateSessionId();
      sessions.set(sessionId, { agentId, createdAt: Date.now() });
      console.log("Created session", sessionId);
    }

    // Check if client accepts SSE format
    const acceptsSSE = acceptHeader.includes("text/event-stream");
    const acceptsJSON = acceptHeader.includes("application/json");

    if (acceptsSSE && request.body.method !== "initialized") {
      // Return SSE format for HTTP Streamable transport
      const eventId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...(sessionId && { "Mcp-Session-Id": sessionId }),
      });

      // Send the response as SSE event
      reply.raw.write(formatSSEEvent(response, eventId));

      // Close the stream after sending the response
      reply.raw.end();

      return reply.raw;
    }

    // Default JSON response
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
    }

    reply.headers(headers);
    return response;
  };

  // Register routes for both /mcp/{agentId} and /mcp/{agentId}/sse
  fastify.get(endpoint, { schema: { params } }, handleGet);
  fastify.post(
    endpoint,
    { schema: { params, body: JsonRpcRequestSchema } },
    handlePost,
  );

  // Also register /sse variant for n8n compatibility
  fastify.get(sseEndpoint, { schema: { params } }, handleGet);
  fastify.post(
    sseEndpoint,
    { schema: { params, body: JsonRpcRequestSchema } },
    handlePost,
  );
};

export default mcpGatewayRoutes;
