import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type experimental_MCPClient, experimental_createMCPClient } from 'ai';
import type { RawReplyDefaultExpression } from 'fastify';
import { v4 as uuidv4 } from 'uuid';

import config from '@backend/config';
import { type McpServer } from '@backend/models/mcpServer';
import { ToolModel } from '@backend/models/tools';
import PodmanContainer from '@backend/sandbox/podman/container';
import {
  type AvailableTool,
  AvailableToolSchema,
  McpServerContainerLogsSchema,
  type SandboxedMcpServerStatusSummary,
  SandboxedMcpServerStatusSummarySchema,
} from '@backend/sandbox/schemas';
import log from '@backend/utils/logger';

const { host: proxyMcpServerHost, port: proxyMcpServerPort } = config.server.http;

/**
 * We use a double underscore to separate the MCP server ID from the tool name.
 *
 * this is for LLM compatability..
 */
const TOOL_ID_SEPARATOR = '__';

// Re-export schemas for backward compatibility
export {
  AvailableToolSchema,
  McpServerContainerLogsSchema,
  SandboxedMcpServerStatusSummarySchema,
} from '@backend/sandbox/schemas';
export type { AvailableTool } from '@backend/sandbox/schemas';

export type McpTools = Awaited<ReturnType<experimental_MCPClient['tools']>>;

/**
 * SandboxedMcpServer represents an MCP server connection - either running in a local podman container
 * or connected to a remote MCP service via OAuth.
 */
export default class SandboxedMcpServer {
  mcpServer: McpServer;

  private mcpServerId: string;
  private mcpServerProxyUrl: string;
  private mcpServerUrl: string; // URL used for MCP client connection (proxy for local, remote_url for remote)
  private isRemoteServer: boolean;

  private podmanSocketPath?: string;
  private podmanContainer?: PodmanContainer;

  private mcpClient: experimental_MCPClient;
  private analysisUpdateInterval: NodeJS.Timeout | null = null;

  tools: McpTools = {};
  private cachedToolAnalysis: Map<
    string,
    {
      is_read: boolean | null;
      is_write: boolean | null;
      idempotent: boolean | null;
      reversible: boolean | null;
    }
  > = new Map();

  constructor(mcpServer: McpServer, podmanSocketPath?: string) {
    this.mcpServer = mcpServer;
    this.mcpServerId = mcpServer.id;
    this.mcpServerProxyUrl = `http://${proxyMcpServerHost}:${proxyMcpServerPort}/mcp_proxy/${this.mcpServerId}`;

    // Determine if this is a remote server
    this.isRemoteServer = mcpServer.serverType === 'remote';

    if (this.isRemoteServer) {
      // For remote servers, connect directly to the remote URL
      const remoteUrl = mcpServer.remoteUrl;
      if (!remoteUrl) {
        throw new Error(`Remote server ${mcpServer.id} missing remoteUrl field`);
      }
      this.mcpServerUrl = remoteUrl;
      log.info(`Creating SandboxedMcpServer for remote server: ${mcpServer.name} at ${remoteUrl}`);
    } else {
      // For local servers, use the proxy URL and set up container
      if (!podmanSocketPath) {
        throw new Error(`Local server ${mcpServer.id} requires podmanSocketPath`);
      }
      this.mcpServerUrl = this.mcpServerProxyUrl;
      this.podmanSocketPath = podmanSocketPath;
      this.podmanContainer = new PodmanContainer(mcpServer, podmanSocketPath);
      log.info(`Creating SandboxedMcpServer for local server: ${mcpServer.name} via proxy`);
    }

    // Try to fetch cached tools on initialization
    this.fetchCachedTools();

    // Set up periodic updates for cached analysis
    this.startPeriodicAnalysisUpdates();
  }

  /**
   * Try to fetch cached tool analysis results from the database
   */
  private async fetchCachedTools() {
    try {
      const cachedTools = await ToolModel.getByMcpServerId(this.mcpServerId);
      if (cachedTools.length > 0) {
        log.info(`Found ${cachedTools.length} cached tool analysis results for ${this.mcpServerId}`);

        // Only cache the analysis results, not the tools themselves
        for (const cachedTool of cachedTools) {
          // Cache the analysis results
          this.cachedToolAnalysis.set(cachedTool.name, {
            is_read: cachedTool.is_read,
            is_write: cachedTool.is_write,
            idempotent: cachedTool.idempotent,
            reversible: cachedTool.reversible,
          });
        }
      }
    } catch (error) {
      log.error(`Failed to fetch cached tool analysis results for ${this.mcpServerId}:`, error);
    }
  }

