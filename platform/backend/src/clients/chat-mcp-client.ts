import { experimental_createMCPClient } from "@ai-sdk/mcp";
import config from "@/config";
import logger from "@/logging";

let mcpClient: Awaited<ReturnType<typeof experimental_createMCPClient>> | null =
  null;

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
    { url: config.chat.mcp.remoteServerUrl },
    "Connecting to chat MCP server",
  );

  try {
    mcpClient = await experimental_createMCPClient({
      name: "chat-mcp-server",
      transport: {
        type: "sse",
        url: config.chat.mcp.remoteServerUrl,
        headers: config.chat.mcp.remoteServerHeaders || {},
      },
    });

    logger.info("Successfully connected to chat MCP server");
    return mcpClient;
  } catch (error) {
    logger.error(
      { error, url: config.chat.mcp.remoteServerUrl },
      "Failed to connect to chat MCP server",
    );
    return null;
  }
}

/**
 * Get all MCP tools in AI SDK format
 * Returns tools with execute() functions that call the remote MCP server
 */
export async function getChatMcpTools(): Promise<Record<string, any>> {
  const client = await getChatMcpClient();

  if (!client) {
    return {}; // No tools available
  }

  try {
    const tools = await client.tools();
    logger.info(
      { toolCount: Object.keys(tools).length },
      "Fetched tools from chat MCP server",
    );
    return tools;
  } catch (error) {
    logger.error({ error }, "Failed to fetch tools from chat MCP server");
    return {};
  }
}
