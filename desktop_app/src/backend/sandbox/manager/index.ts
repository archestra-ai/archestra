import { setSocketPath } from '@backend/clients/libpod/client';
import McpServerModel, { type McpServer } from '@backend/models/mcpServer';
import PodmanRuntime from '@backend/sandbox/podman/runtime';
import SandboxedMcpServer, { type McpTools } from '@backend/sandbox/sandboxedMcp';
import {
  type AvailableTool,
  type SandboxStatus,
  type SandboxStatusSummary,
  SandboxStatusSummarySchema,
} from '@backend/sandbox/schemas';
import log from '@backend/utils/logger';

// Re-export for backward compatibility
export { SandboxStatusSummarySchema } from '@backend/sandbox/schemas';

/**
 * McpServerSandboxManager is a singleton "manager" responsible for.. managing
 * the installation/status of sandboxed MCP servers running in Podman
 */
class McpServerSandboxManager {
  private podmanRuntime: InstanceType<typeof PodmanRuntime>;
  private mcpServerIdToSandboxedMcpServerMap: Map<string, SandboxedMcpServer> = new Map();

  private status: SandboxStatus = 'not_installed';

  private socketPath: string | null = null;

  onSandboxStartupSuccess: () => void = () => {};
  onSandboxStartupError: (error: Error) => void = () => {};

  constructor() {
    this.podmanRuntime = new PodmanRuntime(
      this.onPodmanMachineInstallationSuccess.bind(this),
      this.onPodmanMachineInstallationError.bind(this)
    );
  }

  private async onPodmanMachineInstallationSuccess() {
    log.info('Podman machine installation successful. Starting all installed MCP servers...');

    try {
      // Get the actual socket path from the running podman machine
      log.info('Getting podman socket address...');
      const socketPath = await this.podmanRuntime.getSocketAddress();
      log.info('Got podman socket address:', socketPath);

      // Store the socket path for later use
      this.socketPath = socketPath;

      // Configure the libpod client to use this socket
      setSocketPath(socketPath);
      log.info('Socket path has been updated in libpod client');

      // Now pull the base image with the correct socket configured
      log.info('Pulling base image...');
      await this.podmanRuntime.pullBaseImageOnMachineInstallationSuccess(socketPath);
      log.info('Base image pulled successfully');
    } catch (error) {
      log.error('Failed during podman setup:', error);
      this.onPodmanMachineInstallationError(error as Error);
      return;
    }

    this.status = 'running';

    const installedMcpServers = await McpServerModel.getAll();

    // Start all servers in parallel
    const startPromises = installedMcpServers.map(async (mcpServer) => {
      try {
        await this.startServer(mcpServer);
      } catch (error) {
        throw error;
      }
    });

    const results = await Promise.allSettled(startPromises);

    // Check for failures
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      log.error(`Failed to start ${failures.length} MCP server(s):`);
      failures.forEach((failure, index) => {
        log.error(`  - ${(failure as PromiseRejectedResult).reason}`);
      });
      this.onSandboxStartupError(new Error(`Failed to start ${failures.length} MCP server(s)`));
      return;
    }

