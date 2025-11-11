import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
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
  InternalMcpCatalog,
} from "@/types";
import { K8sAttachTransport } from "./k8s-attach-transport";

/**
 * Type for MCP tool with server metadata returned from database
 */
type McpToolWithServerMetadata = {
  toolName: string;
  responseModifierTemplate: string | null;
  mcpServerSecretId: string | null;
  mcpServerName: string | null;
  mcpServerCatalogId: string | null;
  mcpServerId: string | null;
  credentialSourceMcpServerId: string | null;
  executionSourceMcpServerId: string | null;
  catalogId: string | null;
  catalogName: string | null;
};

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
    // Validate and get tool metadata
    const validationResult = await this.validateAndGetTool(toolCall, agentId);
    if ("error" in validationResult) {
      return validationResult.error;
    }
    const { tool, catalogItem } = validationResult;

    // Get execution context (server ID and secrets)
    const contextResult = await this.getExecutionContext(
      tool,
      toolCall,
      agentId,
    );
    if ("error" in contextResult) {
      return contextResult.error;
    }
    const { targetMcpServerId, secrets } = contextResult;

    try {
      // Get the appropriate transport
      const transport = await this.getTransport(
        catalogItem,
        targetMcpServerId,
        secrets,
      );

      // Use catalog ID + secret ID as cache key for connection reuse
      let secretId: string | null = null;
      if (tool.credentialSourceMcpServerId) {
        const credentialSourceServer = await McpServerModel.findById(
          tool.credentialSourceMcpServerId,
        );
        secretId = credentialSourceServer?.secretId || null;
      }

      const connectionKey = secretId
        ? `${catalogItem.id}:${secretId}`
        : catalogItem.id;

      // Get or create client
      const client = await this.getOrCreateClient(connectionKey, transport);

      // Strip prefix and execute (same for all transports!)
      const prefixName = tool.catalogName || tool.mcpServerName || "unknown";
      const mcpToolName = this.stripServerPrefix(toolCall.name, prefixName);

      const result = await client.callTool({
        name: mcpToolName,
        arguments: toolCall.arguments,
      });

      // Apply template and return
      return await this.createSuccessResult(
        toolCall,
        agentId,
        tool.mcpServerName || "unknown",
        result.content,
        !!result.isError,
        tool.responseModifierTemplate,
      );
    } catch (error) {
      return await this.createErrorResult(
        toolCall,
        agentId,
        error instanceof Error ? error.message : "Unknown error",
        tool.mcpServerName || "unknown",
      );
    }
  }

  /**
   * Get or create a client with the given transport
   */
  private async getOrCreateClient(
    connectionKey: string,
    transport: import("@modelcontextprotocol/sdk/shared/transport.js").Transport,
  ): Promise<Client> {
    // Check if we already have an active connection
    const existingClient = this.activeConnections.get(connectionKey);
    if (existingClient) {
      return existingClient;
    }

    // Create new client
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
   * Validate tool and get metadata
   */
  private async validateAndGetTool(
    toolCall: CommonToolCall,
    agentId: string,
  ): Promise<
    | { tool: McpToolWithServerMetadata; catalogItem: InternalMcpCatalog }
    | { error: CommonToolResult }
  > {
    // Get MCP tool
    const mcpTools = await ToolModel.getMcpToolsAssignedToAgent(
      [toolCall.name],
      agentId,
    );
    const tool = mcpTools[0];

    if (!tool) {
      return {
        error: await this.createErrorResult(
          toolCall,
          agentId,
          "Tool not found or not assigned to agent",
        ),
      };
    }

    // Validate catalogId
    if (!tool.catalogId) {
      return {
        error: await this.createErrorResult(
          toolCall,
          agentId,
          "Tool is missing catalogId",
          tool.mcpServerName || "unknown",
        ),
      };
    }

    // Get catalog item
    const catalogItem = await InternalMcpCatalogModel.findById(tool.catalogId);
    if (!catalogItem) {
      return {
        error: await this.createErrorResult(
          toolCall,
          agentId,
          `No catalog item found for tool catalog ID ${tool.catalogId}`,
          tool.mcpServerName || "unknown",
        ),
      };
    }

    return { tool, catalogItem };
  }

  /**
   * Get execution target and secrets
   */
  private async getExecutionContext(
    tool: McpToolWithServerMetadata,
    toolCall: CommonToolCall,
    agentId: string,
  ): Promise<
    | { targetMcpServerId: string; secrets: Record<string, unknown> }
    | { error: CommonToolResult }
  > {
    // Determine target server
    const targetMcpServerId =
      tool.executionSourceMcpServerId || tool.mcpServerId;

    if (!targetMcpServerId) {
      return {
        error: await this.createErrorResult(
          toolCall,
          agentId,
          "No execution source specified for MCP tool",
          tool.mcpServerName || "unknown",
        ),
      };
    }

    // Load secrets
    let secrets: Record<string, unknown> = {};
    if (tool.credentialSourceMcpServerId) {
      const credentialSourceServer = await McpServerModel.findById(
        tool.credentialSourceMcpServerId,
      );
      if (credentialSourceServer?.secretId) {
        const secret = await SecretModel.findById(
          credentialSourceServer.secretId,
        );
        if (secret?.secret) {
          secrets = secret.secret;
        }
      }
    }

    return { targetMcpServerId, secrets };
  }

  /**
   * Get appropriate transport based on server type and configuration
   */
  private async getTransport(
    catalogItem: InternalMcpCatalog,
    targetMcpServerId: string,
    secrets: Record<string, unknown>,
  ): Promise<
    import("@modelcontextprotocol/sdk/shared/transport.js").Transport
  > {
    if (catalogItem.serverType === "local") {
      const usesStreamableHttp =
        await McpServerRuntimeManager.usesStreamableHttp(targetMcpServerId);

      if (usesStreamableHttp) {
        // HTTP transport
        const url =
          McpServerRuntimeManager.getHttpEndpointUrl(targetMcpServerId);
        if (!url) {
          throw new Error(
            "No HTTP endpoint URL found for streamable-http server",
          );
        }

        return new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: new Headers({}) },
        });
      }

      // Stdio transport - use K8s attach!
      const k8sPod = McpServerRuntimeManager.getPod(targetMcpServerId);
      if (!k8sPod) {
        throw new Error("Pod not found for MCP server");
      }

      return new K8sAttachTransport({
        k8sAttach: k8sPod.k8sAttachClient,
        namespace: k8sPod.k8sNamespace,
        podName: k8sPod.k8sPodName,
        containerName: "mcp-server",
      });
    }

    // Remote server
    if (catalogItem.serverType === "remote") {
      if (!catalogItem.serverUrl) {
        throw new Error("Remote server missing serverUrl");
      }

      const headers: Record<string, string> = {};
      if (secrets.access_token) {
        headers.Authorization = `Bearer ${secrets.access_token}`;
      }

      return new StreamableHTTPClientTransport(new URL(catalogItem.serverUrl), {
        requestInit: { headers: new Headers(headers) },
      });
    }

    throw new Error(`Unsupported server type: ${catalogItem.serverType}`);
  }

  /**
   * Strip server prefix from tool name
   */
  private stripServerPrefix(toolName: string, prefixName: string): string {
    const serverPrefix = `${prefixName}__`;
    return toolName.startsWith(serverPrefix)
      ? toolName.substring(serverPrefix.length)
      : toolName;
  }

  /**
   * Apply response modifier template with fallback
   */
  private applyTemplate(
    content: unknown,
    template: string | null,
    toolName: string,
  ): unknown {
    if (!template) {
      return content;
    }

    try {
      return applyResponseModifierTemplate(template, content);
    } catch (error) {
      logger.error(
        { err: error },
        `Error applying response modifier template for tool ${toolName}`,
      );
      return content; // Fallback to original
    }
  }

  /**
   * Create and persist an error result
   */
  private async createErrorResult(
    toolCall: CommonToolCall,
    agentId: string,
    error: string,
    mcpServerName: string = "unknown",
  ): Promise<CommonToolResult> {
    const errorResult: CommonToolResult = {
      id: toolCall.id,
      content: null,
      isError: true,
      error,
    };

    await this.persistToolCall(agentId, mcpServerName, toolCall, errorResult);
    return errorResult;
  }

  /**
   * Create success result with template application
   */
  private async createSuccessResult(
    toolCall: CommonToolCall,
    agentId: string,
    mcpServerName: string,
    content: unknown,
    isError: boolean,
    template: string | null,
  ): Promise<CommonToolResult> {
    const modifiedContent = this.applyTemplate(
      content,
      template,
      toolCall.name,
    );

    const toolResult: CommonToolResult = {
      id: toolCall.id,
      content: modifiedContent,
      isError,
    };

    await this.persistToolCall(agentId, mcpServerName, toolCall, toolResult);
    return toolResult;
  }

  /**
   * Persist tool call to database with error handling
   */
  private async persistToolCall(
    agentId: string,
    mcpServerName: string,
    toolCall: CommonToolCall,
    toolResult: CommonToolResult,
  ): Promise<void> {
    try {
      const savedToolCall = await McpToolCallModel.create({
        agentId,
        mcpServerName,
        method: "tools/call",
        toolCall,
        toolResult,
      });

      const logData: {
        id: string;
        toolName: string;
        error?: string;
        resultContent?: string;
      } = {
        id: savedToolCall.id,
        toolName: toolCall.name,
      };

      if (toolResult.isError) {
        logData.error = toolResult.error;
      } else {
        logData.resultContent =
          typeof toolResult.content === "string"
            ? toolResult.content.substring(0, 100)
            : JSON.stringify(toolResult.content).substring(0, 100);
      }

      logger.info(
        logData,
        `✅ Saved MCP tool call (${toolResult.isError ? "error" : "success"}):`,
      );
    } catch (dbError) {
      logger.error({ err: dbError }, "Failed to persist MCP tool call");
    }
  }

  /**
   * Create a timeout promise
   */
  private createTimeout(ms: number, message: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    });
  }

  /**
   * Connect to an MCP server and return available tools
   */
  async connectAndGetTools(params: {
    catalogItem: InternalMcpCatalog;
    mcpServerId: string;
    secrets: Record<string, unknown>;
  }): Promise<CommonMcpToolDefinition[]> {
    const { catalogItem, mcpServerId, secrets } = params;

    // For local servers, retry connection a few times since the MCP server process
    // may need time to initialize even after the pod is ready
    const maxRetries = catalogItem.serverType === "local" ? 3 : 1;
    const retryDelayMs = 5000; // 5 seconds between retries

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Get the appropriate transport using the existing helper
        const transport = await this.getTransport(
          catalogItem,
          mcpServerId,
          secrets,
        );

        // Create client with transport
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

        // Connect with timeout
        await Promise.race([
          client.connect(transport),
          this.createTimeout(30000, "Connection timeout after 30 seconds"),
        ]);

        // List tools with timeout
        const toolsResult = await Promise.race([
          client.listTools(),
          this.createTimeout(30000, "List tools timeout after 30 seconds"),
        ]);

        // Close connection (we just needed the tools)
        await client.close();

        // Transform tools to our format
        return toolsResult.tools.map((tool: Tool) => ({
          name: tool.name,
          description: tool.description || `Tool: ${tool.name}`,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        }));
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Unknown error");

        // If this is not the last attempt, log and retry
        if (attempt < maxRetries) {
          logger.warn(
            { attempt, maxRetries, err: error },
            `Failed to connect to MCP server ${catalogItem.name} (attempt ${attempt}/${maxRetries}). Retrying in ${retryDelayMs}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }

        // Last attempt failed, throw error
        throw new Error(
          `Failed to connect to MCP server ${catalogItem.name}: ${lastError.message}`,
        );
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new Error(
      `Failed to connect to MCP server ${catalogItem.name}: ${
        lastError?.message || "Unknown error"
      }`,
    );
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
