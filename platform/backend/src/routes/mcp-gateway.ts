import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  executeArchestraTool,
  getArchestraMcpTools,
  MCP_SERVER_NAME,
} from "@/archestra-mcp-server";
import mcpClient from "@/clients/mcp-client";
import config from "@/config";
import logger from "@/logging";
import { AgentModel, ToolModel } from "@/models";
import { type CommonToolCall, UuidIdSchema } from "@/types";

/**
 * Session management types
 */
interface SessionData {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastAccess: number;
}

/**
 * Active sessions with last access time for cleanup
 * Sessions must persist across requests within the same session
 */
const activeSessions = new Map<string, SessionData>();

/**
 * Session timeout (30 minutes)
 */
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Clean up expired sessions periodically
 */
function cleanupExpiredSessions(): void {
  const now = Date.now();
  const expiredSessionIds: string[] = [];

  for (const [sessionId, sessionData] of activeSessions.entries()) {
    if (now - sessionData.lastAccess > SESSION_TIMEOUT_MS) {
      expiredSessionIds.push(sessionId);
    }
  }

  for (const sessionId of expiredSessionIds) {
    logger.info({ sessionId }, "Cleaning up expired session");
    activeSessions.delete(sessionId);
  }
}

/**
 * Create a fresh MCP server for a request
 * In stateless mode, we need to create new server instances per request
 */
async function createAgentServer(
  agentId: string,
  logger: { info: (obj: unknown, msg: string) => void },
): Promise<Server> {
  const server = new Server(
    {
      name: `archestra-agent-${agentId}`,
      version: config.api.version,
    },
    {
      capabilities: {
        tools: { listChanged: false },
      },
    },
  );

  // Get agent information
  const agent = await AgentModel.findById(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const tools = await ToolModel.getToolsByAgent(agentId);
  const archestraTools = getArchestraMcpTools();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...tools.map(({ name, description, parameters }) => ({
        name,
        title: name,
        description,
        inputSchema: parameters,
        annotations: {},
        _meta: {},
      })),
      ...archestraTools,
    ],
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params: { name, arguments: args } }) => {
      try {
        // Check if this is an Archestra tool
        const archestraToolPrefix = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}`;
        if (name.startsWith(archestraToolPrefix)) {
          logger.info(
            {
              agentId,
              toolName: name,
            },
            "Archestra MCP tool call received",
          );

          // Handle Archestra tools directly
          const archestraResponse = await executeArchestraTool(name, args, {
            agent,
          });

          logger.info(
            {
              agentId,
              toolName: name,
            },
            "Archestra MCP tool call completed",
          );

          return archestraResponse;
        }

        logger.info(
          {
            agentId,
            toolName: name,
            argumentKeys: args ? Object.keys(args) : [],
            argumentsSize: JSON.stringify(args || {}).length,
          },
          "MCP gateway tool call received",
        );

        // Generate a unique ID for this tool call
        const toolCallId = `mcp-call-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

        // Create CommonToolCall for McpClient
        const toolCall: CommonToolCall = {
          id: toolCallId,
          name,
          arguments: args || {},
        };

        // Execute the tool call via McpClient
        const results = await mcpClient.executeToolCalls([toolCall], agentId);

        if (results.length === 0) {
          throw {
            code: -32603, // Internal error
            message: `Tool '${name}' not found or not assigned to agent`,
          };
        }

        const result = results[0];

        if (result.isError) {
          logger.info(
            {
              agentId,
              toolName: name,
              error: result.error,
            },
            "MCP gateway tool call failed",
          );

          throw {
            code: -32603, // Internal error
            message: result.error || "Tool execution failed",
          };
        }

        logger.info(
          {
            agentId,
            toolName: name,
            resultContentLength: Array.isArray(result.content)
              ? JSON.stringify(result.content).length
              : typeof result.content === "string"
                ? result.content.length
                : JSON.stringify(result.content).length,
          },
          "MCP gateway tool call completed",
        );

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
    },
  );

  logger.info({ agentId }, "MCP server instance created");
  return server;
}

/**
 * Create a fresh transport for a request
 * We use session-based mode as required by the SDK for JSON responses
 */
function createTransport(
  agentId: string,
  clientSessionId: string | undefined,
  logger: { info: (obj: unknown, msg: string) => void },
): StreamableHTTPServerTransport {
  logger.info({ agentId, clientSessionId }, "Creating new transport instance");

  // Create transport with session management
  // If client provides a session ID, we'll use it; otherwise generate one
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => {
      const sessionId =
        clientSessionId || `session-${Date.now()}-${randomUUID()}`;
      logger.info(
        { agentId, sessionId, wasClientProvided: !!clientSessionId },
        "Using session ID",
      );
      return sessionId;
    },
    enableJsonResponse: true, // Use JSON responses instead of SSE
  });

  logger.info({ agentId }, "Transport instance created");
  return transport;
}

/**
 * Extract and validate agent ID from Authorization header bearer token
 */
