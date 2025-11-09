import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getInternalJwt } from "@/auth/internal-jwt";
import config from "@/config";
import logger from "@/logging";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import {
  InternalMcpCatalogModel,
  McpServerModel,
  McpToolCallModel,
  SecretModel,
  ToolModel,
} from "@/models";
import { applyResponseModifierTemplate } from "@/templating";
import type {
  CommonMcpToolDefinition,
  CommonToolCall,
  CommonToolResult,
  McpServerConfig,
} from "@/types";

export const constructMcpProxyUrl = (mcpServerId: string) =>
  `http://localhost:${config.api.port}/mcp_proxy/${mcpServerId}`;

class McpClient {
  private clients = new Map<string, Client>();
  private activeConnections = new Map<string, Client>();

  /**
   * Execute a single tool call against its assigned MCP server
   */
  async executeToolCall(
    toolCall: CommonToolCall,
    agentId: string,
  ): Promise<CommonToolResult> {
    // Get MCP tool information for this specific tool
    const mcpTools = await ToolModel.getMcpToolsAssignedToAgent(
      [toolCall.name],
      agentId,
    );

    const tool = mcpTools[0];
    if (!tool) {
      // Not an MCP tool or not assigned to this agent
      const errorResult: CommonToolResult = {
        id: toolCall.id,
        content: null,
        isError: true,
        error: "Tool not found or not assigned to agent",
      };

      // Persist error to database
      try {
        await McpToolCallModel.create({
          agentId,
          mcpServerName: "unknown",
          method: "tools/call",
          toolCall,
          toolResult: errorResult,
        });
        logger.info(
          { toolName: toolCall.name },
          "✅ Saved error: tool not found",
        );
      } catch (dbError) {
        logger.error({ err: dbError }, "Failed to persist error");
      }

      return errorResult;
    }

    // Determine which MCP server to route to
    // Use executionSourceMcpServerId if present (for local servers), otherwise fall back to mcpServerId
    const targetMcpServerId =
      tool.executionSourceMcpServerId || tool.mcpServerId;

    if (!targetMcpServerId) {
      const errorResult: CommonToolResult = {
        id: toolCall.id,
        content: null,
        isError: true,
        error: "No execution source specified for MCP tool",
      };

      try {
        await McpToolCallModel.create({
          agentId,
          mcpServerName: tool.mcpServerName || "unknown",
          method: "tools/call",
          toolCall,
          toolResult: errorResult,
        });
        logger.info(
          { toolName: toolCall.name },
          "✅ Saved error: no execution source",
        );
      } catch (dbError) {
        logger.error({ err: dbError }, "Failed to persist error");
      }

      return errorResult;
    }

    // Load secrets from the secrets table
    // The credential source MCP server must be explicitly selected (team or user token)
    let secrets: Record<string, unknown> = {};
    let secretId: string | null = null;

    if (tool.credentialSourceMcpServerId) {
      // User selected a specific token (team or user) to use
      const credentialSourceServer = await McpServerModel.findById(
        tool.credentialSourceMcpServerId,
      );
      if (credentialSourceServer?.secretId) {
        secretId = credentialSourceServer.secretId;
      }
    }

    if (secretId) {
      const secret = await SecretModel.findById(secretId);
      if (secret?.secret) {
        secrets = secret.secret;
      }
    }

    try {
      // Use catalogId from the tool (required for MCP tools)
      if (!tool.catalogId) {
        const errorResult: CommonToolResult = {
          id: toolCall.id,
          content: null,
          isError: true,
          error: "Tool is missing catalogId",
        };

        try {
          await McpToolCallModel.create({
            agentId,
            mcpServerName: tool.mcpServerName || "unknown",
            method: "tools/call",
            toolCall,
            toolResult: errorResult,
          });
          logger.info(
            { toolName: toolCall.name },
            "✅ Saved error: missing catalogId",
          );
        } catch (dbError) {
          logger.error({ err: dbError }, "Failed to persist error");
        }

        return errorResult;
      }

      const catalogItem = await InternalMcpCatalogModel.findById(
        tool.catalogId,
      );

      if (!catalogItem) {
        const errorResult: CommonToolResult = {
          id: toolCall.id,
          content: null,
          isError: true,
          error: `No catalog item found for tool catalog ID ${tool.catalogId}`,
        };

        try {
          await McpToolCallModel.create({
            agentId,
            mcpServerName: tool.mcpServerName || "unknown",
            method: "tools/call",
            toolCall,
            toolResult: errorResult,
          });
          logger.info(
            { toolName: toolCall.name },
            "✅ Saved error: catalog not found",
          );
        } catch (dbError) {
          logger.error({ err: dbError }, "Failed to persist error");
        }

        return errorResult;
      }

      // For local servers, check if they use streamable-http transport
      if (catalogItem.serverType === "local") {
        const usesStreamableHttp =
          await McpServerRuntimeManager.usesStreamableHttp(targetMcpServerId);

        if (usesStreamableHttp) {
          // Use streamable HTTP transport for these servers
          const httpEndpointUrl =
            McpServerRuntimeManager.getHttpEndpointUrl(targetMcpServerId);

          if (!httpEndpointUrl) {
            const errorResult: CommonToolResult = {
              id: toolCall.id,
              content: null,
              isError: true,
              error: `No HTTP endpoint URL found for streamable-http server ${tool.mcpServerName || "unknown"}`,
            };

            try {
              await McpToolCallModel.create({
                agentId,
                mcpServerName: tool.mcpServerName || "unknown",
                method: "tools/call",
                toolCall,
                toolResult: errorResult,
              });
              logger.info(
                { toolName: toolCall.name },
                "✅ Saved error: no HTTP endpoint",
              );
            } catch (dbError) {
              logger.error({ err: dbError }, "Failed to persist error");
            }

            return errorResult;
          }

          // Use the same logic as remote servers with StreamableHTTPClientTransport
          const client = await this.getOrCreateConnection(targetMcpServerId, {
            id: targetMcpServerId,
            url: httpEndpointUrl,
            name: tool.mcpServerName || "unknown",
            headers: {},
          });

          try {
            // Strip the server prefix from tool name for MCP server call
            // For local servers, use catalog name (without userId) for prefix
            const prefixName =
              tool.catalogName || tool.mcpServerName || "unknown";
            const serverPrefix = `${prefixName}__`;
            const mcpToolName = toolCall.name.startsWith(serverPrefix)
              ? toolCall.name.substring(serverPrefix.length)
              : toolCall.name;

            const result = await client.callTool({
              name: mcpToolName,
              arguments: toolCall.arguments,
            });

            // Apply response modifier template if one exists
            let modifiedContent = result.content;
            if (tool.responseModifierTemplate) {
              try {
                modifiedContent = applyResponseModifierTemplate(
                  tool.responseModifierTemplate,
                  result.content,
                );
              } catch (error) {
                logger.error(
                  { err: error },
                  `Error applying response modifier template for tool ${toolCall.name}:`,
                );
                // If template fails, use original content
              }
            }

            const toolResult: CommonToolResult = {
              id: toolCall.id,
              content: modifiedContent,
              isError: !!result.isError,
            };

            // Persist tool call and result to database
            try {
              const savedToolCall = await McpToolCallModel.create({
                agentId,
                mcpServerName: tool.mcpServerName || "unknown",
                method: "tools/call",
                toolCall,
                toolResult,
              });
              logger.info(
                {
                  id: savedToolCall.id,
                  toolName: toolCall.name,
                  resultContent:
                    typeof toolResult.content === "string"
                      ? toolResult.content.substring(0, 100)
                      : JSON.stringify(toolResult.content).substring(0, 100),
                },
                "✅ Saved streamable-http MCP tool call (success):",
              );
            } catch (dbError) {
              logger.error(
                { err: dbError },
                "Failed to persist streamable-http MCP tool call:",
              );
            }

            return toolResult;
          } catch (error) {
            const toolResult: CommonToolResult = {
              id: toolCall.id,
              content: null,
              isError: true,
              error: error instanceof Error ? error.message : "Unknown error",
            };

            // Persist failed tool call to database
            try {
              const savedToolCall = await McpToolCallModel.create({
                agentId,
                mcpServerName: tool.mcpServerName || "unknown",
                method: "tools/call",
                toolCall,
                toolResult,
              });
              logger.info(
                {
                  id: savedToolCall.id,
                  toolName: toolCall.name,
                  error: toolResult.error,
                },
                "✅ Saved streamable-http MCP tool call (error):",
              );
            } catch (dbError) {
              logger.error(
                { err: dbError },
                "Failed to persist failed streamable-http MCP tool call:",
              );
            }

            return toolResult;
          }
        }

        // Execute the tool call via direct JSON-RPC (stdio transport)
        try {
          // Strip the server prefix from tool name for MCP server call
          // For local servers, use catalog name (without userId) for prefix
          const prefixName =
            tool.catalogName || tool.mcpServerName || "unknown";
          const serverPrefix = `${prefixName}__`;
          const mcpToolName = toolCall.name.startsWith(serverPrefix)
            ? toolCall.name.substring(serverPrefix.length)
            : toolCall.name;

          const response = await fetch(
            constructMcpProxyUrl(targetMcpServerId),
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${getInternalJwt()}`,
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: Date.now(),
                method: "tools/call",
                params: {
                  name: mcpToolName,
                  arguments: toolCall.arguments,
                },
              }),
            },
          );

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const jsonResult = await response.json();

          if (jsonResult.error) {
            throw new Error(
              `JSON-RPC error ${jsonResult.error.code}: ${jsonResult.error.message}`,
            );
          }

          const result = jsonResult.result;

          // Apply response modifier template if one exists
          let modifiedContent = result.content;
          if (tool.responseModifierTemplate) {
            try {
              modifiedContent = applyResponseModifierTemplate(
                tool.responseModifierTemplate,
                result.content,
              );
            } catch (error) {
              logger.error(
                { err: error },
                `Error applying response modifier template for tool ${toolCall.name}:`,
              );
              // If template fails, use original content
            }
          }

          const toolResult: CommonToolResult = {
            id: toolCall.id,
            content: modifiedContent,
            isError: !!result.isError,
          };

          // Persist tool call and result to database
          try {
            const savedToolCall = await McpToolCallModel.create({
              agentId,
              mcpServerName: tool.mcpServerName || "unknown",
              method: "tools/call",
              toolCall,
              toolResult,
            });
            logger.info(
              {
                id: savedToolCall.id,
                toolName: toolCall.name,
                resultContent:
                  typeof toolResult.content === "string"
                    ? toolResult.content.substring(0, 100)
                    : JSON.stringify(toolResult.content).substring(0, 100),
              },
              "✅ Saved local MCP tool call (success):",
            );
          } catch (dbError) {
            logger.error(
              { err: dbError },
              "Failed to persist local MCP tool call:",
            );
          }

          return toolResult;
        } catch (error) {
          const toolResult: CommonToolResult = {
            id: toolCall.id,
            content: null,
            isError: true,
            error: error instanceof Error ? error.message : "Unknown error",
          };

          // Persist failed tool call to database
          try {
            const savedToolCall = await McpToolCallModel.create({
              agentId,
              mcpServerName: tool.mcpServerName || "unknown",
              method: "tools/call",
              toolCall,
              toolResult,
            });
            logger.info(
              {
                id: savedToolCall.id,
                toolName: toolCall.name,
                error: toolResult.error,
              },
              "✅ Saved local MCP tool call (error):",
            );
          } catch (dbError) {
            logger.error(
              { err: dbError },
              "Failed to persist local MCP tool call:",
            );
          }

          return toolResult;
        }
      }

      // For remote servers, use the standard MCP SDK client
      if (catalogItem.serverType === "remote") {
        if (!catalogItem.serverUrl) {
          const errorResult: CommonToolResult = {
            id: toolCall.id,
            content: null,
            isError: true,
            error: "Remote server missing serverUrl",
          };

          try {
            await McpToolCallModel.create({
              agentId,
              mcpServerName: tool.mcpServerName || "unknown",
              method: "tools/call",
              toolCall,
              toolResult: errorResult,
            });
            logger.info(
              { toolName: toolCall.name },
              "✅ Saved error: missing serverUrl",
            );
          } catch (dbError) {
            logger.error({ err: dbError }, "Failed to persist error");
          }

          return errorResult;
        }

        // Generic remote server with catalog info
        const config = this.createServerConfig({
          name: tool.mcpServerName || "unknown",
          url: catalogItem.serverUrl,
          secrets,
        });

        // Use catalog ID + secret ID as cache key to ensure different credentials = different connections
        const connectionKey = secretId
          ? `${catalogItem.id}:${secretId}`
          : catalogItem.id;

        try {
          const client = await this.getOrCreateConnection(
            connectionKey,
            config,
          );

          // Strip the server prefix from tool name for MCP server call
          // Tool name format: <server-name>__<native-tool-name>
          // Example: githubcopilot__remote-mcp__search_issues -> search_issues
          const prefixName =
            tool.catalogName || tool.mcpServerName || "unknown";
          const serverPrefix = `${prefixName}__`;
          const mcpToolName = toolCall.name.startsWith(serverPrefix)
            ? toolCall.name.substring(serverPrefix.length)
            : toolCall.name;

          const result = await client.callTool({
            name: mcpToolName,
            arguments: toolCall.arguments,
          });

          // Apply response modifier template if one exists
          let modifiedContent = result.content;
          if (tool.responseModifierTemplate) {
            try {
              modifiedContent = applyResponseModifierTemplate(
                tool.responseModifierTemplate,
                result.content,
              );
            } catch (error) {
              logger.error(
                { err: error },
                `Error applying response modifier template for tool ${toolCall.name}:`,
              );
              // If template fails, use original content
            }
          }

          const toolResult: CommonToolResult = {
            id: toolCall.id,
            content: modifiedContent,
            isError: !!result.isError,
          };

          // Persist tool call and result to database
          try {
            const savedToolCall = await McpToolCallModel.create({
              agentId,
              mcpServerName: tool.mcpServerName || "unknown",
              method: "tools/call",
              toolCall,
              toolResult,
            });
            logger.info(
              {
                id: savedToolCall.id,
                toolName: toolCall.name,
                resultContent:
                  typeof toolResult.content === "string"
                    ? toolResult.content.substring(0, 100)
                    : JSON.stringify(toolResult.content).substring(0, 100),
              },
              "✅ Saved successful MCP tool call:",
            );
          } catch (dbError) {
            logger.error({ err: dbError }, "Failed to persist MCP tool call:");
          }

          return toolResult;
        } catch (error) {
          const toolResult: CommonToolResult = {
            id: toolCall.id,
            content: null,
            isError: true,
            error: error instanceof Error ? error.message : "Unknown error",
          };

          // Persist failed tool call to database
          try {
            const savedToolCall = await McpToolCallModel.create({
              agentId,
              mcpServerName: tool.mcpServerName || "unknown",
              method: "tools/call",
              toolCall,
              toolResult,
            });
            logger.info(
              {
                id: savedToolCall.id,
                toolName: toolCall.name,
                error: toolResult.error,
              },
              "✅ Saved failed MCP tool call:",
            );
          } catch (dbError) {
            logger.error({ err: dbError }, "Failed to persist MCP tool call:");
          }

          return toolResult;
        }
      }

      throw new Error(`Unsupported server type: ${catalogItem.serverType}`);
    } catch (error) {
      // Top-level error (e.g., catalog lookup failed)
      const toolResult: CommonToolResult = {
        id: toolCall.id,
        content: null,
        isError: true,
        error: `Failed to execute tool: ${error instanceof Error ? error.message : "Unknown error"}`,
      };

      // Persist connection failure to database
      try {
        await McpToolCallModel.create({
          agentId,
          mcpServerName: tool.mcpServerName || "unknown",
          method: "tools/call",
          toolCall,
          toolResult,
        });
      } catch (dbError) {
        logger.error({ err: dbError }, "Failed to persist MCP tool call:");
      }

      return toolResult;
    }
  }

  /**
   * Get or create a persistent connection to an MCP server
   */
  private async getOrCreateConnection(
    connectionKey: string,
    config: McpServerConfig,
  ): Promise<Client> {
    // Check if we already have an active connection
    const existingClient = this.activeConnections.get(connectionKey);
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
    this.activeConnections.set(connectionKey, client);

    return client;
  }

  /**
   * Connect to an MCP server and return available tools
   */
  async connectAndGetTools(
    config: McpServerConfig,
  ): Promise<CommonMcpToolDefinition[]> {
    const clientId = `${config.name}-${Date.now()}`;

    // For local servers using the mcp_proxy endpoint, make direct JSON-RPC call
    // instead of using StreamableHTTPClientTransport which expects SSE
    if (config.url.includes("/mcp_proxy/")) {
      try {
        const response = await fetch(config.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...config.headers,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {},
          }),
          signal: AbortSignal.timeout(5_000),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();

        if (result.error) {
          throw new Error(
            `JSON-RPC error ${result.error.code}: ${result.error.message}`,
          );
        }

        const toolsList = result.result?.tools || [];

        // Transform tools to our format
        return toolsList.map((tool: Tool) => ({
          name: tool.name,
          description: tool.description || `Tool: ${tool.name}`,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        }));
      } catch (error) {
        throw new Error(
          `Failed to connect to MCP server ${config.name}: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        );
      }
    }

    // For remote servers, use the standard MCP SDK client
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

      // Add timeout wrapper for connection and tool listing (30 seconds)
      const connectPromise = client.connect(transport);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("Connection timeout after 30 seconds"));
        }, 30000);
      });

      await Promise.race([connectPromise, timeoutPromise]);
      this.clients.set(clientId, client);

      // List available tools with timeout
      const listToolsPromise = client.listTools();
      const listTimeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("List tools timeout after 30 seconds"));
        }, 30000);
      });

      const toolsResult = await Promise.race([
        listToolsPromise,
        listTimeoutPromise,
      ]);

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

    // For internal /mcp_proxy endpoints, add JWT auth
    if (url.includes("/mcp_proxy/")) {
      headers.Authorization = `Bearer ${getInternalJwt()}`;
    }
    // All tokens (OAuth and PAT) are stored as access_token
    else if (secrets.access_token) {
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
        logger.error({ err: error }, `Error closing MCP client ${clientId}:`);
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
        logger.error({ err: error }, "Error closing active MCP connection:");
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
  mcpClient.disconnectAll().catch(logger.error);
});

process.on("SIGINT", () => {
  mcpClient.disconnectAll().catch(logger.error);
  process.exit(0);
});

process.on("SIGTERM", () => {
  mcpClient.disconnectAll().catch(logger.error);
  process.exit(0);
});
