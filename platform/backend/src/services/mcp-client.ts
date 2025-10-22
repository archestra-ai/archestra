import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * NOTE: for right now this really only supports remote MCP servers and will of course need to be expanded out...
 */
interface McpServerConfig {
  name: string;
  url: string;
  headers: Record<string, string>;
}

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

class McpClientService {
  private clients = new Map<string, Client>();

  /**
   * Connect to an MCP server and return available tools
   */
  async connectAndGetTools(
    config: McpServerConfig,
  ): Promise<McpToolDefinition[]> {
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
      const tools: McpToolDefinition[] = toolsResult.tools.map(
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
    await Promise.all(disconnectPromises);
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
