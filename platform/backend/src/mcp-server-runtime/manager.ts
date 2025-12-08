import * as k8s from "@kubernetes/client-node";
import { Attach } from "@kubernetes/client-node";
import Dockerode from "dockerode";
import config from "@/config";
import logger from "@/logging";
import { InternalMcpCatalogModel, McpServerModel } from "@/models";
import { secretManager } from "@/secretsmanager";
import type { McpServer } from "@/types";
import DockerPod from "./docker-pod";
import K8sPod from "./k8s-pod";
import type {
  AvailableTool,
  DockerPodStatusSummary,
  K8sPodStatusSummary,
  McpServerContainerLogs,
  RuntimeStatus,
  RuntimeType,
  UnifiedRuntimeStatusSummary,
} from "./schemas";

const {
  orchestrator: {
    kubernetes: { namespace, kubeconfig, loadKubeconfigFromCurrentCluster },
    docker: { enabled: dockerEnabled, socketPath: dockerSocketPath },
  },
} = config;

/**
 * McpServerRuntimeManager manages MCP servers running in Kubernetes pods or Docker containers.
 *
 * Runtime Selection Priority:
 * 1. If K8s is explicitly configured (kubeconfig or loadFromCluster), use K8s
 * 2. If Docker socket is available and enabled, use Docker
 * 3. Otherwise, runtime is disabled
 *
 * This allows Docker deployments to run MCP servers without needing Kubernetes.
 */
export class McpServerRuntimeManager {
  // K8s components
  private k8sConfig?: k8s.KubeConfig;
  private k8sApi?: k8s.CoreV1Api;
  private k8sAttach?: Attach;
  private k8sLog?: k8s.Log;
  private k8sNamespace: string;

  // Docker components
  private docker?: Dockerode;

  // Unified state
  private runtimeType: RuntimeType = "none";
  private mcpServerIdToPodMap: Map<string, K8sPod | DockerPod> = new Map();
  private status: RuntimeStatus = "not_initialized";

  // Callbacks for initialization events
  onRuntimeStartupSuccess: () => void = () => {};
  onRuntimeStartupError: (error: Error) => void = () => {};

  constructor() {
    this.k8sNamespace = namespace;
    this.initializeRuntime();
  }

  /**
   * Initialize the appropriate runtime based on configuration and availability
   */
  private initializeRuntime(): void {
    // Priority 1: Try Kubernetes if explicitly configured
    if (loadKubeconfigFromCurrentCluster || kubeconfig) {
      if (this.initializeK8s()) {
        this.runtimeType = "kubernetes";
        logger.info("MCP Server Runtime: Using Kubernetes");
        return;
      }
    }

    // Priority 2: Try Docker if enabled and available
    if (dockerEnabled) {
      if (this.initializeDocker()) {
        this.runtimeType = "docker";
        logger.info("MCP Server Runtime: Using Docker");
        return;
      }
    }

    // Priority 3: Try K8s with default config (for local dev with kind/minikube)
    if (!loadKubeconfigFromCurrentCluster && !kubeconfig) {
      if (this.initializeK8s()) {
        this.runtimeType = "kubernetes";
        logger.info("MCP Server Runtime: Using Kubernetes (default config)");
        return;
      }
    }

    // No runtime available
    this.runtimeType = "none";
    this.status = "error";
    logger.warn(
      "MCP Server Runtime: No runtime available. Local MCP servers will not work. " +
        "Configure Kubernetes (ARCHESTRA_ORCHESTRATOR_KUBECONFIG) or Docker (ARCHESTRA_ORCHESTRATOR_DOCKER_ENABLED=true).",
    );
  }

  /**
   * Initialize Kubernetes runtime
   */
  private initializeK8s(): boolean {
    try {
      this.k8sConfig = new k8s.KubeConfig();

      if (loadKubeconfigFromCurrentCluster) {
        this.k8sConfig.loadFromCluster();
      } else if (kubeconfig) {
        this.k8sConfig.loadFromFile(kubeconfig);
      } else {
        this.k8sConfig.loadFromDefault();
      }

      this.k8sApi = this.k8sConfig.makeApiClient(k8s.CoreV1Api);
      this.k8sAttach = new Attach(this.k8sConfig);
      this.k8sLog = new k8s.Log(this.k8sConfig);

      return true;
    } catch (error) {
      logger.debug(
        { err: error },
        "Failed to initialize Kubernetes runtime (will try Docker next)",
      );
      this.k8sConfig = undefined;
      this.k8sApi = undefined;
      this.k8sAttach = undefined;
      this.k8sLog = undefined;
      return false;
    }
  }

