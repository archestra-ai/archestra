import { setSocketPath } from '@backend/clients/libpod/client';
import McpServerModel, { type McpServer } from '@backend/models/mcpServer';
import PodmanRuntime from '@backend/sandbox/podman/runtime';
import SandboxedMcpServer, { type McpTools } from '@backend/sandbox/sandboxedMcp';
import { type AvailableTool, type SandboxStatus, type SandboxStatusSummary } from '@backend/sandbox/schemas';
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
      log.info('Ensuring base image is available...');
      await this.podmanRuntime.pullBaseImageOnMachineInstallationSuccess(socketPath);
      log.info('Base image is available');
    } catch (error) {
      log.error('Failed during podman setup:', error);
      this.onPodmanMachineInstallationError(error as Error);
      return;
    }

    this.status = 'running';

    const installedMcpServers = await McpServerModel.getAll();

    // Start all servers in parallel
    const startPromises = installedMcpServers.map(async (mcpServer) => {
      await this.startServer(mcpServer);
    });

    const results = await Promise.allSettled(startPromises);

    // Count how many servers started vs failed
    const failures = results.filter((result) => result.status === 'rejected');
    const successes = results.filter((result) => result.status === 'fulfilled');

    if (failures.length > 0) {
      log.warn(`${failures.length} MCP server(s) failed to start, but will remain visible with error state`);
      failures.forEach((failure) => {
        log.warn(`  - ${(failure as PromiseRejectedResult).reason}`);
      });
    }

    if (successes.length > 0) {
      log.info(`${successes.length} MCP server(s) started successfully`);
    }

    // Always call success callback even if some servers failed
    // Failed servers will be visible in error state
    log.info('MCP server initialization complete');
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
     * Register the sandboxedMcpServer in mcpServerIdToSandboxedMcpServerMap
     * BEFORE calling sandboxedMcpServer.start because, internally, start calls POST /mcp_proxy/:mcp_server_id
     * which does a check against McpServerSandboxManager.mcpServerIdToSandboxedMcpServerMap to make sure
     * that the sandboxed mcp server "exists"
     */
    this.mcpServerIdToSandboxedMcpServerMap.set(id, sandboxedMcpServer);
    log.info(`Registered sandboxed MCP server ${id} in map`);

    try {
      await sandboxedMcpServer.start();
      log.info(`Successfully started and registered MCP server ${id} (${name})`);
    } catch (error) {
      log.error(`Failed to start MCP server ${id} (${name}):`, error);

      // Keep the server in the map even if it failed to start
      // This ensures it appears in WebSocket updates so the UI can show its error state
      log.warn(`MCP server ${id} failed to start but remains registered for error display`);

      // Don't throw - allow other servers to continue starting
      // The server will remain in error state but still be visible in the UI
    }
  }

  /**
   * Handle remote MCP server by creating a SandboxedMcpServer instance
   * This integrates remote servers with the existing tool discovery system
   */
  private async startRemoteServer(mcpServer: McpServer) {
    const { id, name } = mcpServer;

    log.info(`Starting remote MCP server: ${name}`);

    try {
      // Create SandboxedMcpServer for remote server (no socket path needed)
      const sandboxedMcpServer = new SandboxedMcpServer(mcpServer);

      // Register in the same map as local servers
      this.mcpServerIdToSandboxedMcpServerMap.set(id, sandboxedMcpServer);
      log.info(`Registered remote MCP server ${id} in map`);

      // Start the remote connection (this will create MCP client and fetch tools)
      await sandboxedMcpServer.start();

      log.info(`✅ Remote MCP server ${name} started successfully`);
    } catch (error) {
      log.error(`Failed to start remote MCP server ${name}:`, error);

      // Keep the server in the map even if it failed to start
      // This ensures it appears in WebSocket updates so the UI can show its error state
      log.warn(`Remote MCP server ${id} failed to start but remains registered for error display`);

      // Don't throw - allow other servers to continue starting
      // The server will remain in error state but still be visible in the UI
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

  /**
   * Restart the entire sandbox (podman machine + all MCP servers)
   */
  async restart() {
    log.info('Restarting Archestra MCP Sandbox...');

    try {
      // Stop all MCP servers first
      const stopPromises = Array.from(this.mcpServerIdToSandboxedMcpServerMap.keys()).map(async (serverId) => {
        try {
          await this.stopServer(serverId);
        } catch (error) {
          log.error(`Failed to stop MCP server ${serverId} during restart:`, error);
        }
      });

      await Promise.allSettled(stopPromises);

      // Stop the podman machine
      this.turnOffSandbox();

      // Wait a moment for shutdown to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Start everything back up
      this.start();

      log.info('Sandbox restart initiated successfully');
    } catch (error) {
      log.error('Failed to restart sandbox:', error);
      throw error;
    }
  }

  /**
   * Clean/purge all data (uninstall all MCP servers + reset podman machine)
   */
  async reset() {
    log.info('Resetting Archestra MCP Sandbox (purging all data)...');

    try {
      // Get all installed servers before removing them
      const installedServers = await McpServerModel.getAll();

      // Uninstall all MCP servers
      const uninstallPromises = installedServers.map(async (server) => {
        try {
          await McpServerModel.uninstallMcpServer(server.id);
          log.info(`Uninstalled MCP server: ${server.name} (${server.id})`);
        } catch (error) {
          log.error(`Failed to uninstall MCP server ${server.name} (${server.id}):`, error);
        }
      });

      await Promise.allSettled(uninstallPromises);

      // Clear the sandbox map and socket path
      this.mcpServerIdToSandboxedMcpServerMap.clear();
      this.socketPath = null;

      // Remove the podman machine completely
      log.info('Removing podman machine...');
      await this.podmanRuntime.removeArchestraMachine(true);

      // Reset the status
      this.status = 'not_installed';

      // Restart everything by calling start
      log.info('Restarting Archestra MCP Sandbox...');
      this.start();

      log.info('Sandbox reset completed successfully');
    } catch (error) {
      log.error('Failed to reset sandbox:', error);
      throw error;
    }
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