  /**
   * Update cached tool analysis results from database
   * This is called periodically to pick up background analysis results
   */
  private async updateCachedAnalysis() {
    try {
      const tools = await ToolModel.getByMcpServerId(this.mcpServerId);
      let hasUpdates = false;

      for (const tool of tools) {
        const cachedAnalysis = this.cachedToolAnalysis.get(tool.name);

        // Check if this tool has new analysis results
        if (
          tool.analyzed_at &&
          (!cachedAnalysis ||
            cachedAnalysis.is_read !== tool.is_read ||
            cachedAnalysis.is_write !== tool.is_write ||
            cachedAnalysis.idempotent !== tool.idempotent ||
            cachedAnalysis.reversible !== tool.reversible)
        ) {
          // Update cache
          this.cachedToolAnalysis.set(tool.name, {
            is_read: tool.is_read,
            is_write: tool.is_write,
            idempotent: tool.idempotent,
            reversible: tool.reversible,
          });
          hasUpdates = true;
          log.info(`Updated cached analysis for tool ${tool.name} in ${this.mcpServerId}`);
        }
      }

      return hasUpdates;
    } catch (error) {
      log.error(`Failed to update cached tool analysis for ${this.mcpServerId}:`, error);
      return false;
    }
  }

  /**
   * Start periodic updates for cached analysis
   */
  private startPeriodicAnalysisUpdates() {
    // Update every 5 seconds
    this.analysisUpdateInterval = setInterval(async () => {
      const hasUpdates = await this.updateCachedAnalysis();
      if (hasUpdates) {
        log.info(`Analysis cache updated for MCP server ${this.mcpServerId}`);
      }
    }, 5000);
  }

  /**
   * Stop periodic updates for cached analysis
   */
  private stopPeriodicAnalysisUpdates() {
    if (this.analysisUpdateInterval) {
      clearInterval(this.analysisUpdateInterval);
      this.analysisUpdateInterval = null;
    }
  }

  /**
   * Fetchs tools from the sandboxed MCP server's container and slightly transforms their "ids" to be in the format of
   * `<mcp_server_id>${TOOL_ID_SEPARATOR}<tool_name>`
   */
  private async fetchTools() {
    log.info(`Fetching tools for ${this.mcpServerId}...`);

    const tools = await this.mcpClient.tools();
    const previousToolCount = Object.keys(this.tools).length;

    // Clear existing tools to ensure we have fresh data
    this.tools = {};

    for (const [toolName, tool] of Object.entries(tools)) {
      const toolId = `${this.mcpServerId}${TOOL_ID_SEPARATOR}${toolName}`;
      this.tools[toolId] = tool;
    }

    const newToolCount = Object.keys(this.tools).length;
    log.info(`Fetched ${newToolCount} tools for ${this.mcpServerId}`);

    // If we have new tools or the count changed, analyze them
    if (newToolCount > 0 && (newToolCount !== previousToolCount || previousToolCount === 0)) {
      try {
        log.info(`Starting async analysis of tools for ${this.mcpServerId}...`);
        await ToolModel.analyze(tools, this.mcpServerId);
      } catch (error) {
        log.error(`Failed to save tools for ${this.mcpServerId}:`, error);
        // Continue even if saving fails
      }
    }
  }

  private async createMcpClient() {
    if (this.mcpClient) {
      return;
    }

    try {
      // Check if this MCP server has OAuth tokens
      const headers: Record<string, string> = {};

      if (this.mcpServer.oauthTokens?.access_token) {
        log.info(`Using OAuth authentication for MCP server ${this.mcpServerId}`);

        // Check if tokens are expired and refresh if needed
        try {
          const { ensureValidTokens } = await import('@backend/server/plugins/mcp-oauth');

          // Get server config based on provider (this needs to be determined from the server)
          // For now, we'll try to use the stored access token directly
          // TODO: Implement proper token refresh logic with provider configs
          headers['Authorization'] = `Bearer ${this.mcpServer.oauthTokens.access_token}`;
        } catch (error) {
          log.warn(`Failed to ensure valid OAuth tokens for ${this.mcpServerId}:`, error);
          // Fall back to using existing token
          headers['Authorization'] = `Bearer ${this.mcpServer.oauthTokens.access_token}`;
        }
      }

      // Use the appropriate URL: remote_url for remote servers, proxy URL for local servers
      const transport = new StreamableHTTPClientTransport(new URL(this.mcpServerUrl), {
        requestInit: {
          headers,
        },
      });

      this.mcpClient = await experimental_createMCPClient({ transport });

      if (this.mcpServer.oauthTokens?.access_token) {
        log.info(`✅ MCP client connected with OAuth authentication for ${this.mcpServerId}`);
      }
    } catch (error) {
      log.error(`Failed to connect MCP client for ${this.mcpServerId}:`, error);
    }
  }