    log.info('All MCP server containers started successfully');
    this.onSandboxStartupSuccess();
  }

  private onPodmanMachineInstallationError(error: Error) {
    const errorMessage = `There was an error starting up podman machine: ${error.message}`;
    this.status = 'error';
    this.onSandboxStartupError(new Error(errorMessage));
  }

  async startServer(mcpServer: McpServer) {
    const { id, name, serverType } = mcpServer;
    log.info(`Starting MCP server: id="${id}", name="${name}", type="${serverType}"`);

    // Handle remote servers differently
    if (serverType === 'remote') {
      return await this.startRemoteServer(mcpServer);
    }

    // Handle local containerized servers (existing logic)
    if (!this.socketPath) {
      throw new Error('Socket path is not initialized');
    }

    const sandboxedMcpServer = new SandboxedMcpServer(mcpServer, this.socketPath);

    /**
     * TODO: this is a bit sub-optimal.. register the sandboxedMcpServer in mcpServerIdToSandboxedMcpServerMap
     * BEFORE calling sandboxedMcpServer.start because, internally, start calls POST /mcp_proxy/:mcp_server_id
     * which does a check against McpServerSandboxManager.mcpServerIdToSandboxedMcpServerMap to make sure
     * that the sandboxed mcp server "exists"
     */
    this.mcpServerIdToSandboxedMcpServerMap.set(id, sandboxedMcpServer);
    log.info(`Registered sandboxed MCP server ${id} in map`);

    await sandboxedMcpServer.start();
  }

  /**
   * Handle remote MCP server connection using StreamableHTTPClientTransport
   * Based on the pattern from linear-mcp-oauth-minimal.ts
   */
  private async startRemoteServer(mcpServer: McpServer) {
    const { id, name, serverConfig, oauthTokens } = mcpServer;
    const remoteUrl = serverConfig.remote_url;

    if (!remoteUrl) {
      throw new Error(`Remote server ${name} missing remote_url in config`);
    }

    if (!oauthTokens?.access_token) {
      throw new Error(`Remote server ${name} missing OAuth access token`);
    }

    log.info(`Connecting to remote MCP server: ${name} at ${remoteUrl}`);

    try {
      // Import MCP SDK components
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

      // Create transport with OAuth authentication
      const transport = new StreamableHTTPClientTransport(new URL(remoteUrl), {
        requestInit: {
          headers: { 
            Authorization: `Bearer ${oauthTokens.access_token}` 
          },
        },
      });

      // Create MCP client
      const client = new Client(
        { name: 'archestra-desktop', version: '1.0.0' }, 
        { capabilities: { sampling: {} } }
      );

      // Test the connection
      await client.connect(transport);
      log.info(`✅ Successfully connected to remote MCP server: ${name}`);

      // Get available tools
      const tools = await client.listTools();
      log.info(`🛠️ Remote server ${name} has ${tools.tools.length} tools`);

      // Store the client for later use (similar to how we store SandboxedMcpServer)
      // For now we'll close it since we don't have remote client management yet
      await client.close();
      
      log.info(`Remote server ${name} connection test successful`);

    } catch (error) {
      log.error(`Failed to connect to remote MCP server ${name}:`, error);
      throw error;
    }
  }

  async stopServer(mcpServerId: string) {
    const sandboxedMcpServer = this.mcpServerIdToSandboxedMcpServerMap.get(mcpServerId);

    if (sandboxedMcpServer) {
      await sandboxedMcpServer.stop();
      this.mcpServerIdToSandboxedMcpServerMap.delete(mcpServerId);
    }
  }

  /**
   * Responsible for doing the following:
   * - Starting the archestra podman machine
   * - Pulling the base image required to run MCP servers as containers
   * - Starting all installed MCP server containers
   */
  start() {
    this.status = 'initializing';
    this.podmanRuntime.ensureArchestraMachineIsRunning();
  }

  /**
   * Stop the archestra podman machine (which will stop all installed MCP server containers)
   */
  turnOffSandbox() {
    this.status = 'stopping';
    this.podmanRuntime.stopArchestraMachine();
    this.status = 'stopped';
  }

  getSandboxedMcpServer(mcpServerId: string): SandboxedMcpServer | undefined {
    return this.mcpServerIdToSandboxedMcpServerMap.get(mcpServerId);
  }

  async removeMcpServer(mcpServerId: string) {
    log.info(`Removing mcp server for MCP server: ${mcpServerId}`);

    const sandboxedMcpServer = this.mcpServerIdToSandboxedMcpServerMap.get(mcpServerId);
    if (!sandboxedMcpServer) {
      log.warn(`No container found for MCP server ${mcpServerId}`);
      return;
    }

    try {
      await sandboxedMcpServer.stop();
      log.info(`Successfully removed MCP server ${mcpServerId}`);
    } catch (error) {
      log.error(`Failed to remove MCP server ${mcpServerId}:`, error);
      throw error;
    } finally {
      this.mcpServerIdToSandboxedMcpServerMap.delete(mcpServerId);
    }
  }

  /**
   * Get all tools, for all running MCP servers, in the Vercel AI SDK's format
   */
  getAllTools(): McpTools {
    const allTools: McpTools = {};

    for (const sandboxedMcpServer of this.mcpServerIdToSandboxedMcpServerMap.values()) {
      for (const [toolName, tool] of Object.entries(sandboxedMcpServer.tools)) {
        allTools[toolName] = tool;
      }
    }

    return allTools;
  }

  /**
   * Get specific tools, by ID, in the Vercel AI SDK's format
   */
  getToolsById(toolIds: string[]): McpTools {
    const allTools = this.getAllTools();
    const selected: McpTools = {};

    for (const toolId of toolIds) {
      if (allTools[toolId]) {
        selected[toolId] = allTools[toolId];
      }
    }

    return selected;
  }

  /**
   * Get all available tools, for all running MCP servers, in a slightly transformed format
   * that we expose to the UI
   */
  get allAvailableTools(): AvailableTool[] {
    return Array.from(this.mcpServerIdToSandboxedMcpServerMap.values()).flatMap(
      (sandboxedMcpServer) => sandboxedMcpServer.availableToolsList
    );
  }

  get statusSummary(): SandboxStatusSummary {
    return {
      status: this.status,
      runtime: this.podmanRuntime.statusSummary,
      mcpServers: Object.fromEntries(
        Array.from(this.mcpServerIdToSandboxedMcpServerMap.entries()).map(([mcpServerId, podmanContainer]) => [
          mcpServerId,
          podmanContainer.statusSummary,
        ])
      ),
    };
  }
}

export default new McpServerSandboxManager();
