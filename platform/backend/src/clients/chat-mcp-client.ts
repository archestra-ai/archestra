import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchema, type Tool } from "ai";
import config from "@/config";
import logger from "@/logging";

let mcpClient: Client | null = null;

/**
 * Get or create MCP client for remote server
 * Used by chat feature to connect to a single remote MCP server
 */
export async function getChatMcpClient() {
  if (mcpClient) {
    return mcpClient;
  }

  if (!config.chat.mcp.remoteServerUrl) {
    logger.warn(
      "Chat MCP server URL not configured (ARCHESTRA_CHAT_MCP_SERVER_URL). Chat will have no tools available.",
    );
    return null;
  }

  logger.info(
    {
      url: config.chat.mcp.remoteServerUrl,
      headers: config.chat.mcp.remoteServerHeaders,
    },
    "Connecting to chat MCP server",
  );

  try {
    logger.info("Creating MCP client with StreamableHTTP transport...");

    // Create StreamableHTTP transport (URL object + requestInit)
    const transport = new StreamableHTTPClientTransport(
      new URL(config.chat.mcp.remoteServerUrl),
      {
        requestInit: {
          headers: new Headers(config.chat.mcp.remoteServerHeaders || {}),
        },
      },
    );

    // Create MCP client
    mcpClient = new Client(
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

    logger.info("Connecting to MCP server...");
    await mcpClient.connect(transport);

    logger.info("Successfully connected to chat MCP server");
    return mcpClient;
  } catch (error) {
    logger.error(
      { error, url: config.chat.mcp.remoteServerUrl },
      "Failed to connect to chat MCP server",
    );
    mcpClient = null;
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
 * Get all MCP tools in AI SDK Tool format
 * Converts MCP JSON Schema to AI SDK Schema using jsonSchema() helper
 */
export async function getChatMcpTools(): Promise<Record<string, Tool>> {
  logger.info("getChatMcpTools() called - fetching client...");
  const client = await getChatMcpClient();

  if (!client) {
    logger.warn("No MCP client available, returning empty tools");
    return {}; // No tools available
  }

  try {
    logger.info("MCP client available, listing tools...");
    const { tools: mcpTools } = await client.listTools();

    logger.info(
      { toolCount: mcpTools.length, toolNames: mcpTools.map((t) => t.name) },
      "Fetched tools from chat MCP server",
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
              { toolName: mcpTool.name, arguments: args },
              "Executing MCP tool from chat",
            );

            try {
              const result = await client.callTool({
                name: mcpTool.name,
                arguments: args || {},
              });

              logger.info(
                { toolName: mcpTool.name, result },
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
                { toolName: mcpTool.name, error },
                "MCP tool execution failed",
              );
              throw error;
            }
          },
        };
      } catch (error) {
        logger.error(
          { toolName: mcpTool.name, error },
          "Failed to convert MCP tool to AI SDK format, skipping",
        );
        // Skip this tool and continue with others
      }
    }

    logger.info(
      { convertedToolCount: Object.keys(aiTools).length },
      "Successfully converted MCP tools to AI SDK Tool format",
    );

    return aiTools;
  } catch (error) {
    logger.error({ error }, "Failed to fetch tools from chat MCP server");
    return {};
  }
}