function extractAgentIdFromAuth(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const token = match[1];

  // Validate that the token is a valid UUID (agent ID)
  try {
    const parsed = UuidIdSchema.parse(token);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Fastify route plugin for MCP gateway
 */
const mcpGatewayRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const { endpoint } = config.mcpGateway;

  // GET endpoint for server discovery
  fastify.get(
    endpoint,
    {
      schema: {
        tags: ["mcp-gateway"],
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
          401: z.object({
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const agentId = extractAgentIdFromAuth(
        request.headers.authorization as string | undefined,
      );

      if (!agentId) {
        reply.status(401);
        return {
          error: "Unauthorized",
          message:
            "Missing or invalid Authorization header. Expected: Bearer <agent-id>",
        };
      }

      reply.type("application/json");
      return {
        name: `archestra-agent-${agentId}`,
        version: config.api.version,
        agentId,
        transport: "http",
        capabilities: {
          tools: true,
        },
      };
    },
  );

  // POST endpoint for JSON-RPC requests (handled by MCP SDK)
  fastify.post(
    endpoint,
    {
      schema: {
        tags: ["mcp-gateway"],
        // Accept any JSON body - will be validated by MCP SDK
        body: z.record(z.string(), z.unknown()),
      },
    },
    async (request, reply) => {
      const agentId = extractAgentIdFromAuth(
        request.headers.authorization as string | undefined,
      );

      if (!agentId) {
        reply.status(401);
        return {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Unauthorized: Missing or invalid Authorization header. Expected: Bearer <agent-id>",
          },
          id: null,
        };
      }
      const sessionId = request.headers["mcp-session-id"] as string | undefined;
      const isInitialize =
        typeof request.body?.method === "string" &&
        request.body.method === "initialize";

      fastify.log.info(
        {
          agentId,
          sessionId,
          method: request.body?.method,
          isInitialize,
          bodyKeys: Object.keys(request.body || {}),
          bodySize: JSON.stringify(request.body || {}).length,
          allHeaders: request.headers,
        },
        "MCP gateway POST request received",
      );

      try {
        let server: Server;
        let transport: StreamableHTTPServerTransport;

        // Check if we have an existing session
        if (sessionId && activeSessions.has(sessionId)) {
          fastify.log.info(
            {
              agentId,
              sessionId,
            },
            "Reusing existing session",
          );

          const sessionData = activeSessions.get(sessionId);
          if (!sessionData) {
            throw new Error("Session data not found");
          }

          transport = sessionData.transport;
          server = sessionData.server;
          // Update last access time
          sessionData.lastAccess = Date.now();

          // If this is a re-initialize request on an existing session,
          // we can just reuse the existing server/transport
          if (isInitialize) {
            fastify.log.info(
              { agentId, sessionId },
              "Re-initialize on existing session - will reuse existing server",
            );
          }
        } else if (isInitialize) {
          // Initialize request - create new session
          // Use client-provided session ID if available
          fastify.log.info(
            {
              agentId,
              clientProvidedSessionId: sessionId,
              hasSessionId: !!sessionId,
              sessionExists: sessionId ? activeSessions.has(sessionId) : false,
              activeSessions: Array.from(activeSessions.keys()),
            },
            "Initialize request - creating NEW session",
          );
          server = await createAgentServer(agentId, fastify.log);
          transport = createTransport(agentId, sessionId, fastify.log);

          // Connect server to transport (this also starts the transport)
          fastify.log.info({ agentId }, "Connecting server to transport");
          await server.connect(transport);
          fastify.log.info({ agentId }, "Server connected to transport");

          // Store session using client-provided ID if available
          // If no client ID, we'll need to get it from transport after the request
          if (sessionId) {
            activeSessions.set(sessionId, {
              server,
              transport,
              lastAccess: Date.now(),
            });
            fastify.log.info(
              {
                agentId,
                storedSessionId: sessionId,
              },
              "Session stored with client-provided ID",
            );
          } else {
            // No client ID - will need to store after transport generates one
            // We'll do this after handleRequest completes
            fastify.log.info(
              { agentId },
              "No client session ID - will store after transport initializes",
            );
          }
        } else {
          // Non-initialize request without a valid session
          fastify.log.error(
            { agentId, sessionId, method: request.body?.method },
            "Request received without valid session",
          );
          reply.status(400);
          return {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: Invalid or expired session",
            },
            id: null,
          };
        }

        // Let the MCP SDK handle the request/response
        // Cast Fastify request/reply to Node.js types expected by SDK
        fastify.log.info(
          { agentId, sessionId },
          "Calling transport.handleRequest",
        );

        // We need to hijack Fastify's reply to let the SDK handle the raw response
        reply.hijack();

        await transport.handleRequest(
          request.raw as IncomingMessage,
          reply.raw as ServerResponse,
          request.body,
        );
        fastify.log.info(
          { agentId, sessionId },
          "Transport.handleRequest completed",
        );

        // If this was an initialize request without a client session ID,
        // store the transport's generated session ID now
        if (isInitialize && !sessionId) {
          const generatedSessionId = transport.sessionId;
          if (generatedSessionId) {
            activeSessions.set(generatedSessionId, {
              server,
              transport,
              lastAccess: Date.now(),
            });
            fastify.log.info(
              { agentId, generatedSessionId },
              "Session stored with server-generated ID",
            );
          }
        }

        fastify.log.info(
          { agentId, sessionId },
          "Request handled successfully",
        );
      } catch (error) {
        fastify.log.error(
          {
            error,
            errorMessage: error instanceof Error ? error.message : "Unknown",
            errorStack: error instanceof Error ? error.stack : undefined,
            agentId,
          },
          "Error handling MCP request",
        );

        // Only send error response if headers not already sent
        if (!reply.sent) {
          reply.status(500);
          return {
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
              data: error instanceof Error ? error.message : "Unknown error",
            },
            id: null,
          };
        }
      }
    },
  );
};

/**
 * Run session cleanup every 5 minutes
 */
setInterval(
  () => {
    cleanupExpiredSessions();
  },
  5 * 60 * 1000,
);

export default mcpGatewayRoutes;
