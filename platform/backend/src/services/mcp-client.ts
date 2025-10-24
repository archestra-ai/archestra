import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolModel } from "@/models";
import { applyResponseModifierTemplate } from "@/templating";
import type {
  CommonMcpToolDefinition,
  CommonToolCall,
  CommonToolResult,
  McpServerConfig,
} from "@/types";

class McpClientService {
  private clients = new Map<string, Client>();
  private activeConnections = new Map<string, Client>();

  /**
   * Execute tool calls against their assigned MCP servers (GitHub-only for now)
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
     *
     * For now, assume all MCP tools use the same GitHub server
     * Get the first GitHub token (all GitHub tools should use same token for an agent)
     */
    const githubToken = mcpTools[0]?.mcpServerInstallationMetadata.githubToken;
    if (!githubToken) {
      return mcpToolCalls.map((tc) => ({
        id: tc.id,
        content: null,
        isError: true,
        error: "No GitHub token found for MCP tools",
      }));
    }

    try {
      const client = await this.getOrCreateGitHubConnection(
        githubToken as string,
      );

      // Execute each MCP tool call
      for (const toolCall of mcpToolCalls) {
        try {
          // Strip the server prefix from tool name for MCP server call
          const mcpToolName = ToolModel.unslugifyName(toolCall.name);

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
      // GitHub server connection failed - mark all tool calls as failed
      for (const toolCall of mcpToolCalls) {
        results.push({
          id: toolCall.id,
          content: null,
          isError: true,
          error: `Failed to connect to GitHub MCP server: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }

    return results;
  }

  /**
   * TODO: this method is very much temporary just to get the GitHub remote MCP server demo-able.. this should
   * be removed once we have more generic/broad support for remote MCP servers.
   *
   * Get or create a persistent connection to GitHub MCP server
   */
  private async getOrCreateGitHubConnection(
    githubToken: string,
  ): Promise<Client> {
    const serverId = "github-mcp-server";

    // Check if we already have an active connection
    const existingClient = this.activeConnections.get(serverId);
    if (existingClient) {
      return existingClient;
    }

    // Create GitHub config and connect
    const config = this.createGitHubConfig(githubToken);
    return this.getOrCreateConnection(serverId, config);
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
   * Create configuration for a GitHub MCP server
   */
  createGitHubConfig = (githubToken: string): McpServerConfig => ({
    id: "github-mcp-server",
    name: "github-mcp-server",
    url: "https://api.githubcopilot.com/mcp/",
    headers: {
      Authorization: `Bearer ${githubToken}`,
    },
  });

  /**
   * Validate that a GitHub token can connect to the GitHub MCP server
   *
   * https://github.com/github/github-mcp-server?tab=readme-ov-file#install-in-vs-code
   */
  async validateGitHubConnection(githubToken: string): Promise<boolean> {
    try {
      const tools = await this.connectAndGetTools(
        this.createGitHubConfig(githubToken),
      );
      return tools.length > 0;
    } catch (error) {
      console.error("GitHub MCP validation failed:", error);
      return false;
    }
  }

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
const mcpClientService = new McpClientService();
export default mcpClientService;

// Clean up connections on process exit
process.on("exit", () => {
  mcpClientService.disconnectAll().catch(console.error);
});

process.on("SIGINT", () => {
  mcpClientService.disconnectAll().catch(console.error);
  process.exit(0);
});

process.on("SIGTERM", () => {
  mcpClientService.disconnectAll().catch(console.error);
  process.exit(0);
});
