import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchema, type Tool } from "ai";
import logger from "@/logging";

/**
 * MCP Gateway URL (internal)
 * Chat connects to the same MCP Gateway that LLM Proxy uses
 */
const MCP_GATEWAY_URL = "http://localhost:9000/v1/mcp";

/**
 * Client cache per agent
 * Key: agentId, Value: MCP Client
 */
const clientCache = new Map<string, Client>();

/**
 * Get or create MCP client for the specified agent
 * Connects to internal MCP Gateway with agent-based authentication
 *
 * @param agentId - The agent ID to use for authentication
 * @returns MCP Client connected to the gateway, or null if connection fails
 */
export async function getChatMcpClient(
  agentId: string,
): Promise<Client | null> {
  // Check cache first
  const cachedClient = clientCache.get(agentId);
  if (cachedClient) {
    logger.debug({ agentId }, "Returning cached MCP client for agent");
    return cachedClient;
  }

  logger.info(
    { agentId, url: MCP_GATEWAY_URL },
    "Creating new MCP client for agent via gateway",
  );

  try {
    // Create StreamableHTTP transport with agent authentication
    const transport = new StreamableHTTPClientTransport(
      new URL(MCP_GATEWAY_URL),
      {
        requestInit: {
          headers: new Headers({
            Authorization: `Bearer ${agentId}`,
            Accept: "application/json, text/event-stream",
          }),
        },
      },
    );

    // Create MCP client
    const client = new Client(
      {
        name: "chat-mcp-client",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    logger.info({ agentId }, "Connecting to MCP Gateway...");
    await client.connect(transport);

    logger.info({ agentId }, "Successfully connected to MCP Gateway");

    // Cache the client
    clientCache.set(agentId, client);

    return client;
  } catch (error) {
    logger.error(
      { error, agentId, url: MCP_GATEWAY_URL },
      "Failed to connect to MCP Gateway for agent",
    );
    return null;
  }
}

/**
 * Validate and normalize JSON Schema for OpenAI
 */
// biome-ignore lint/suspicious/noExplicitAny: JSON Schema structure is dynamic and varies by tool
function normalizeJsonSchema(schema: any): any {
  // If schema is missing or invalid, return a minimal valid schema
  if (
    !schema ||
    !schema.type ||
    schema.type === "None" ||
    schema.type === "null"
  ) {
    return {
      type: "object",
      properties: {},
    };
  }

  // Return the schema as-is if it's already valid JSON Schema
  return schema;
}

/**
 * Get all MCP tools for the specified agent in AI SDK Tool format
 * Converts MCP JSON Schema to AI SDK Schema using jsonSchema() helper
 *
 * @param agentId - The agent ID to fetch tools for
 * @returns Record of tool name to AI SDK Tool object
 */
export async function getChatMcpTools(
  agentId: string,
): Promise<Record<string, Tool>> {
  logger.info({ agentId }, "getChatMcpTools() called - fetching client...");
  const client = await getChatMcpClient(agentId);

  if (!client) {
    logger.warn({ agentId }, "No MCP client available, returning empty tools");
    return {}; // No tools available
  }

  try {
    logger.info({ agentId }, "MCP client available, listing tools...");
    const { tools: mcpTools } = await client.listTools();

    logger.info(
      {
        agentId,
        toolCount: mcpTools.length,
        toolNames: mcpTools.map((t) => t.name),
      },
      "Fetched tools from MCP Gateway for agent",
    );

    // Convert MCP tools to AI SDK Tool format
    const aiTools: Record<string, Tool> = {};

    for (const mcpTool of mcpTools) {
      try {
        // Normalize the schema and wrap with jsonSchema() helper
        const normalizedSchema = normalizeJsonSchema(mcpTool.inputSchema);

        logger.debug(
          {
            toolName: mcpTool.name,
            schemaType: normalizedSchema.type,
            hasProperties: !!normalizedSchema.properties,
          },
          "Converting MCP tool with JSON Schema",
        );

        // Construct Tool using jsonSchema() to wrap JSON Schema
        aiTools[mcpTool.name] = {
          description: mcpTool.description || `Tool: ${mcpTool.name}`,
          inputSchema: jsonSchema(normalizedSchema),
          // biome-ignore lint/suspicious/noExplicitAny: Tool execute function requires flexible typing for MCP integration
          execute: async (args: any) => {
            logger.info(
              { agentId, toolName: mcpTool.name, arguments: args },
              "Executing MCP tool from chat",
            );

            try {
              const result = await client.callTool({
                name: mcpTool.name,
                arguments: args || {},
              });

              logger.info(
                { agentId, toolName: mcpTool.name, result },
                "MCP tool execution completed",
              );

              // Convert MCP content to string for AI SDK
              const content = (
                result.content as Array<{ type: string; text?: string }>
              )
                .map((item: { type: string; text?: string }) => {
                  if (item.type === "text" && item.text) {
                    return item.text;
                  }
                  return JSON.stringify(item);
                })
                .join("\n");

              return content;
            } catch (error) {
              logger.error(
                { agentId, toolName: mcpTool.name, error },
                "MCP tool execution failed",
              );
              throw error;
            }
          },
        };
      } catch (error) {
        logger.error(
          { agentId, toolName: mcpTool.name, error },
          "Failed to convert MCP tool to AI SDK format, skipping",
        );
        // Skip this tool and continue with others
      }
    }

    logger.info(
      { agentId, convertedToolCount: Object.keys(aiTools).length },
      "Successfully converted MCP tools to AI SDK Tool format",
    );

    return aiTools;
  } catch (error) {
    logger.error({ agentId, error }, "Failed to fetch tools from MCP Gateway");
    return {};
  }
}
