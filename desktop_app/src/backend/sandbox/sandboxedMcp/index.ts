import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type experimental_MCPClient, experimental_createMCPClient } from 'ai';
import type { RawReplyDefaultExpression } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import config from '@backend/config';
import { type McpServer } from '@backend/models/mcpServer';
import { ToolModel } from '@backend/models/tools';
import PodmanContainer, { PodmanContainerStatusSummarySchema } from '@backend/sandbox/podman/container';
import log from '@backend/utils/logger';

const { host: proxyMcpServerHost, port: proxyMcpServerPort } = config.server.http;

/**
 * We use a double underscore to separate the MCP server ID from the tool name.
 *
 * this is for LLM compatability..
 */
const TOOL_ID_SEPARATOR = '__';

export const McpServerContainerLogsSchema = z.object({
  logs: z.string(),
  containerName: z.string(),
});

export const AvailableToolSchema = z.object({
  id: z.string().describe('Tool ID in format sanitizedServerId__sanitizedToolName'),
  name: z.string().describe('Tool name'),
  description: z.string().optional().describe('Tool description'),
  inputSchema: z.any().optional().describe('Tool input schema'),
  mcpServerId: z.string().describe('MCP server ID'),
  mcpServerName: z.string().describe('MCP server name'),
  // Analysis results
  analysis: z
    .object({
      status: z.enum(['awaiting_ollama_model', 'in_progress', 'error', 'completed']).describe('Analysis status'),
      error: z.string().nullable().describe('Error message if analysis failed'),
      is_read: z.boolean().nullable().describe('Whether the tool is read-only'),
      is_write: z.boolean().nullable().describe('Whether the tool writes data'),
      idempotent: z.boolean().nullable().describe('Whether the tool is idempotent'),
      reversible: z.boolean().nullable().describe('Whether the tool actions are reversible'),
    })
    .describe('Tool analysis results'),
});

export const SandboxedMcpServerStatusSummarySchema = z.object({
  container: PodmanContainerStatusSummarySchema,
  tools: z.array(AvailableToolSchema),
});

export type McpTools = Awaited<ReturnType<experimental_MCPClient['tools']>>;
export type AvailableTool = z.infer<typeof AvailableToolSchema>;
type SandboxedMcpServerStatusSummary = z.infer<typeof SandboxedMcpServerStatusSummarySchema>;

/**
 * SandboxedMcpServer represents an MCP server running in a podman container.
 */
export default class SandboxedMcpServer {
  mcpServer: McpServer;

  private mcpServerId: string;
  private mcpServerProxyUrl: string;

  private podmanSocketPath: string;
  private podmanContainer: PodmanContainer;

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

  constructor(mcpServer: McpServer, podmanSocketPath: string) {
    this.mcpServer = mcpServer;
    this.mcpServerId = mcpServer.id;
    this.mcpServerProxyUrl = `http://${proxyMcpServerHost}:${proxyMcpServerPort}/mcp_proxy/${this.mcpServerId}`;

    this.podmanSocketPath = podmanSocketPath;
    this.podmanContainer = new PodmanContainer(mcpServer, podmanSocketPath);

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
      const transport = new StreamableHTTPClientTransport(new URL(this.mcpServerProxyUrl));
      this.mcpClient = await experimental_createMCPClient({ transport });
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
    this.podmanContainer = new PodmanContainer(this.mcpServer, this.podmanSocketPath);

    await this.podmanContainer.startOrCreateContainer();
    await this.pingMcpServerContainerUntilHealthy();
    await this.createMcpClient();
    await this.fetchTools();
  }

  async stop() {
    this.stopPeriodicAnalysisUpdates();

    await this.podmanContainer.stopContainer();

    if (this.mcpClient) {
      await this.mcpClient.close();
    }
  }

  /**
   * Stream a request to the MCP server container
   */
  async streamToContainer(request: any, responseStream: RawReplyDefaultExpression) {
    await this.podmanContainer.streamToContainer(request, responseStream);
  }

  /**
   * Get the last N lines of logs from the MCP server container
   */
  async getMcpServerLogs(lines: number = 100) {
    return {
      logs: await this.podmanContainer.getRecentLogs(lines),
      containerName: this.podmanContainer.containerName,
    };
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
    return {
      container: this.podmanContainer.statusSummary,
      tools: this.availableToolsList,
    };
  }
}
