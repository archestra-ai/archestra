import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { ToolModel } from "@/models";
import mcpClientService from "@/services/mcp-client";
import { type CommonToolCall, type Tool, UuidIdSchema } from "@/types";

/**
 * Cache of MCP server factories by agent ID
 * We cache tools to avoid database queries
 */
const agentServerFactories = new Map<
  string,
  {
    tools: Tool[];
    lastFetch: number;
  }
>();

/**
 * Cache TTL for tools (5 minutes)
 */
const TOOLS_CACHE_TTL = 5 * 60 * 1000;

/**
 * Active transports by session ID
 * Transports must persist across requests within the same session
 */
const activeTransports = new Map<string, StreamableHTTPServerTransport>();

/**
 * Active servers by session ID
 * Servers must persist across requests within the same session
 */
const activeServers = new Map<string, McpServer>();

/**
 * Get cached tools for an agent or fetch them
 */
async function getToolsForAgent(
  agentId: string,
  logger: { info: (obj: unknown, msg: string) => void },
): Promise<Tool[]> {
  const cached = agentServerFactories.get(agentId);
  const now = Date.now();

  if (cached && now - cached.lastFetch < TOOLS_CACHE_TTL) {
    logger.info(
      { agentId, toolCount: cached.tools.length },
      "Using cached tools",
    );
    return cached.tools;
  }

  logger.info({ agentId }, "Fetching tools from database");
  const tools = await ToolModel.getToolsByAgent(agentId);
  logger.info({ agentId, toolCount: tools.length }, "Fetched tools for agent");

  agentServerFactories.set(agentId, { tools, lastFetch: now });
  return tools;
}

/**
 * Create a fresh MCP server for a request
 * In stateless mode, we need to create new server instances per request
 */
async function createAgentServer(
  agentId: string,
  logger: { info: (obj: unknown, msg: string) => void },
): Promise<McpServer> {
  logger.info({ agentId }, "Creating new MCP server instance");

  // Create new MCP server instance for this agent
  const server = new McpServer(
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

  // Get tools for this agent (from cache or database)
  const tools = await getToolsForAgent(agentId, logger);

  // Register all tool handlers
  for (const tool of tools) {
    await registerToolHandler(server, tool, agentId, logger);
  }

  logger.info({ agentId }, "MCP server instance created");
  return server;
}

/**
 * Register a tool handler on the MCP server
 */
async function registerToolHandler(
  server: McpServer,
  tool: Tool,
  agentId: string,
  logger: { info: (obj: unknown, msg: string) => void },
): Promise<void> {
  const toolName = tool.name;
  const toolDescription = tool.description || `Tool: ${toolName}`;
  const _inputSchema = (tool.parameters as Record<string, unknown>) || {
    type: "object",
    properties: {},
  };

  logger.info({ toolName, agentId }, "Registering tool handler");

  // Extract properties from JSON schema for Zod validation
  // The MCP SDK expects Zod schemas, but we store JSON schemas in DB
  // For now, we'll pass a simple object schema that accepts any properties
  server.tool(
    toolName,
    toolDescription,
    {},
    async (args, _extra): Promise<CallToolResult> => {
      logger.info({ toolName, args, agentId }, "Tool handler called");
      try {
        // Create a CommonToolCall for McpClientService
        const toolCall: CommonToolCall = {
          id: `tool-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          name: toolName,
          arguments: args as Record<string, unknown>,
        };

        // Execute the tool call via McpClientService
        const results = await mcpClientService.executeToolCalls(
          [toolCall],
          agentId,
        );

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Tool '${toolName}' not found or not assigned to agent`,
              },
            ],
            isError: true,
          };
        }

        const result = results[0];

        if (result.isError) {
          return {
            content: [
              {
                type: "text",
                text: result.error || "Tool execution failed",
              },
            ],
            isError: true,
          };
        }

        // Transform CommonToolResult to MCP CallToolResult format
        return {
          content: Array.isArray(result.content)
            ? result.content
            : [{ type: "text", text: JSON.stringify(result.content) }],
          isError: false,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Unknown error occurred",
            },
          ],
          isError: true,
        };
      }
    },
  );
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
        clientSessionId ||
        `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
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
 * Fastify route plugin for MCP gateway
 */
const mcpGatewayRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const { endpoint: endpointPrefix } = config.mcpGateway;
  const endpoint = `${endpointPrefix}/:agentId`;
  const params = z.object({
    agentId: UuidIdSchema,
  });

  // GET endpoint for server discovery
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

  // POST endpoint for JSON-RPC requests (handled by MCP SDK)
  fastify.post(
    endpoint,
    {
      schema: {
        params,
        // Accept any JSON body - will be validated by MCP SDK
        body: z.record(z.string(), z.unknown()),
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;
      const sessionId = request.headers["mcp-session-id"] as string | undefined;
      const isInitialize = request.body?.method === "initialize";

      fastify.log.info(
        {
          agentId,
          sessionId,
          method: request.body?.method,
          isInitialize,
          bodyKeys: Object.keys(request.body || {}),
          allHeaders: request.headers,
        },
        "MCP gateway POST request received",
      );

      try {
        let server: McpServer;
        let transport: StreamableHTTPServerTransport;

        // Check if we have an existing session
        if (sessionId && activeTransports.has(sessionId)) {
          fastify.log.info({ agentId, sessionId }, "Reusing existing session");
          transport = activeTransports.get(sessionId)!;
          server = activeServers.get(sessionId)!;
        } else if (isInitialize) {
          // Initialize request - create new session
          // Use client-provided session ID if available
          fastify.log.info(
            { agentId, clientProvidedSessionId: sessionId },
            "Initialize request - creating new session",
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
            activeTransports.set(sessionId, transport);
            activeServers.set(sessionId, server);
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
            activeTransports.set(generatedSessionId, transport);
            activeServers.set(generatedSessionId, server);
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

export default mcpGatewayRoutes;
