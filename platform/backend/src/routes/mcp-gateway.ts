import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { ZodRawShape } from "zod";
import { z } from "zod";
import config from "@/config";
import { ToolModel } from "@/models";
import mcpClientService from "@/services/mcp-client";
import { type CommonToolCall, type Tool, UuidIdSchema } from "@/types";

/**
 * Convert JSON Schema properties to a Zod schema that accepts all properties
 * We use a passthrough schema to allow any properties from the JSON schema
 */
function createPermissiveZodSchema(
  jsonSchema: Record<string, unknown>,
): z.ZodObject<z.ZodRawShape> {
  const properties = (jsonSchema.properties as Record<string, unknown>) || {};
  const zodShape: Record<string, z.ZodTypeAny> = {};

  // Create a Zod schema that accepts each property as an unknown type
  // This allows the SDK to extract the arguments while being permissive
  for (const key of Object.keys(properties)) {
    zodShape[key] = z.unknown().optional();
  }

  // Wrap in z.object() and use passthrough to allow any additional properties
  return z.object(zodShape).passthrough();
}

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

  // Deduplicate tools by name (in case there are duplicates in the database)
  const uniqueTools = new Map<string, Tool>();
  for (const tool of tools) {
    if (!uniqueTools.has(tool.name)) {
      uniqueTools.set(tool.name, tool);
    } else {
      logger.info({ agentId, toolName: tool.name }, "Skipping duplicate tool");
    }
  }

  // Register all unique tool handlers
  for (const tool of uniqueTools.values()) {
    await registerToolHandler(server, tool, agentId, logger);
  }

  // Override both tools/list and tools/call handlers
  // This gives us full control over argument passing without Zod schema issues

  // First, remove the SDK's default handlers that were registered when we added tools
  server.server.removeRequestHandler("tools/list");
  server.server.removeRequestHandler("tools/call");

  // Override tools/list to return our JSON schemas
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    // @ts-expect-error - Accessing private property
    const registeredTools = server._registeredTools as Record<
      string,
      {
        enabled: boolean;
        title?: string;
        description?: string;
        _jsonSchema?: unknown;
        annotations?: unknown;
        _meta?: unknown;
      }
    >;

    const tools = Object.entries(registeredTools)
      .filter(([, tool]) => tool.enabled)
      .map(([name, tool]) => ({
        name,
        title: tool.title,
        description: tool.description,
        // Use our stored JSON schema instead of converting from Zod
        inputSchema: tool._jsonSchema || {
          type: "object",
          properties: {},
        },
        annotations: tool.annotations,
        _meta: tool._meta,
      }));

    logger.info(
      { agentId, toolCount: tools.length },
      "Responding to tools/list with JSON schemas",
    );

    return { tools };
  });

  // Override tools/call to pass arguments directly without Zod validation
  server.server.setRequestHandler(
    CallToolRequestSchema,
    async (request: { params: { name: string; arguments?: unknown } }) => {
      const toolName = request.params.name;
      const args = (request.params.arguments as Record<string, unknown>) || {};

      logger.info(
        { agentId, toolName, args },
        "Custom tools/call handler - calling tool",
      );

      // @ts-expect-error - Accessing private property
      const registeredTools = server._registeredTools as Record<
        string,
        {
          enabled: boolean;
          callback: (
            args: Record<string, unknown>,
            extra: unknown,
          ) => Promise<CallToolResult> | CallToolResult;
        }
      >;

      const tool = registeredTools[toolName];
      if (!tool || !tool.enabled) {
        return {
          content: [
            {
              type: "text",
              text: `Tool '${toolName}' not found or not enabled`,
            },
          ],
          isError: true,
        };
      }

      // Call the tool handler with the raw arguments
      try {
        const result = await tool.callback(args, {});
        return result;
      } catch (error) {
        logger.info(
          {
            agentId,
            toolName,
            error: error instanceof Error ? error.message : "Unknown",
          },
          "Custom tools/call handler - error",
        );
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

  // We store JSON schemas in the database, but the SDK converts Zod schemas to JSON schemas
  // To bypass this, we'll register the tool with a permissive Zod schema that accepts
  // all the properties from our JSON schema, then patch the internal registry to use
  // our JSON schema for the tools/list response
  const inputSchema = (tool.parameters as Record<string, unknown>) || {
    type: "object",
    properties: {},
  };

  logger.info({ toolName, agentId, inputSchema }, "Registering tool handler");

  // Register the tool with an empty schema
  // We'll handle argument extraction in our custom tools/call handler
  const registeredTool = server.tool(
    toolName,
    toolDescription,
    {},
    async (
      args: Record<string, unknown>,
      _extra: unknown,
    ): Promise<CallToolResult> => {
      logger.info({ toolName, args, agentId }, "Tool handler called");
      try {
        // Create a CommonToolCall for McpClientService
        const toolCall: CommonToolCall = {
          id: `tool-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          name: toolName,
          arguments: args as Record<string, unknown>,
        };

        logger.info(
          { toolName, toolCallId: toolCall.id, agentId },
          "Executing tool via McpClientService",
        );

        // Execute the tool call via McpClientService
        const results = await mcpClientService.executeToolCalls(
          [toolCall],
          agentId,
        );

        logger.info(
          { toolName, resultsCount: results.length, agentId },
          "McpClientService returned results",
        );

        if (results.length === 0) {
          logger.info(
            { toolName, agentId },
            "No results returned - tool not found or not assigned",
          );
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

        logger.info(
          {
            toolName,
            resultIsError: result.isError,
            resultError: result.error,
            resultContent: result.content,
            agentId,
          },
          "Received result from McpClientService",
        );

        if (result.isError) {
          logger.info(
            { toolName, error: result.error, content: result.content, agentId },
            "Tool execution returned error",
          );
          // The error message might be in result.error OR in result.content
          // Return the content as-is if it exists, otherwise use error or fallback
          return {
            content: result.content
              ? Array.isArray(result.content)
                ? result.content
                : [{ type: "text", text: JSON.stringify(result.content) }]
              : [
                  {
                    type: "text",
                    text: result.error || "Tool execution failed",
                  },
                ],
            isError: true,
          };
        }

        // Transform CommonToolResult to MCP CallToolResult format
        logger.info(
          {
            toolName,
            contentType: Array.isArray(result.content)
              ? "array"
              : typeof result.content,
            agentId,
          },
          "Tool execution successful - returning result",
        );

        return {
          content: Array.isArray(result.content)
            ? result.content
            : [{ type: "text", text: JSON.stringify(result.content) }],
          isError: false,
        };
      } catch (error) {
        logger.info(
          {
            toolName,
            error: error instanceof Error ? error.message : "Unknown",
            stack: error instanceof Error ? error.stack : undefined,
            agentId,
          },
          "Tool handler caught exception",
        );
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

  // Store the JSON schema in the registered tool's metadata
  // We'll use this when responding to tools/list requests
  // @ts-expect-error - Accessing private property to store JSON schema
  const internalTools = server._registeredTools as Record<
    string,
    { _jsonSchema: unknown }
  >;
  if (internalTools[toolName]) {
    internalTools[toolName]._jsonSchema = inputSchema;
    logger.info({ toolName, agentId }, "Stored JSON schema in tool metadata");
  }
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
          fastify.log.info(
            {
              agentId,
              sessionId,
              hasTransport: !!activeTransports.get(sessionId),
              hasServer: !!activeServers.get(sessionId),
            },
            "Reusing existing session",
          );
          transport = activeTransports.get(sessionId)!;
          server = activeServers.get(sessionId)!;

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
              sessionExists: sessionId
                ? activeTransports.has(sessionId)
                : false,
              activeSessions: Array.from(activeTransports.keys()),
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
