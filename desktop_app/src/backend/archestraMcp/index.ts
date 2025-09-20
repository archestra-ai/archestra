import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type experimental_MCPClient, experimental_createMCPClient } from 'ai';

import config from '@backend/config';
import { type AvailableTool } from '@backend/sandbox/schemas';
import log from '@backend/utils/logger';
import { ARCHESTRA_MCP_SERVER_ID, ARCHESTRA_MCP_TOOLS, constructToolId, deconstructToolId } from '@constants';

const { host: serverHost, port: serverPort } = config.server.http;

export type McpTools = Awaited<ReturnType<experimental_MCPClient['tools']>>;

/**
 * ArchestraMcpClient is a singleton client for the built-in Archestra MCP server.
 * It connects to the local MCP endpoint and provides tools for managing MCP servers.
 */
class ArchestraMcpClient {
  private mcpClient: experimental_MCPClient | null = null;
  private archestraMcpUrl: string;
  private isConnected: boolean = false;

  tools: McpTools = {};

  constructor() {
    this.archestraMcpUrl = `http://${serverHost}:${serverPort}/mcp`;
  }

  /**
   * Connect to the Archestra MCP server and fetch available tools
   */
  async connect() {
    if (this.isConnected) {
      log.info('Archestra MCP client already connected');
      return;
    }

    try {
      log.info(`Connecting to Archestra MCP server at ${this.archestraMcpUrl}...`);

      const transport = new StreamableHTTPClientTransport(new URL(this.archestraMcpUrl));
      log.info('Transport created, creating MCP client...');

      this.mcpClient = await experimental_createMCPClient({ transport });
      log.info('MCP client created, fetching tools...');

      await this.fetchTools();
      this.isConnected = true;

      log.info('Successfully connected to Archestra MCP server');
    } catch (error) {
      log.error('Failed to connect to Archestra MCP server:', error);
      log.error('Error details:', JSON.stringify(error, null, 2));
      throw error;
    }
  }

  /**
   * Fetch tools from the Archestra MCP server and transform their IDs
   */
  private async fetchTools() {
    if (!this.mcpClient) {
      throw new Error('MCP client not initialized');
    }

    log.info('Fetching tools from Archestra MCP server...');

    try {
      const tools = await this.mcpClient.tools();

      // Clear existing tools
      this.tools = {};

      // Transform tool IDs to include the Archestra prefix
      for (const [toolName, tool] of Object.entries(tools)) {
        const toolId = constructToolId(ARCHESTRA_MCP_SERVER_ID, toolName);
        this.tools[toolId] = tool;
      }

      const toolCount = Object.keys(this.tools).length;
      log.info(`Fetched ${toolCount} tools from Archestra MCP server`);
    } catch (error) {
      log.error('Failed to fetch tools from Archestra MCP server:', error);
      throw error;
    }
  }

  /**
   * Disconnect from the Archestra MCP server
   */
  async disconnect() {
    if (this.mcpClient) {
      try {
        await this.mcpClient.close();
        this.mcpClient = null;
        this.isConnected = false;
        this.tools = {};
        log.info('Disconnected from Archestra MCP server');
      } catch (error) {
        log.error('Error disconnecting from Archestra MCP server:', error);
      }
    }
  }

  /**
   * Get all tools in the Vercel AI SDK format
   */
  getAllTools(): McpTools {
    return this.tools;
  }

  /**
   * Get specific tools by ID in the Vercel AI SDK format
   */
  getToolsById(toolIds: string[]): McpTools {
    const selected: McpTools = {};

    for (const toolId of toolIds) {
      if (this.tools[toolId]) {
        selected[toolId] = this.tools[toolId];
      }
    }

    return selected;
  }

  /**
   * Helper function to make schema JSON-serializable by removing symbols
   */
  private cleanToolInputSchema = (
    schema: Awaited<ReturnType<experimental_MCPClient['tools']>>[string]['inputSchema']
  ): any => {
    if (!schema) return undefined;

    try {
      // JSON.parse(JSON.stringify()) removes non-serializable properties like symbols
      return JSON.parse(JSON.stringify(schema));
    } catch {
      return undefined;
    }
  };

  /**
   * Get available tools in UI format
   */
  get availableToolsList(): AvailableTool[] {
    return Object.entries(this.tools).map(([id, tool]) => {
      const { toolName } = deconstructToolId(id);

      // Static evaluation for all Archestra MCP tools
      const toolEvaluations: Record<string, { is_read: boolean; is_write: boolean }> = {
        // Memory management tools
        [ARCHESTRA_MCP_TOOLS.LIST_MEMORIES]: { is_read: true, is_write: false },
        [ARCHESTRA_MCP_TOOLS.SET_MEMORY]: { is_read: false, is_write: true },
        [ARCHESTRA_MCP_TOOLS.DELETE_MEMORY]: { is_read: false, is_write: true },

        // Tool management tools
        [ARCHESTRA_MCP_TOOLS.LIST_AVAILABLE_TOOLS]: { is_read: true, is_write: false },
        [ARCHESTRA_MCP_TOOLS.ENABLE_TOOLS]: { is_read: false, is_write: true },
        [ARCHESTRA_MCP_TOOLS.DISABLE_TOOLS]: { is_read: false, is_write: true },
      };

      const evaluation = toolEvaluations[toolName] || {
        is_read: false,
        is_write: false,
      };

      return {
        id,
        name: toolName,
        description: tool.description,
        inputSchema: this.cleanToolInputSchema(tool.inputSchema),
        mcpServerId: ARCHESTRA_MCP_SERVER_ID,
        mcpServerName: 'Archestra',
        // Static evaluations for built-in tools
        analysis: {
          status: 'completed',
          error: null,
          is_read: evaluation.is_read,
          is_write: evaluation.is_write,
        },
      };
    });
  }

  /**
   * Check if the client is connected
   */
  get connected(): boolean {
    return this.isConnected;
  }
}

// Export singleton instance
export default new ArchestraMcpClient();
