import * as k8s from "@kubernetes/client-node";
import { Attach } from "@kubernetes/client-node";
import config from "@/config";
import logger from "@/logging";
import { InternalMcpCatalogModel, McpServerModel, SecretModel } from "@/models";
import type { McpServer } from "@/types";
import K8sPod from "./k8s-pod";
import type {
  AvailableTool,
  K8sRuntimeStatus,
  K8sRuntimeStatusSummary,
  McpServerContainerLogs,
} from "./schemas";

const {
  orchestrator: {
    kubernetes: { namespace, kubeconfig, loadKubeconfigFromCurrentCluster },
  },
} = config;

/**
 * McpServerRuntimeManager manages MCP servers running in Kubernetes pods.
 * This is analogous to McpServerSandboxManager in the desktop app,
 * but uses Kubernetes instead of Podman.
 */
export class McpServerRuntimeManager {
  private k8sConfig: k8s.KubeConfig;
  private k8sApi?: k8s.CoreV1Api;
  private k8sAttach: Attach;
  private k8sLog: k8s.Log;
  private namespace: string;
  private mcpServerIdToPodMap: Map<string, K8sPod> = new Map();
  private status: K8sRuntimeStatus = "not_initialized";

  // Callbacks for initialization events
  onRuntimeStartupSuccess: () => void = () => {};
  onRuntimeStartupError: (error: Error) => void = () => {};

  constructor() {
    this.k8sConfig = new k8s.KubeConfig();

    // Load K8s config from environment or default locations
    try {
      if (loadKubeconfigFromCurrentCluster) {
        /**
         * Running inside a K8s cluster
         *
         * Automatically configure the client to connect to the Kubernetes API
         * when the application is running inside a Kubernetes cluster
         */
        this.k8sConfig.loadFromCluster();
      } else if (kubeconfig) {
        // Load from KUBECONFIG env var
        this.k8sConfig.loadFromFile(kubeconfig);
      } else {
        // Load from default location (~/.kube/config)
        this.k8sConfig.loadFromDefault();
      }

      // Only create API client if K8s config loaded successfully
      this.k8sApi = this.k8sConfig.makeApiClient(k8s.CoreV1Api);
    } catch (error) {
      logger.error({ err: error }, "Failed to load Kubernetes config:");
      this.status = "error";
    }

    this.k8sAttach = new Attach(this.k8sConfig);
    this.k8sLog = new k8s.Log(this.k8sConfig);
    this.namespace = namespace;
  }

  /**
   * Check if the orchestrator K8s runtime is enabled
   * Returns true if the K8s config loaded successfully (constructor didn't fail)
   * and the runtime hasn't been stopped
   */
  get isEnabled(): boolean {
    return this.status !== "error" && this.status !== "stopped";
  }