  /**
   * This is a (semi) temporary way of ensuring that the MCP server container
   * is fully ready before attempting to communicate with it.
   *
   * https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/ping#ping
   *
   * TODO: this should be baked into the MCP Server Dockfile's health check (to replace the current one)
   */
  private async pingMcpServerContainerUntilHealthy() {
    const MAX_PING_ATTEMPTS = 10;
    const PING_INTERVAL_MS = 500;
    let attempts = 0;

    while (attempts < MAX_PING_ATTEMPTS) {
      log.info(`Pinging MCP server container ${this.mcpServerId} until healthy...`);

      const response = await fetch(this.mcpServerProxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: uuidv4(),
          method: 'ping',
        }),
      });

      if (response.ok) {
        log.info(`MCP server container ${this.mcpServerId} is healthy!`);
        return;
      } else {
        log.info(`MCP server container ${this.mcpServerId} is not healthy, retrying...`);
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, PING_INTERVAL_MS));
      }
    }
  }

  async start() {
    if (this.isRemoteServer) {
      // For remote servers, skip container operations
      log.info(`Starting remote MCP server: ${this.mcpServer.name}`);
      await this.createMcpClient();
      await this.fetchTools();
    } else {
      // For local servers, use existing container startup logic
      log.info(`Starting local MCP server: ${this.mcpServer.name}`);
      this.podmanContainer = new PodmanContainer(this.mcpServer, this.podmanSocketPath!);

      await this.podmanContainer.startOrCreateContainer();
      await this.pingMcpServerContainerUntilHealthy();
      await this.createMcpClient();
      await this.fetchTools();
    }
  }

  async stop() {
    this.stopPeriodicAnalysisUpdates();

    if (this.isRemoteServer) {
      // For remote servers, just close the MCP client
      log.info(`Stopping remote MCP server: ${this.mcpServer.name}`);
    } else {
      // For local servers, stop the container
      log.info(`Stopping local MCP server: ${this.mcpServer.name}`);
      await this.podmanContainer!.stopContainer();
    }

    if (this.mcpClient) {
      await this.mcpClient.close();
    }
  }

  /**
   * Stream a request to the MCP server (container for local, direct for remote)
   */
  async streamToContainer(request: any, responseStream: RawReplyDefaultExpression) {
    if (this.isRemoteServer) {
      // For remote servers, we can't stream directly - this would need to be handled differently
      throw new Error(`Streaming not supported for remote MCP server ${this.mcpServerId}`);
    } else {
      await this.podmanContainer!.streamToContainer(request, responseStream);
    }
  }

  /**
   * Get the last N lines of logs from the MCP server
   */
  async getMcpServerLogs(lines: number = 100) {
    if (this.isRemoteServer) {
      // Remote servers don't have container logs
      return {
        logs: 'Remote MCP servers do not have container logs',
        containerName: `remote-${this.mcpServerId}`,
      };
    } else {
      return {
        logs: await this.podmanContainer!.getRecentLogs(lines),
        containerName: this.podmanContainer!.containerName,
      };
    }
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
   * This provides a list of tools in a slightly transformed format
   * that we expose to the UI
   */
  get availableToolsList(): AvailableTool[] {
    return Object.entries(this.tools).map(([id, tool]) => {
      const separatorIndex = id.indexOf(TOOL_ID_SEPARATOR);
      const toolName = separatorIndex !== -1 ? id.substring(separatorIndex + TOOL_ID_SEPARATOR.length) : id;

      // Get analysis results from cache if available
      const cachedAnalysis = this.cachedToolAnalysis.get(toolName);

      return {
        id,
        name: toolName,
        description: tool.description,
        inputSchema: this.cleanToolInputSchema(tool.inputSchema),
        mcpServerId: this.mcpServerId,
        mcpServerName: this.mcpServer.name,
        // Include analysis results - default to awaiting_ollama_model if not analyzed
        analysis: cachedAnalysis
          ? {
              status: 'completed',
              error: null,
              is_read: cachedAnalysis.is_read,
              is_write: cachedAnalysis.is_write,
              idempotent: cachedAnalysis.idempotent,
              reversible: cachedAnalysis.reversible,
            }
          : {
              status: 'awaiting_ollama_model',
              error: null,
              is_read: null,
              is_write: null,
              idempotent: null,
              reversible: null,
            },
      };
    });
  }

  get statusSummary(): SandboxedMcpServerStatusSummary {
    if (this.isRemoteServer) {
      // For remote servers, create a mock container status
      return {
        container: {
          state: this.mcpClient ? 'running' : 'not_created',
          startupPercentage: this.mcpClient ? 100 : 0,
          message: this.mcpClient ? 'Connected to remote MCP server' : 'Not connected',
          error: null,
        },
        tools: this.availableToolsList,
      };
    } else {
      // For local servers, use existing container status
      return {
        container: this.podmanContainer!.statusSummary,
        tools: this.availableToolsList,
      };
    }
  }
}
