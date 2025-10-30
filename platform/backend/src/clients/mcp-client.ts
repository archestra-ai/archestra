import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { InternalMcpCatalogModel, SecretModel, ToolModel } from "@/models";
import { applyResponseModifierTemplate } from "@/templating";
import type {
  CommonMcpToolDefinition,
  CommonToolCall,
  CommonToolResult,
  McpServerConfig,
} from "@/types";

class McpClient {
  private clients = new Map<string, Client>();
  private activeConnections = new Map<string, Client>();

  /**
   * Execute tool calls against their assigned MCP servers
   */
  async executeToolCalls(
    toolCalls: CommonToolCall[],
    agentId: string,
  ): Promise<CommonToolResult[]> {
    if (toolCalls.length === 0) {
      return [];
    }

    // Get MCP tools assigned to the agent
    const mcpTools = await ToolModel.getMcpToolsAssignedToAgent(
      toolCalls.map((tc) => tc.name),
      agentId,
    );

    // Filter tool calls to only those that are MCP tools
    const mcpToolCalls = toolCalls.filter((tc) =>
      mcpTools.some((mt) => mt.toolName === tc.name),
    );

    if (mcpToolCalls.length === 0) {
      return [];
    }

    // Create a mapping of tool names to response modifier templates
    const templatesByToolName = new Map<string, string>();
    for (const tool of mcpTools) {
      if (tool.responseModifierTemplate) {
        templatesByToolName.set(tool.toolName, tool.responseModifierTemplate);
      }
    }

    const results: CommonToolResult[] = [];

    /**
     * TODO:
     * For now, assume all MCP tools use the same server
     * Get the first tool's secret ID (all tools should use same server for an agent)
     */
    const firstTool = mcpTools[0];
    if (!firstTool) {
      return mcpToolCalls.map((tc) => ({
        id: tc.id,
        content: null,
        isError: true,
        error: "No MCP tools found",
      }));
    }

    // Load secrets from the secrets table
    let secrets: Record<string, unknown> = {};
    if (firstTool.mcpServerSecretId) {
      const secret = await SecretModel.findById(firstTool.mcpServerSecretId);
      if (secret?.secret) {
        secrets = secret.secret;
      }
    }

    try {
      let client: Client | null = null;

      const catalogItem = await InternalMcpCatalogModel.findById(
        firstTool.mcpServerCatalogId,
      );

      if (!catalogItem) {
        return mcpToolCalls.map((tc) => ({
          id: tc.id,
          content: null,
          isError: true,
          error: `No catalog item found for MCP server ${firstTool.mcpServerName}`,
        }));
      }

      if (catalogItem.serverType === "remote") {
        // Generic remote server with catalog info
        const config = this.createServerConfig({
          name: firstTool.mcpServerName,
          /**
           * TODO: update SelectInternalMcpCatalogSchema to be a discriminated union of remote and local types
           * this way that typescript knows that when serverType is remote, serverUrl will ALWAYS be set
           */
          url: catalogItem.serverUrl as string,
          secrets,
        });
        client = await this.getOrCreateConnection(
          firstTool.mcpServerCatalogId,
          config,
        );
      } else if (catalogItem.serverType === "local") {
        const config = this.createServerConfig({
          name: firstTool.mcpServerName,
          url: `http://localhost:9000/mcp_proxy/${firstTool.mcpServerId}`, // Use the MCP proxy endpoint for local servers
          secrets,
        });
        client = await this.getOrCreateConnection(
          firstTool.mcpServerCatalogId,
          config,
        );
      } else {
        throw new Error(`Unsupported server type: ${catalogItem.serverType}`);
      }

      if (!client) {
        return mcpToolCalls.map((tc) => ({
          id: tc.id,
          content: null,
          isError: true,
          error: "Failed to create MCP client",
        }));
      }

      // Execute each MCP tool call
      for (const toolCall of mcpToolCalls) {
        try {
          // Strip the server prefix from tool name for MCP server call
          // Tool name format: <server-name>__<native-tool-name>
          // Example: githubcopilot__remote-mcp__search_issues -> search_issues
          const serverPrefix = `${firstTool.mcpServerName}__`;
          const mcpToolName = toolCall.name.startsWith(serverPrefix)
            ? toolCall.name.substring(serverPrefix.length)
            : toolCall.name;

          const result = await client.callTool({
            name: mcpToolName,
            arguments: toolCall.arguments,
          });

          // Apply response modifier template if one exists
          let modifiedContent = result.content;
          const template = templatesByToolName.get(toolCall.name);
          if (template) {
            try {
              modifiedContent = applyResponseModifierTemplate(
                template,
                result.content,
              );
            } catch (error) {
              console.error(
                `Error applying response modifier template for tool ${toolCall.name}:`,
                error,
              );
              // If template fails, use original content
            }
          }

          results.push({
            id: toolCall.id,
            content: modifiedContent,
            isError: !!result.isError,
          });
        } catch (error) {
          results.push({
            id: toolCall.id,
            content: null,
            isError: true,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
    } catch (error) {
      // MCP server connection failed - mark all tool calls as failed
      for (const toolCall of mcpToolCalls) {
        results.push({
          id: toolCall.id,
          content: null,
          isError: true,
          error: `Failed to connect to MCP server: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        });
      }
    }

    return results;
  }

  /**
   * Get or create a persistent connection to an MCP server
   */
  private async getOrCreateConnection(
    serverId: string,
    config: McpServerConfig,
  ): Promise<Client> {
    // Check if we already have an active connection
    const existingClient = this.activeConnections.get(serverId);
    if (existingClient) {
      return existingClient;
    }

    // Create a new connection
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: {
        headers: new Headers(config.headers),
      },
    });

    const client = new Client(
      {
        name: "archestra-platform",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    await client.connect(transport);

    // Store the connection for reuse
    this.activeConnections.set(serverId, client);

    return client;
  }

  /**
   * Connect to an MCP server and return available tools
   */
  async connectAndGetTools(
    config: McpServerConfig,
  ): Promise<CommonMcpToolDefinition[]> {
    const clientId = `${config.name}-${Date.now()}`;

    try {
      // Create stdio transport for the MCP server
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: {
          headers: new Headers(config.headers),
        },
      });

      // Create client and connect
      const client = new Client(
        {
          name: "archestra-platform",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        },
      );

      await client.connect(transport);
      this.clients.set(clientId, client);

      // List available tools
      const toolsResult = await client.listTools();

      // Transform tools to our format
      const tools: CommonMcpToolDefinition[] = toolsResult.tools.map(
        (tool: Tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        }),
      );

      // Close connection (we just needed to get the tools)
      await this.disconnect(clientId);

      return tools;
    } catch (error) {
      // Clean up client if connection failed
      await this.disconnect(clientId);
      throw new Error(
        `Failed to connect to MCP server ${config.name}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  /**
   * Create configuration for connecting to an MCP server
   */
  createServerConfig = (params: {
    name: string;
    url: string;
    secrets: Record<string, unknown>;
  }): McpServerConfig => {
    const { name, url, secrets } = params;

    // Build headers from secrets
    const headers: Record<string, string> = {};

    // All tokens (OAuth and PAT) are stored as access_token
    if (secrets.access_token) {
      headers.Authorization = `Bearer ${secrets.access_token}`;
    }

    return {
      id: name,
      name,
      url,
      headers,
    };
  };

  /**
   * Disconnect from an MCP server
   */
  async disconnect(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (client) {
      try {
        await client.close();
      } catch (error) {
        console.error(`Error closing MCP client ${clientId}:`, error);
      }
      this.clients.delete(clientId);
    }
  }

  /**
   * Disconnect from all MCP servers
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.clients.keys()).map((clientId) =>
      this.disconnect(clientId),
    );

    // Also disconnect active connections
    const activeDisconnectPromises = Array.from(
      this.activeConnections.values(),
    ).map(async (client) => {
      try {
        await client.close();
      } catch (error) {
        console.error("Error closing active MCP connection:", error);
      }
    });

    await Promise.all([...disconnectPromises, ...activeDisconnectPromises]);
    this.activeConnections.clear();
  }
}

// Singleton instance
const mcpClient = new McpClient();
export default mcpClient;

// Clean up connections on process exit
process.on("exit", () => {
  mcpClient.disconnectAll().catch(console.error);
});

process.on("SIGINT", () => {
  mcpClient.disconnectAll().catch(console.error);
  process.exit(0);
});

process.on("SIGTERM", () => {
  mcpClient.disconnectAll().catch(console.error);
  process.exit(0);
});