  /**
   * Initialize the runtime and start all installed MCP servers
   */
  async start(): Promise<void> {
    if (!this.k8sApi) {
      throw new Error("Kubernetes API client not initialized");
    }

    try {
      this.status = "initializing";
      logger.info("Initializing Kubernetes MCP Server Runtime...");

      // Verify K8s connectivity
      await this.verifyK8sConnection();

      this.status = "running";

      // Get all installed local MCP servers from database
      const installedServers = await McpServerModel.findAll();

      // Filter for local servers only (remote servers don't need pods)
      const localServers: McpServer[] = [];
      for (const server of installedServers) {
        if (server.catalogId) {
          const catalogItem = await InternalMcpCatalogModel.findById(
            server.catalogId,
          );
          if (catalogItem?.serverType === "local") {
            localServers.push(server);
          }
        }
      }

      logger.info(`Found ${localServers.length} local MCP servers to start`);

      // Start all local servers in parallel
      const startPromises = localServers.map(async (mcpServer) => {
        await this.startServer(mcpServer);
      });

      const results = await Promise.allSettled(startPromises);

      // Count successes and failures
      const failures = results.filter((result) => result.status === "rejected");
      const successes = results.filter(
        (result) => result.status === "fulfilled",
      );

      if (failures.length > 0) {
        logger.warn(
          `${failures.length} MCP server(s) failed to start, but will remain visible with error state`,
        );
        failures.forEach((failure) => {
          logger.warn(`  - ${(failure as PromiseRejectedResult).reason}`);
        });
      }

      if (successes.length > 0) {
        logger.info(`${successes.length} MCP server(s) started successfully`);
      }

      logger.info("MCP Server Runtime initialization complete");
      this.onRuntimeStartupSuccess();
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to initialize MCP Server Runtime: ${errorMsg}`);
      this.status = "error";
      this.onRuntimeStartupError(new Error(errorMsg));
      throw error;
    }
  }

  /**
   * Verify that we can connect to Kubernetes
   */
  private async verifyK8sConnection(): Promise<void> {
    if (!this.k8sApi) {
      throw new Error("Kubernetes API client not initialized");
    }

    try {
      logger.info(`Verifying K8s connection to namespace: ${this.namespace}`);

      // Try to list pods in the namespace to verify connectivity
      await this.k8sApi.listNamespacedPod({ namespace: this.namespace });

      logger.info("K8s connection verified successfully");
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to connect to Kubernetes: ${errorMsg}`);
      throw new Error(errorMsg);
    }
  }

  /**
   * Start a single MCP server pod
   */
  async startServer(
    mcpServer: McpServer,
    userConfigValues?: Record<string, string>,
    environmentValues?: Record<string, string>,
  ): Promise<void> {
    if (!this.k8sApi) {
      throw new Error("Kubernetes API client not initialized");
    }

    const { id, name } = mcpServer;
    logger.info(`Starting MCP server pod: id="${id}", name="${name}"`);

    try {
      // Fetch catalog item (needed for conditional env var logic)
      let catalogItem = null;
      if (mcpServer.catalogId) {
        catalogItem = await InternalMcpCatalogModel.findById(
          mcpServer.catalogId,
        );
      }

      const k8sPod = new K8sPod(
        mcpServer,
        this.k8sApi,
        this.k8sAttach,
        this.k8sLog,
        this.namespace,
        catalogItem,
        userConfigValues,
        environmentValues,
      );

      // Register the pod BEFORE starting it
      this.mcpServerIdToPodMap.set(id, k8sPod);
      logger.info(`Registered MCP server pod ${id} in map`);

      // If MCP server has a secretId, fetch secret from database and create K8s Secret
      if (mcpServer.secretId) {
        const secret = await SecretModel.getMcpServerSecret(mcpServer.secretId);

        if (secret?.secret && typeof secret.secret === "object") {
          const secretData: Record<string, string> = {};

          // Convert secret.secret (Record<string, unknown>) to Record<string, string>
          for (const [key, value] of Object.entries(secret.secret)) {
            secretData[key] = String(value);
          }

          // Create K8s Secret from database secret
          await k8sPod.createK8sSecret(secretData);
          logger.info(
            { mcpServerId: id, secretId: mcpServer.secretId },
            "Created K8s Secret from database secret",
          );
        }
      }

      await k8sPod.startOrCreatePod();
      logger.info(`Successfully started MCP server pod ${id} (${name})`);
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to start MCP server pod ${id} (${name}):`,
      );
      // Keep the pod in the map even if it failed to start
      // This ensures it appears in status updates with error state
      logger.warn(
        `MCP server pod ${id} failed to start but remains registered for error display`,
      );
      throw error;
    }
  }

  /**
   * Stop a single MCP server pod
   */
  async stopServer(mcpServerId: string): Promise<void> {
    const k8sPod = this.mcpServerIdToPodMap.get(mcpServerId);

    if (k8sPod) {
      // Delete pod first
      await k8sPod.stopPod();

      // Delete K8s Secret (if it exists)
      await k8sPod.deleteK8sSecret();

      this.mcpServerIdToPodMap.delete(mcpServerId);
    }
  }

  /**
   * Get a pod by MCP server ID
   */
  getPod(mcpServerId: string): K8sPod | undefined {
    return this.mcpServerIdToPodMap.get(mcpServerId);
  }

  /**
   * Remove an MCP server pod completely
   */
  async removeMcpServer(mcpServerId: string): Promise<void> {
    logger.info(`Removing MCP server pod for: ${mcpServerId}`);

    const k8sPod = this.mcpServerIdToPodMap.get(mcpServerId);
    if (!k8sPod) {
      logger.warn(`No pod found for MCP server ${mcpServerId}`);
      return;
    }

    try {
      await k8sPod.removePod();
      logger.info(`Successfully removed MCP server pod ${mcpServerId}`);
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to remove MCP server pod ${mcpServerId}:`,
      );
      throw error;
    } finally {
      this.mcpServerIdToPodMap.delete(mcpServerId);
    }
  }

  /**
   * Restart a single MCP server pod
   */
  async restartServer(mcpServerId: string): Promise<void> {
    logger.info(`Restarting MCP server pod: ${mcpServerId}`);

    try {
      // Get the MCP server from database
      const mcpServer = await McpServerModel.findById(mcpServerId);

      if (!mcpServer) {
        throw new Error(`MCP server with id ${mcpServerId} not found`);
      }

      // Stop the pod
      await this.stopServer(mcpServerId);

      // Wait a moment for shutdown to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Start the pod again
      await this.startServer(mcpServer);

      logger.info(`MCP server pod ${mcpServerId} restarted successfully`);
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to restart MCP server pod ${mcpServerId}:`,
      );
      throw error;
    }
  }

  /**
   * Check if an MCP server uses streamable HTTP transport
   */
  async usesStreamableHttp(mcpServerId: string): Promise<boolean> {
    const k8sPod = this.mcpServerIdToPodMap.get(mcpServerId);
    if (!k8sPod) {
      return false;
    }
    return await k8sPod.usesStreamableHttp();
  }

  /**
   * Get the HTTP endpoint URL for a streamable-http server
   */
  getHttpEndpointUrl(mcpServerId: string): string | undefined {
    const k8sPod = this.mcpServerIdToPodMap.get(mcpServerId);
    if (!k8sPod) {
      return undefined;
    }
    return k8sPod.getHttpEndpointUrl();
  }

  /**
   * Get logs from an MCP server pod
   */
  async getMcpServerLogs(
    mcpServerId: string,
    lines: number = 100,
  ): Promise<McpServerContainerLogs> {
    const k8sPod = this.mcpServerIdToPodMap.get(mcpServerId);
    if (!k8sPod) {
      throw new Error(`Pod not found for MCP server ${mcpServerId}`);
    }

    const containerName = k8sPod.containerName;
    return {
      logs: await k8sPod.getRecentLogs(lines),
      containerName,
      // Construct the kubectl command for the user to manually get the logs if they'd like
      command: `kubectl logs -n ${this.namespace} ${containerName} --tail=${lines}`,
      namespace: this.namespace,
    };
  }

  /**
   * Stream logs from an MCP server pod with follow enabled
   */
  async streamMcpServerLogs(
    mcpServerId: string,
    responseStream: NodeJS.WritableStream,
    lines: number = 100,
  ): Promise<void> {
    const k8sPod = this.mcpServerIdToPodMap.get(mcpServerId);
    if (!k8sPod) {
      throw new Error(`Pod not found for MCP server ${mcpServerId}`);
    }

    await k8sPod.streamLogs(responseStream, lines);
  }

  /**
   * Get all available tools from all running MCP servers
   * Note: In the platform, tools are managed via the database and MCP client,
   * not directly through the runtime manager like in desktop app.
   * This is a placeholder for compatibility.
   */
  get allAvailableTools(): AvailableTool[] {
    // Tools are managed by the MCP client and stored in the database
    // This method is here for compatibility with the desktop app interface
    return [];
  }

  /**
   * Get the runtime status summary
   */
  get statusSummary(): K8sRuntimeStatusSummary {
    return {
      status: this.status,
      mcpServers: Object.fromEntries(
        Array.from(this.mcpServerIdToPodMap.entries()).map(
          ([mcpServerId, k8sPod]) => [mcpServerId, k8sPod.statusSummary],
        ),
      ),
    };
  }

  /**
   * Shutdown the runtime
   */
  async shutdown(): Promise<void> {
    logger.info("Shutting down MCP Server Runtime...");
    this.status = "stopped";

    // Stop all pods
    const stopPromises = Array.from(this.mcpServerIdToPodMap.keys()).map(
      async (serverId) => {
        try {
          await this.stopServer(serverId);
        } catch (error) {
          logger.error(
            { err: error },
            `Failed to stop MCP server pod ${serverId} during shutdown:`,
          );
        }
      },
    );

    await Promise.allSettled(stopPromises);
    logger.info("MCP Server Runtime shutdown complete");
  }
}

export default new McpServerRuntimeManager();
