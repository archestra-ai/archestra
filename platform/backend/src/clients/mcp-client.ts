import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
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

// Get the API base URL from config
const API_BASE_URL =
  process.env.ARCHESTRA_API_BASE_URL || `http://localhost:${config.api.port}`;

class McpClient {
  private clients = new Map<string, Client>();
  private activeConnections = new Map<string, Client>();

  /**
   * Helper to persist error results for tool calls
   */
  private async persistErrorResults(
    mcpToolCalls: CommonToolCall[],
    agentId: string,
    mcpServerName: string,
    errorMessage: string,
  ): Promise<CommonToolResult[]> {
    const results: CommonToolResult[] = [];

    for (const toolCall of mcpToolCalls) {
      const toolResult: CommonToolResult = {
        id: toolCall.id,
        content: null,
        isError: true,
        error: errorMessage,
      };

      results.push(toolResult);

      // Persist error to database
      try {
        await McpToolCallModel.create({
          agentId,
          mcpServerName,
          toolCall,
          toolResult,
        });
        logger.info(
          {
            toolName: toolCall.name,
            error: errorMessage,
          },
          "✅ Saved early-return error:",
        );
      } catch (dbError) {
        logger.error({ err: dbError }, "Failed to persist early-return error:");
      }
    }

    return results;
  }

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
      return await this.persistErrorResults(
        mcpToolCalls,
        agentId,
        "unknown",
        "No MCP tools found",
      );
    }

    // Determine which MCP server to route to
    // Use executionSourceMcpServerId if present (for local servers), otherwise fall back to mcpServerId
    const targetMcpServerId =
      firstTool.executionSourceMcpServerId || firstTool.mcpServerId;

    if (!targetMcpServerId) {
      return await this.persistErrorResults(
        mcpToolCalls,
        agentId,
        firstTool.mcpServerName || "unknown",
        "No execution source specified for MCP tool",
      );
    }

    // Load secrets from the secrets table
    // The credential source MCP server must be explicitly selected (team or user token)
    let secrets: Record<string, unknown> = {};
    let secretId: string | null = null;

    if (firstTool.credentialSourceMcpServerId) {
      // User selected a specific token (team or user) to use
      const credentialSourceServer = await McpServerModel.findById(
        firstTool.credentialSourceMcpServerId,
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
      if (!firstTool.catalogId) {
        return await this.persistErrorResults(
          mcpToolCalls,
          agentId,
          firstTool.mcpServerName || "unknown",
          "Tool is missing catalogId",
        );
      }

      const catalogItem = await InternalMcpCatalogModel.findById(
        firstTool.catalogId,
      );

      if (!catalogItem) {
        return await this.persistErrorResults(
          mcpToolCalls,
          agentId,
          firstTool.mcpServerName || "unknown",
          `No catalog item found for tool catalog ID ${firstTool.catalogId}`,
        );
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
            return await this.persistErrorResults(
              mcpToolCalls,
              agentId,
              firstTool.mcpServerName || "unknown",
              `No HTTP endpoint URL found for streamable-http server ${firstTool.mcpServerName || "unknown"}`,
            );
          }

          // Use the same logic as remote servers with StreamableHTTPClientTransport
          const client = await this.getOrCreateConnection(targetMcpServerId, {
            id: targetMcpServerId,
            url: httpEndpointUrl,
            name: firstTool.mcpServerName || "unknown",
            headers: {},
          });

          // Execute each MCP tool call via the HTTP client
          for (const toolCall of mcpToolCalls) {
            try {
              // Strip the server prefix from tool name for MCP server call
              // For local servers, use catalog name (without userId) for prefix
              const prefixName =
                firstTool.catalogName || firstTool.mcpServerName || "unknown";
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
              const template = templatesByToolName.get(toolCall.name);
              if (template) {
                try {
                  modifiedContent = applyResponseModifierTemplate(
                    template,
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

              results.push(toolResult);

              // Persist tool call and result to database
              try {
                const savedToolCall = await McpToolCallModel.create({
                  agentId,
                  mcpServerName: firstTool.mcpServerName || "unknown",
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
                // Continue execution even if persistence fails
              }
            } catch (error) {
              const toolResult: CommonToolResult = {
                id: toolCall.id,
                content: null,
                isError: true,
                error: error instanceof Error ? error.message : "Unknown error",
              };

              results.push(toolResult);

              // Persist failed tool call to database
              try {
                const savedToolCall = await McpToolCallModel.create({
                  agentId,
                  mcpServerName: firstTool.mcpServerName || "unknown",
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
            }
          }

          return results;
        }

        // For stdio-based local servers, use direct JSON-RPC calls via proxy
        const proxyUrl = `${API_BASE_URL}/mcp_proxy/${targetMcpServerId}`;

        // Execute each MCP tool call via direct JSON-RPC
        for (const toolCall of mcpToolCalls) {
          try {
            // Strip the server prefix from tool name for MCP server call
            // For local servers, use catalog name (without userId) for prefix
            const prefixName =
              firstTool.catalogName || firstTool.mcpServerName || "unknown";
            const serverPrefix = `${prefixName}__`;
            const mcpToolName = toolCall.name.startsWith(serverPrefix)
              ? toolCall.name.substring(serverPrefix.length)
              : toolCall.name;

            const response = await fetch(proxyUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
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
            });

            if (!response.ok) {
              throw new Error(
                `HTTP ${response.status}: ${response.statusText}`,
              );
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
            const template = templatesByToolName.get(toolCall.name);
            if (template) {
              try {
                modifiedContent = applyResponseModifierTemplate(
                  template,
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

            results.push(toolResult);

            // Persist tool call and result to database
            try {
              const savedToolCall = await McpToolCallModel.create({
                agentId,
                mcpServerName: firstTool.mcpServerName || "unknown",
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
              // Continue execution even if persistence fails
            }
          } catch (error) {
            const toolResult: CommonToolResult = {
              id: toolCall.id,
              content: null,
              isError: true,
              error: error instanceof Error ? error.message : "Unknown error",
            };

            results.push(toolResult);

            // Persist failed tool call to database
            try {
              const savedToolCall = await McpToolCallModel.create({
                agentId,
                mcpServerName: firstTool.mcpServerName || "unknown",
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
              // Continue execution even if persistence fails
            }
          }
        }

        return results;
      }

      // For remote servers, use the standard MCP SDK client
      let client: Client | null = null;

      if (catalogItem.serverType === "remote") {
        // Generic remote server with catalog info
        const config = this.createServerConfig({
          name: firstTool.mcpServerName || "unknown",
          /**
           * TODO: update SelectInternalMcpCatalogSchema to be a discriminated union of remote and local types
           * this way that typescript knows that when serverType is remote, serverUrl will ALWAYS be set
           */
          url: catalogItem.serverUrl as string,
          secrets,
        });
        client = await this.getOrCreateConnection(catalogItem.id, config);

        if (catalogItem?.serverType === "remote" && catalogItem.serverUrl) {
          // Generic remote server with catalog info
          const config = this.createServerConfig({
            name: firstTool.mcpServerName || "unknown",
            url: catalogItem.serverUrl,
            secrets,
          });
          // Use catalog ID + secret ID as cache key to ensure different credentials = different connections
          const connectionKey = secretId
            ? `${catalogItem.id}:${secretId}`
            : catalogItem.id;
          client = await this.getOrCreateConnection(connectionKey, config);
        }
      } else {
        throw new Error(`Unsupported server type: ${catalogItem.serverType}`);
      }

      if (!client) {
        return await this.persistErrorResults(
          mcpToolCalls,
          agentId,
          firstTool.mcpServerName || "unknown",
          "Failed to create MCP client",
        );
      }

      // Execute each MCP tool call
      for (const toolCall of mcpToolCalls) {
        try {
          // Strip the server prefix from tool name for MCP server call
          // Tool name format: <server-name>__<native-tool-name>
          // Example: githubcopilot__remote-mcp__search_issues -> search_issues
          // For local servers, use catalog name (without userId) for prefix
          const prefixName =
            firstTool.catalogName || firstTool.mcpServerName || "unknown";
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
          const template = templatesByToolName.get(toolCall.name);
          if (template) {
            try {
              modifiedContent = applyResponseModifierTemplate(
                template,
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

          results.push(toolResult);

          // Persist tool call and result to database
          try {
            const savedToolCall = await McpToolCallModel.create({
              agentId,
              mcpServerName: firstTool.mcpServerName || "unknown",
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
            // Continue execution even if persistence fails
          }
        } catch (error) {
          const toolResult: CommonToolResult = {
            id: toolCall.id,
            content: null,
            isError: true,
            error: error instanceof Error ? error.message : "Unknown error",
          };

          results.push(toolResult);

          // Persist failed tool call to database
          try {
            const savedToolCall = await McpToolCallModel.create({
              agentId,
              mcpServerName: firstTool.mcpServerName || "unknown",
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
            // Continue execution even if persistence fails
          }
        }
      }
    } catch (error) {
      // MCP server connection failed - mark all tool calls as failed
      for (const toolCall of mcpToolCalls) {
        const toolResult: CommonToolResult = {
          id: toolCall.id,
          content: null,
          isError: true,
          error: `Failed to connect to MCP server: ${error instanceof Error ? error.message : "Unknown error"}`,
        };

        results.push(toolResult);

        // Persist connection failure to database
        try {
          await McpToolCallModel.create({
            agentId,
            mcpServerName: firstTool.mcpServerName || "unknown",
            toolCall,
            toolResult,
          });
        } catch (dbError) {
          logger.error({ err: dbError }, "Failed to persist MCP tool call:");
          // Continue execution even if persistence fails
        }
      }
    }

    return results;
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