  /**
   * Initialize Docker runtime
   */
  private initializeDocker(): boolean {
    try {
      const dockerOptions: Dockerode.DockerOptions = {};

      if (dockerSocketPath) {
        dockerOptions.socketPath = dockerSocketPath;
      } else if (process.platform === "win32") {
        // Windows named pipe
        dockerOptions.socketPath = "//./pipe/docker_engine";
      } else {
        // Unix socket (Linux/macOS)
        dockerOptions.socketPath = "/var/run/docker.sock";
      }

      this.docker = new Dockerode(dockerOptions);

      // We'll verify connectivity in start() to avoid blocking constructor
      return true;
    } catch (error) {
      logger.debug({ err: error }, "Failed to initialize Docker runtime");
      this.docker = undefined;
      return false;
    }
  }

  /**
   * Check if the orchestrator runtime is enabled
   */
  get isEnabled(): boolean {
    return (
      this.runtimeType !== "none" &&
      this.status !== "error" &&
      this.status !== "stopped"
    );
  }

  /**
   * Get the current runtime type
   */
  get currentRuntimeType(): RuntimeType {
    return this.runtimeType;
  }

  /**
   * Initialize the runtime and start all installed MCP servers
   */
  async start(): Promise<void> {
    if (this.runtimeType === "none") {
      logger.warn("No runtime available, skipping MCP server startup");
      return;
    }

    try {
      this.status = "initializing";
      logger.info(
        `Initializing ${this.runtimeType === "kubernetes" ? "Kubernetes" : "Docker"} MCP Server Runtime...`,
      );

      // Verify connectivity
      if (this.runtimeType === "kubernetes") {
        await this.verifyK8sConnection();
      } else if (this.runtimeType === "docker") {
        await this.verifyDockerConnection();
      }

      this.status = "running";

      // Get all installed local MCP servers from database
      const installedServers = await McpServerModel.findAll();

      // Filter for local servers only (remote servers don't need pods/containers)
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
   * Verify Kubernetes connectivity
   */
  private async verifyK8sConnection(): Promise<void> {
    if (!this.k8sApi) {
      throw new Error("Kubernetes API client not initialized");
    }

    try {
      logger.info(
        `Verifying K8s connection to namespace: ${this.k8sNamespace}`,
      );
      await this.k8sApi.listNamespacedPod({ namespace: this.k8sNamespace });
      logger.info("K8s connection verified successfully");
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to connect to Kubernetes: ${errorMsg}`);
      throw new Error(errorMsg);
    }
  }

  /**
   * Verify Docker connectivity
   */
  private async verifyDockerConnection(): Promise<void> {
    if (!this.docker) {
      throw new Error("Docker client not initialized");
    }

    try {
      logger.info("Verifying Docker connection...");
      await this.docker.ping();
      const info = await this.docker.info();
      logger.info(
        `Docker connection verified: ${info.Name} (${info.ServerVersion})`,
      );
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to connect to Docker: ${errorMsg}`);
      throw new Error(
        `Docker connection failed: ${errorMsg}. Ensure Docker is running and the socket is accessible.`,
      );
    }
  }

  /**
   * Start a single MCP server
   */
  async startServer(
    mcpServer: McpServer,
    userConfigValues?: Record<string, string>,
    environmentValues?: Record<string, string>,
  ): Promise<void> {
    if (this.runtimeType === "kubernetes") {
      await this.startK8sServer(mcpServer, userConfigValues, environmentValues);
    } else if (this.runtimeType === "docker") {
      await this.startDockerServer(
        mcpServer,
        userConfigValues,
        environmentValues,
      );
    } else {
      throw new Error("No runtime available to start MCP server");
    }
  }

  /**
   * Start MCP server as K8s pod
   */
  private async startK8sServer(
    mcpServer: McpServer,
    userConfigValues?: Record<string, string>,
    environmentValues?: Record<string, string>,
  ): Promise<void> {
    if (!this.k8sApi || !this.k8sAttach || !this.k8sLog) {
      throw new Error("Kubernetes API client not initialized");
    }

    const { id, name } = mcpServer;
    logger.info(`Starting MCP server K8s pod: id="${id}", name="${name}"`);

    try {
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
        this.k8sNamespace,
        catalogItem,
        userConfigValues,
        environmentValues,
      );

      this.mcpServerIdToPodMap.set(id, k8sPod);
      logger.info(`Registered MCP server pod ${id} in map`);

      // Create K8s Secret if needed
      if (mcpServer.secretId) {
        const secret = await secretManager.getSecret(mcpServer.secretId);
        if (secret?.secret && typeof secret.secret === "object") {
          const secretData: Record<string, string> = {};
          for (const [key, value] of Object.entries(secret.secret)) {
            secretData[key] = String(value);
          }
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
      logger.warn(
        `MCP server pod ${id} failed to start but remains registered for error display`,
      );
      throw error;
    }
  }

  /**
   * Start MCP server as Docker container
   */
  private async startDockerServer(
    mcpServer: McpServer,
    userConfigValues?: Record<string, string>,
    environmentValues?: Record<string, string>,
  ): Promise<void> {
    if (!this.docker) {
      throw new Error("Docker client not initialized");
    }

    const { id, name } = mcpServer;
    logger.info(
      `Starting MCP server Docker container: id="${id}", name="${name}"`,
    );

    try {
      let catalogItem = null;
      if (mcpServer.catalogId) {
        catalogItem = await InternalMcpCatalogModel.findById(
          mcpServer.catalogId,
        );
      }

      // For Docker, we pass secrets as environment variables directly
      const mergedEnvValues = { ...environmentValues };
      if (mcpServer.secretId) {
        const secret = await secretManager.getSecret(mcpServer.secretId);
        if (secret?.secret && typeof secret.secret === "object") {
          for (const [key, value] of Object.entries(secret.secret)) {
            mergedEnvValues[key] = String(value);
          }
        }
      }

      const dockerPod = new DockerPod(
        mcpServer,
        this.docker,
        catalogItem,
        userConfigValues,
        mergedEnvValues,
      );

      this.mcpServerIdToPodMap.set(id, dockerPod);
      logger.info(`Registered MCP server container ${id} in map`);

      await dockerPod.startOrCreateContainer();
      logger.info(`Successfully started MCP server container ${id} (${name})`);
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to start MCP server container ${id} (${name}):`,
      );
      logger.warn(
        `MCP server container ${id} failed to start but remains registered for error display`,
      );
      throw error;
    }
  }

  /**
   * Stop a single MCP server
   */
  async stopServer(mcpServerId: string): Promise<void> {
    const pod = this.mcpServerIdToPodMap.get(mcpServerId);

    if (!pod) {
      return;
    }

    if (pod instanceof K8sPod) {
      await pod.stopPod();
      await pod.deleteK8sSecret();
    } else if (pod instanceof DockerPod) {
      await pod.stopContainer();
    }

    this.mcpServerIdToPodMap.delete(mcpServerId);
  }

  /**
   * Get a pod/container by MCP server ID
   */
  getPod(mcpServerId: string): K8sPod | DockerPod | undefined {
    return this.mcpServerIdToPodMap.get(mcpServerId);
  }

  /**
   * Get a K8s pod by MCP server ID (for transport creation)
   */
  getK8sPod(mcpServerId: string): K8sPod | undefined {
    const pod = this.mcpServerIdToPodMap.get(mcpServerId);
    if (pod instanceof K8sPod) {
      return pod;
    }
    return undefined;
  }

  /**
   * Get a Docker pod by MCP server ID (for transport creation)
   */
  getDockerPod(mcpServerId: string): DockerPod | undefined {
    const pod = this.mcpServerIdToPodMap.get(mcpServerId);
    if (pod instanceof DockerPod) {
      return pod;
    }
    return undefined;
  }

  /**
   * Remove an MCP server completely
   */
  async removeMcpServer(mcpServerId: string): Promise<void> {
    logger.info(`Removing MCP server for: ${mcpServerId}`);

    const pod = this.mcpServerIdToPodMap.get(mcpServerId);
    if (!pod) {
      logger.warn(`No pod/container found for MCP server ${mcpServerId}`);
      return;
    }

    try {
      if (pod instanceof K8sPod) {
        await pod.removePod();
      } else if (pod instanceof DockerPod) {
        await pod.removeContainer();
      }
      logger.info(`Successfully removed MCP server ${mcpServerId}`);
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to remove MCP server ${mcpServerId}:`,
      );
      throw error;
    } finally {
      this.mcpServerIdToPodMap.delete(mcpServerId);
    }
  }

  /**
   * Restart a single MCP server
   */
  async restartServer(mcpServerId: string): Promise<void> {
    logger.info(`Restarting MCP server: ${mcpServerId}`);

    try {
      const mcpServer = await McpServerModel.findById(mcpServerId);
      if (!mcpServer) {
        throw new Error(`MCP server with id ${mcpServerId} not found`);
      }

      await this.stopServer(mcpServerId);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await this.startServer(mcpServer);

      logger.info(`MCP server ${mcpServerId} restarted successfully`);
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to restart MCP server ${mcpServerId}:`,
      );
      throw error;
    }
  }

  /**
   * Check if an MCP server uses streamable HTTP transport
   */
  async usesStreamableHttp(mcpServerId: string): Promise<boolean> {
    const pod = this.mcpServerIdToPodMap.get(mcpServerId);
    if (!pod) {
      return false;
    }
    return await pod.usesStreamableHttp();
  }

  /**
   * Get the HTTP endpoint URL for a streamable-http server
   */
  getHttpEndpointUrl(mcpServerId: string): string | undefined {
    const pod = this.mcpServerIdToPodMap.get(mcpServerId);
    if (!pod) {
      return undefined;
    }
    return pod.getHttpEndpointUrl();
  }

  /**
   * Get logs from an MCP server
   */
  async getMcpServerLogs(
    mcpServerId: string,
    lines: number = 100,
  ): Promise<McpServerContainerLogs> {
    const pod = this.mcpServerIdToPodMap.get(mcpServerId);
    if (!pod) {
      throw new Error(`Pod/container not found for MCP server ${mcpServerId}`);
    }

    if (pod instanceof K8sPod) {
      const containerName = pod.containerName;
      return {
        logs: await pod.getRecentLogs(lines),
        containerName,
        command: `kubectl logs -n ${this.k8sNamespace} ${containerName} --tail=${lines}`,
        namespace: this.k8sNamespace,
      };
    } else if (pod instanceof DockerPod) {
      return {
        logs: await pod.getRecentLogs(lines),
        containerName: pod.name,
        command: `docker logs --tail=${lines} ${pod.name}`,
        namespace: "docker",
      };
    }

    throw new Error("Unknown pod type");
  }

  /**
   * Stream logs from an MCP server with follow enabled
   */
  async streamMcpServerLogs(
    mcpServerId: string,
    responseStream: NodeJS.WritableStream,
    lines: number = 100,
  ): Promise<void> {
    const pod = this.mcpServerIdToPodMap.get(mcpServerId);
    if (!pod) {
      throw new Error(`Pod/container not found for MCP server ${mcpServerId}`);
    }

    await pod.streamLogs(responseStream, lines);
  }

  /**
   * Get all available tools (placeholder for compatibility)
   */
  get allAvailableTools(): AvailableTool[] {
    return [];
  }

  /**
   * Get the runtime status summary
   */
  get statusSummary(): UnifiedRuntimeStatusSummary {
    const mcpServers: Record<
      string,
      K8sPodStatusSummary | DockerPodStatusSummary
    > = {};

    for (const [mcpServerId, pod] of this.mcpServerIdToPodMap.entries()) {
      mcpServers[mcpServerId] = pod.statusSummary;
    }

    return {
      runtimeType: this.runtimeType,
      status: this.status,
      mcpServers,
    };
  }

  /**
   * Shutdown the runtime
   */
  async shutdown(): Promise<void> {
    logger.info("Shutting down MCP Server Runtime...");
    this.status = "stopped";

    const stopPromises = Array.from(this.mcpServerIdToPodMap.keys()).map(
      async (serverId) => {
        try {
          await this.stopServer(serverId);
        } catch (error) {
          logger.error(
            { err: error },
            `Failed to stop MCP server ${serverId} during shutdown:`,
          );
        }
      },
    );

    await Promise.allSettled(stopPromises);
    logger.info("MCP Server Runtime shutdown complete");
  }
}

export default new McpServerRuntimeManager();
