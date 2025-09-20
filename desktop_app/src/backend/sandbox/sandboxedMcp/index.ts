import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type experimental_MCPClient, experimental_createMCPClient } from 'ai';
import type { RawReplyDefaultExpression } from 'fastify';

import config from '@backend/config';
import { type McpServer } from '@backend/models/mcpServer';
import { type Tool, ToolModel } from '@backend/models/tools';
import PodmanContainer from '@backend/sandbox/podman/container';
import { type AvailableTool, type SandboxedMcpServerStatusSummary } from '@backend/sandbox/schemas';
import { areTokensExpired } from '@backend/server/plugins/mcp-oauth';
import log from '@backend/utils/logger';
import WebSocketService from '@backend/websocket';
import { constructToolId, deconstructToolId } from '@constants';

const { host: proxyMcpServerHost, port: proxyMcpServerPort } = config.server.http;

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

  // Assigned HTTP port for streamable HTTP servers (stored in memory)
  assignedHttpPort?: number;
  private analysisUpdateInterval: NodeJS.Timeout | null = null;

  tools: McpTools = {};
  private cachedToolAnalysis: Map<
    string,
    {
      is_read: boolean | null;
      is_write: boolean | null;
      analyzed_at: string | null;
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
      // For local servers, set up container first
      if (!podmanSocketPath) {
        throw new Error(`Local server ${mcpServer.id} requires podmanSocketPath`);
      }
      this.podmanSocketPath = podmanSocketPath;
      this.podmanContainer = new PodmanContainer(mcpServer, podmanSocketPath);

      // For streamable HTTP servers, use direct container URL instead of proxy
      if (this.isStreamableHttpServer()) {
        // We'll set this dynamically after container starts and port is discovered
        this.mcpServerUrl = 'http://localhost:0/mcp'; // Placeholder, will be updated
      } else {
        // For stdio servers, use the proxy URL
        this.mcpServerUrl = this.mcpServerProxyUrl;
      }
    }

    // Set up periodic updates for cached analysis
    this.startPeriodicAnalysisUpdates();
  }

  /**
   * Get the assigned HTTP port for streamable HTTP servers
   */
  getAssignedHttpPort(): number | undefined {
    return this.podmanContainer?.assignedHttpPort;
  }

  /**
   * Check if this server is a streamable HTTP server based on OAuth config
   */
  isStreamableHttpServer(): boolean {
    try {
      const oauthConfig = this.mcpServer.oauthConfig ? JSON.parse(this.mcpServer.oauthConfig as any) : null;
      return !!oauthConfig?.streamable_http_url;
    } catch {
      return false;
    }
  }

  /**
   * Update the MCP server URL for streamable HTTP servers after port discovery
   */
  updateStreamableHttpUrl(): void {
    if (!this.isStreamableHttpServer() || !this.podmanContainer) {
      return;
    }

    const assignedPort = this.podmanContainer.assignedHttpPort;
    if (!assignedPort) {
      log.warn(`Cannot update streamable HTTP URL: no assigned port for ${this.mcpServerId}`);
      return;
    }

    try {
      const oauthConfig = this.mcpServer.oauthConfig ? JSON.parse(this.mcpServer.oauthConfig as any) : null;
      const streamableHttpUrl = oauthConfig?.streamable_http_url;

      if (streamableHttpUrl) {
        const url = new URL(streamableHttpUrl);
        url.port = assignedPort.toString();
        this.mcpServerUrl = url.toString();
      }
    } catch (error) {
      log.error(`Failed to update streamable HTTP URL for ${this.mcpServerId}:`, error);
    }
  }

  /**
   * Cache the tool with whatever analysis data it has (nulls are fine)
   */
  private updateToolInCache(tool: Tool) {
    this.cachedToolAnalysis.set(constructToolId(this.mcpServerId, tool.name), {
      is_read: tool.is_read,
      is_write: tool.is_write,
      analyzed_at: tool.analyzed_at,
    });
  }

  /**
   * Try to fetch cached tool analysis results from the database
   */
  private async fetchCachedTools() {
    try {
      log.info(`[fetchCachedTools] Fetching cached tools for ${this.mcpServerId}`);
      const cachedTools = await ToolModel.getByMcpServerId(this.mcpServerId);
      log.info(`[fetchCachedTools] Found ${cachedTools.length} tools in database for ${this.mcpServerId}`);

      if (cachedTools.length > 0) {
        // Count how many tools actually have analysis results
        let analyzedCount = 0;

        // Cache all tools from the database, regardless of analysis status
        for (const cachedTool of cachedTools) {
          this.updateToolInCache(cachedTool);

          // Count tools that have been analyzed
          if (cachedTool.analyzed_at) {
            analyzedCount++;
          }
        }

        log.info(
          `[fetchCachedTools] Cached ${cachedTools.length} tools for ${this.mcpServerId} (${analyzedCount} analyzed)`
        );

        // Always broadcast when we cache tools, regardless of analysis status
        WebSocketService.broadcast({
          type: 'tools-updated',
          payload: {
            mcpServerId: this.mcpServerId,
            message: `Loaded ${cachedTools.length} tools (${analyzedCount} analyzed)`,
          },
        });
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

        // Check if this tool's analysis has changed
        if (
          !cachedAnalysis ||
          cachedAnalysis.is_read !== tool.is_read ||
          cachedAnalysis.is_write !== tool.is_write ||
          cachedAnalysis.analyzed_at !== tool.analyzed_at
        ) {
          this.updateToolInCache(tool);
          hasUpdates = true;
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
        // Broadcast that tools have been updated
        WebSocketService.broadcast({
          type: 'tools-updated',
          payload: {
            mcpServerId: this.mcpServerId,
            message: `Tool analysis updated for ${this.mcpServer.name}`,
          },
        });
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
      const toolId = constructToolId(this.mcpServerId, toolName);
      this.tools[toolId] = tool;
    }

    const newToolCount = Object.keys(this.tools).length;
    log.info(`Fetched ${newToolCount} tools for ${this.mcpServerId}`);

    // If we have new tools or the count changed, analyze them
    if (newToolCount > 0 && (newToolCount !== previousToolCount || previousToolCount === 0)) {
      try {
        log.info(`Starting async analysis of tools for ${this.mcpServerId}...`);
        await ToolModel.analyze(tools, this.mcpServerId);

        // After tools are saved to database, try to fetch any existing cached analysis
        // This is important because on first startup, fetchCachedTools() in constructor
        // runs before tools exist in the database
        await this.fetchCachedTools();

        // Broadcast that tools are now available (even if not yet analyzed)
        WebSocketService.broadcast({
          type: 'tools-updated',
          payload: {
            mcpServerId: this.mcpServerId,
            message: `Discovered ${newToolCount} tools for ${this.mcpServer.name}`,
          },
        });
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

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Check if this MCP server has OAuth tokens
        const headers: Record<string, string> = {};

        if (this.mcpServer.oauthTokens?.access_token) {
          try {
            // We need the OAuth config to refresh tokens, but it's not stored with the server
            // For now, check if tokens are expired manually and warn if they might be
            // Ensure token has required fields for MCP SDK compatibility
            const tokensWithDefaults = {
              ...this.mcpServer.oauthTokens,
              token_type: this.mcpServer.oauthTokens.token_type || 'Bearer', // Default to Bearer if not set
            };

            if (areTokensExpired(tokensWithDefaults, 5)) {
              log.warn(
                `OAuth tokens for ${this.mcpServerId} are expired or expiring soon. You may need to reinstall the server to refresh OAuth tokens.`
              );
            }

            headers['Authorization'] = `Bearer ${this.mcpServer.oauthTokens.access_token}`;
          } catch (error) {
            log.warn(`Failed to validate OAuth tokens for ${this.mcpServerId}:`, error);
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

        // Success - break out of retry loop
        return;
      } catch (error) {
        lastError = error as Error;
        log.error(`Failed to connect MCP client for ${this.mcpServerId} (attempt ${attempt}/${maxRetries}):`, error);

        if (attempt < maxRetries) {
          // Wait before retry with exponential backoff
          const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // 1s, 2s, 4s (capped at 5s)
          log.info(`Retrying MCP client connection in ${waitTime}ms...`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }
    }

    // If we get here, all retries failed
    const errorMsg = `Failed to create MCP client for ${this.mcpServerId} after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`;
    log.error(errorMsg);
    throw new Error(errorMsg);
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
    const MAX_PING_ATTEMPTS = 30;
    const BASE_PING_INTERVAL_MS = 1000;
    let attempts = 0;

    while (attempts < MAX_PING_ATTEMPTS) {
      try {
        // Initialize MCP client connection for this ping attempt
        if (!this.mcpClient) {
          await this.createMcpClient();
        }

        // Use MCP client's tools() method as a health check
        await this.mcpClient.tools();

        return;
      } catch (error) {
        attempts++;

        if (attempts >= MAX_PING_ATTEMPTS) {
          const errorMsg = `MCP server container ${this.mcpServerId} failed to become healthy after ${MAX_PING_ATTEMPTS} attempts`;
          log.error(errorMsg);
          throw new Error(errorMsg);
        }

        // Exponential backoff with jitter for OAuth containers
        const backoffMultiplier = this.mcpServer.oauthTokens ? 1.2 : 1.0;
        const jitter = Math.random() * 200;
        const waitTime = Math.min(BASE_PING_INTERVAL_MS * Math.pow(backoffMultiplier, attempts) + jitter, 5000);

        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
  }

  async start() {
    // Ensure cache is populated before proceeding
    await this.fetchCachedTools();

    if (this.isRemoteServer) {
      // For remote servers, skip container operations
      log.info(`Starting remote MCP server: ${this.mcpServer.name}`);
      await this.createMcpClient();
      await this.fetchTools();
    } else {
      // For local servers, use existing container startup logic
      log.info(`Starting local MCP server: ${this.mcpServer.name}`);

      // Validate OAuth tokens are properly set if this is an OAuth server
      if (this.mcpServer.oauthTokens && !this.mcpServer.oauthTokens.access_token) {
        throw new Error(`OAuth MCP server ${this.mcpServer.name} is missing access_token - cannot start container`);
      }

      this.podmanContainer = new PodmanContainer(this.mcpServer, this.podmanSocketPath!);

      try {
        await this.podmanContainer.startOrCreateContainer();

        // For streamable HTTP servers, update the URL with the discovered port
        if (this.isStreamableHttpServer()) {
          this.updateStreamableHttpUrl();
        }

        await this.pingMcpServerContainerUntilHealthy();
        await this.createMcpClient();
        await this.fetchTools();

        /**
         * Fetch cached tools again after tools are discovered
         * This ensures the cache is up-to-date with any newly discovered tools
         */
        await this.fetchCachedTools();

        log.info(`Successfully started MCP server: ${this.mcpServer.name} (OAuth: ${!!this.mcpServer.oauthTokens})`);
      } catch (error) {
        log.error(`Failed to start MCP server container ${this.mcpServer.name}:`, error);

        // Clean up container if it was created but startup failed
        if (this.podmanContainer) {
          try {
            await this.podmanContainer.removeContainer();
            log.info(`Cleaned up failed container for MCP server: ${this.mcpServer.name}`);
          } catch (cleanupError) {
            log.warn(`Failed to clean up container for MCP server ${this.mcpServer.name}:`, cleanupError);
          }
        }

        throw error;
      }
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
      // Get analysis results from cache if available
      const cachedAnalysis = this.cachedToolAnalysis.get(id);

      // Check if the tool has actually been analyzed (has analyzed_at timestamp)
      const hasAnalysis =
        cachedAnalysis && cachedAnalysis.analyzed_at !== null && cachedAnalysis.analyzed_at !== undefined;

      return {
        id,
        name: deconstructToolId(id).toolName,
        description: tool.description,
        inputSchema: this.cleanToolInputSchema(tool.inputSchema),
        mcpServerId: this.mcpServerId,
        mcpServerName: this.mcpServer.name,
        // Include analysis results - show correct status based on whether analysis exists
        analysis: hasAnalysis
          ? {
              status: 'completed',
              error: null,
              is_read: cachedAnalysis.is_read,
              is_write: cachedAnalysis.is_write,
            }
          : {
              status: 'awaiting_ollama_model',
              error: null,
              is_read: null,
              is_write: null,
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
