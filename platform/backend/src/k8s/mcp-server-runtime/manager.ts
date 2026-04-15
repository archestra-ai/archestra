import type * as k8s from "@kubernetes/client-node";
import {
  createK8sClients,
  loadKubeConfig,
  sanitizeLabelValue,
} from "@/k8s/shared";
import logger from "@/logging";
import {
  InternalMcpCatalogModel,
  McpHttpSessionModel,
  McpServerModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import type { McpServer } from "@/types";
import K8sDeployment, {
  fetchPlatformPodNodeSelector,
  fetchPlatformPodTolerations,
} from "./k8s-deployment";
import type {
  AvailableTool,
  K8sRuntimeStatus,
  K8sRuntimeStatusSummary,
  McpServerContainerLogs,
} from "./schemas";

/**
 * McpServerRuntimeManager manages MCP servers running in Kubernetes.
 */
export class McpServerRuntimeManager {
  private k8sApi?: k8s.CoreV1Api;
  private k8sAppsApi?: k8s.AppsV1Api;
  private k8sAttach?: k8s.Attach;
  private k8sLog?: k8s.Log;
  private k8sExec?: k8s.Exec;
  private namespace: string = "default";
  private mcpServerIdToDeploymentMap: Map<string, K8sDeployment> = new Map();
  private status: K8sRuntimeStatus = "not_initialized";

  // Callbacks for initialization events
  onRuntimeStartupSuccess: () => void = () => {};
  onRuntimeStartupError: (error: Error) => void = () => {};

  constructor() {
    try {
      const { kubeConfig, namespace } = loadKubeConfig();
      const clients = createK8sClients(kubeConfig, namespace);

      this.k8sApi = clients.coreApi;
      this.k8sAppsApi = clients.appsApi;
      this.k8sAttach = clients.attach;
      this.k8sExec = clients.exec;
      this.k8sLog = clients.log;
      this.namespace = clients.namespace;
    } catch (error) {
      logger.error({ err: error }, "Failed to load Kubernetes config");
      this.status = "error";
      this.k8sApi = undefined;
      this.k8sAppsApi = undefined;
      this.k8sAttach = undefined;
      this.k8sLog = undefined;
      this.namespace = "";
      return; // graceful fallback: constructor completes with runtime disabled
    }
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
    if (!this.k8sApi || !this.k8sAppsApi) {
      throw new Error("Kubernetes API client not initialized");
    }

    try {
      this.status = "initializing";
      logger.info("Initializing Kubernetes MCP Server Runtime...");

      // Verify K8s connectivity
      await this.verifyK8sConnection();

      // Fetch the platform pod's nodeSelector and tolerations to inherit for MCP server deployments
      // This allows MCP servers to be scheduled on the same node pool as the platform
      await fetchPlatformPodNodeSelector(this.k8sApi, this.namespace);
      await fetchPlatformPodTolerations(this.k8sApi, this.namespace);

      this.status = "running";

      // Get all installed local MCP servers from database
      const installedServers = await McpServerModel.findAll();

      // Filter for local servers only (remote servers don't need deployments)
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

      // Fire-and-forget: backfill team-id labels on existing regcred secrets
      this.backfillRegcredTeamLabels(installedServers).catch((err) => {
        logger.warn(
          { err },
          "Failed to backfill team-id labels on regcred secrets",
        );
      });
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

      // Try to list pods in the namespace to verify K8s API connectivity
      await this.k8sApi.listNamespacedPod({ namespace: this.namespace });

      logger.info("K8s connection verified successfully");
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to connect to Kubernetes: ${errorMsg}`);
      throw new Error(errorMsg);
    }
  }

  /**
   * Start a single MCP server deployment
   */
  async startServer(
    mcpServer: McpServer,
    userConfigValues?: Record<string, string>,
    environmentValues?: Record<string, string>,
  ): Promise<void> {
    if (!this.k8sApi || !this.k8sAppsApi) {
      throw new Error("Kubernetes API client not initialized");
    }

    const { id, name } = mcpServer;
    logger.info(`Starting MCP server deployment: id="${id}", name="${name}"`);

    try {
      // Fetch catalog item (needed for conditional env var logic)
      let catalogItem = null;
      if (mcpServer.catalogId) {
        catalogItem = await InternalMcpCatalogModel.findById(
          mcpServer.catalogId,
        );
      }

      if (!this.k8sAttach || !this.k8sLog || !this.k8sExec) {
        throw new Error("Kubernetes clients not initialized");
      }

      // If environmentValues not provided but server has a secretId,
      // fetch the secret values to use as environmentValues.
      // This is critical for restarts where env values need to be preserved
      // to ensure the pod spec includes the secretKeyRef for prompted env vars.
      let effectiveEnvironmentValues = environmentValues;
      let secretData: Record<string, string> | undefined;

      if (mcpServer.secretId) {
        const secret = await secretManager().getSecret(mcpServer.secretId);

        if (secret?.secret && typeof secret.secret === "object") {
          // Filter to keys this server needs
          const expectedKeys = new Set(
            (catalogItem?.localConfig?.environment ?? [])
              .filter((e) => e.type === "secret")
              .map((e) => e.key),
          );

          secretData = {};
          for (const [key, value] of Object.entries(secret.secret)) {
            if (!expectedKeys.size || expectedKeys.has(key)) {
              secretData[key] = String(value);
            }
          }

          // Use secret data as environmentValues if not explicitly provided
          // This ensures createContainerEnvFromConfig() knows to add secretKeyRef
          if (!effectiveEnvironmentValues) {
            effectiveEnvironmentValues = secretData;
            logger.info(
              {
                mcpServerId: id,
                secretId: mcpServer.secretId,
                keys: Object.keys(secretData),
              },
              "Using secret values as environment values for deployment",
            );
          }
        }
      }

      // Non-prompted secrets are managed at the catalog level, not per-server.
      // When an admin edits a secret value in the catalog form, that new value
      // must propagate to all installed servers on restart.
      if (catalogItem?.localConfig?.environment) {
        for (const envDef of catalogItem.localConfig.environment) {
          if (
            envDef.type === "secret" &&
            !envDef.promptOnInstallation &&
            envDef.value
          ) {
            if (!secretData) {
              secretData = {};
            }
            secretData[envDef.key] = envDef.value;

            if (!effectiveEnvironmentValues) {
              effectiveEnvironmentValues = {};
            }
            effectiveEnvironmentValues[envDef.key] = envDef.value;
          }
        }
      }

      const k8sDeployment = new K8sDeployment({
        mcpServer,
        k8sApi: this.k8sApi,
        k8sAppsApi: this.k8sAppsApi,
        k8sAttach: this.k8sAttach,
        k8sLog: this.k8sLog,
        namespace: this.namespace,
        catalogItem,
        userConfigValues,
        environmentValues: effectiveEnvironmentValues,
        k8sExec: this.k8sExec,
      });

      // Register the deployment BEFORE starting it
      this.mcpServerIdToDeploymentMap.set(id, k8sDeployment);
      logger.info(`Registered MCP server deployment ${id} in map`);

      // Create K8s Secret if we have secret data
      if (secretData && Object.keys(secretData).length > 0) {
        await k8sDeployment.createK8sSecret(secretData);
        logger.info(
          { mcpServerId: id, secretId: mcpServer.secretId },
          "Created K8s Secret from secret manager",
        );
      }

      // Create docker-registry secrets for imagePullSecrets with credentials
      // and resolve all imagePullSecrets names for the pod spec.
      // Regcred passwords are stored in the catalog's localConfigSecretId, not
      // the per-user mcpServer.secretId, so fetch them separately.
      const imagePullSecrets = catalogItem?.localConfig?.imagePullSecrets;
      const regcredSecretData: Record<string, string> = {};
      if (catalogItem?.localConfigSecretId && imagePullSecrets?.length) {
        const catalogSecret = await secretManager().getSecret(
          catalogItem.localConfigSecretId,
        );
        if (catalogSecret?.secret && typeof catalogSecret.secret === "object") {
          for (const [key, value] of Object.entries(catalogSecret.secret)) {
            if (key.startsWith("__regcred_password:")) {
              regcredSecretData[key] = String(value);
            }
          }
        }
      }
      const generatedRegcredNames =
        await k8sDeployment.createDockerRegistrySecrets(
          regcredSecretData,
          imagePullSecrets,
        );
      const resolvedImagePullSecretNames =
        K8sDeployment.collectImagePullSecretNames(
          imagePullSecrets,
          generatedRegcredNames,
        );

      await k8sDeployment.startOrCreateDeployment(resolvedImagePullSecretNames);
      logger.info(`Successfully started MCP server deployment ${id} (${name})`);
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to start MCP server deployment ${id} (${name}):`,
      );
      // Keep the deployment in the map even if it failed to start
      // This ensures it appears in status updates with error state
      logger.warn(
        `MCP server deployment ${id} failed to start but remains registered for error display`,
      );
      throw error;
    }
  }

  /**
   * Stop a single MCP server deployment
   */
  async stopServer(mcpServerId: string): Promise<void> {
    // Try to get from memory first, or lazy-load from database
    const k8sDeployment = await this.getOrLoadDeployment(mcpServerId);

    if (k8sDeployment) {
      // Delete deployment first
      await k8sDeployment.stopDeployment();

      // Delete K8s Service (if it exists, for HTTP-based servers)
      await k8sDeployment.deleteK8sService();

      // Delete K8s Secret (if it exists)
      await k8sDeployment.deleteK8sSecret();

      // Delete docker-registry secrets (if any were created for imagePullSecrets)
      await k8sDeployment.deleteDockerRegistrySecrets();

      this.mcpServerIdToDeploymentMap.delete(mcpServerId);
    }
  }

  /**
   * Get a deployment by MCP server ID, loading from database if not in memory.
   * This handles the case where multiple replicas exist and the deployment was
   * created by a different replica.
   */
  async getOrLoadDeployment(
    mcpServerId: string,
  ): Promise<K8sDeployment | undefined> {
    // First check if already in memory
    const existing = this.mcpServerIdToDeploymentMap.get(mcpServerId);
    if (existing) {
      return existing;
    }

    // Not in memory - try to load from database
    if (
      !this.k8sApi ||
      !this.k8sAppsApi ||
      !this.k8sAttach ||
      !this.k8sLog ||
      !this.k8sExec
    ) {
      logger.warn(
        `Cannot load deployment for ${mcpServerId}: K8s clients not initialized`,
      );
      return undefined;
    }

    try {
      const mcpServer = await McpServerModel.findById(mcpServerId);
      if (!mcpServer) {
        logger.debug(`MCP server ${mcpServerId} not found in database`);
        return undefined;
      }

      // Check if it's a local server
      if (!mcpServer.catalogId) {
        logger.debug(`MCP server ${mcpServerId} has no catalog ID`);
        return undefined;
      }

      const catalogItem = await InternalMcpCatalogModel.findById(
        mcpServer.catalogId,
      );
      if (!catalogItem || catalogItem.serverType !== "local") {
        logger.debug(
          `MCP server ${mcpServerId} is not a local server or catalog not found`,
        );
        return undefined;
      }

      // Create the K8sDeployment object and register it
      // Note: We don't call startOrCreateDeployment() because the deployment
      // should already exist in K8s (created by another replica)
      const k8sDeployment = new K8sDeployment({
        mcpServer,
        k8sApi: this.k8sApi,
        k8sAppsApi: this.k8sAppsApi,
        k8sAttach: this.k8sAttach,
        k8sLog: this.k8sLog,
        namespace: this.namespace,
        catalogItem,
        k8sExec: this.k8sExec,
      });

      // Resolve HTTP endpoint URL (for streamable-http servers started by another replica)
      await k8sDeployment.resolveHttpEndpoint();

      this.mcpServerIdToDeploymentMap.set(mcpServerId, k8sDeployment);
      logger.info(
        `Lazy-loaded MCP server deployment ${mcpServerId} into memory`,
      );

      return k8sDeployment;
    } catch (error) {
      logger.error(
        { err: error, mcpServerId },
        `Failed to lazy-load MCP server deployment`,
      );
      return undefined;
    }
  }

  /**
   * Remove an MCP server deployment completely
   */
  async removeMcpServer(mcpServerId: string): Promise<void> {
    logger.info(`Removing MCP server deployment for: ${mcpServerId}`);

    // Try to get from memory first, or lazy-load from database
    const k8sDeployment = await this.getOrLoadDeployment(mcpServerId);
    if (!k8sDeployment) {
      logger.warn(`No deployment found for MCP server ${mcpServerId}`);
      return;
    }

    try {
      await k8sDeployment.removeDeployment();
      logger.info(`Successfully removed MCP server deployment ${mcpServerId}`);
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to remove MCP server deployment ${mcpServerId}:`,
      );
      throw error;
    } finally {
      this.mcpServerIdToDeploymentMap.delete(mcpServerId);
    }
  }

  /**
   * Restart a single MCP server deployment
   */
  async restartServer(mcpServerId: string): Promise<void> {
    logger.info(`Restarting MCP server deployment: ${mcpServerId}`);

    try {
      // Get the MCP server from database
      const mcpServer = await McpServerModel.findById(mcpServerId);

      if (!mcpServer) {
        throw new Error(`MCP server with id ${mcpServerId} not found`);
      }

      // Clean up stored HTTP session IDs before stopping the server.
      // After a restart, existing session IDs become stale and would cause
      // "Session not found" errors for in-flight conversations.
      await McpHttpSessionModel.deleteByMcpServerId(mcpServerId);

      // Stop the deployment
      await this.stopServer(mcpServerId);

      // Wait a moment for shutdown to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Start the deployment again
      await this.startServer(mcpServer);

      logger.info(
        `MCP server deployment ${mcpServerId} restarted successfully`,
      );
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to restart MCP server deployment ${mcpServerId}:`,
      );
      throw error;
    }
  }

  /**
   * Check if an MCP server uses streamable HTTP transport
   */
  async usesStreamableHttp(mcpServerId: string): Promise<boolean> {
    // Try to get from memory first, or lazy-load from database
    const k8sDeployment = await this.getOrLoadDeployment(mcpServerId);
    if (!k8sDeployment) {
      return false;
    }
    return await k8sDeployment.usesStreamableHttp();
  }

  /**
   * Get the HTTP endpoint URL for a streamable-http server
   */
  async getHttpEndpointUrl(mcpServerId: string): Promise<string | undefined> {
    // Try to get from memory first, or lazy-load from database
    const k8sDeployment = await this.getOrLoadDeployment(mcpServerId);
    if (!k8sDeployment) {
      return undefined;
    }
    return k8sDeployment.getHttpEndpointUrl();
  }

  /**
   * Get a pod-pinned HTTP endpoint URL for streamable-http servers.
   * This helps preserve MCP sessions when multiple MCP server replicas are running.
   */
  async getRunningPodHttpEndpoint(
    mcpServerId: string,
  ): Promise<{ endpointUrl: string; podName: string } | undefined> {
    const k8sDeployment = await this.getOrLoadDeployment(mcpServerId);
    if (!k8sDeployment) {
      return undefined;
    }
    return k8sDeployment.getRunningPodHttpEndpoint();
  }

  /**
   * Get logs from an MCP server deployment
   */
  async getMcpServerLogs(
    mcpServerId: string,
    lines: number = 100,
  ): Promise<McpServerContainerLogs> {
    // Try to get from memory first, or lazy-load from database
    const k8sDeployment = await this.getOrLoadDeployment(mcpServerId);
    if (!k8sDeployment) {
      throw new Error(`MCP server not found`);
    }

    const containerName = k8sDeployment.containerName;
    const sanitizedId = sanitizeLabelValue(mcpServerId);
    return {
      logs: await k8sDeployment.getRecentLogs(lines),
      containerName,
      // Construct the kubectl command for the user to manually get the logs if they'd like
      command: `kubectl logs -n ${this.namespace} -l mcp-server-id=${sanitizedId} --tail=${lines}`,
      namespace: this.namespace,
    };
  }

  /**
   * Stream logs from an MCP server deployment with follow enabled
   * @param mcpServerId - The MCP server ID
   * @param responseStream - The stream to write logs to
   * @param lines - Number of initial lines to fetch
   * @param abortSignal - Optional abort signal to cancel the stream
   */
  async streamMcpServerLogs(
    mcpServerId: string,
    responseStream: NodeJS.WritableStream,
    lines: number = 100,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    // Try to get from memory first, or lazy-load from database
    const k8sDeployment = await this.getOrLoadDeployment(mcpServerId);
    if (!k8sDeployment) {
      this.writeLogsUnavailableMessage(responseStream, mcpServerId);
      return;
    }

    await k8sDeployment.streamLogs(responseStream, lines, abortSignal);
  }

  /**
   * Get the kubectl command for streaming logs from an MCP server
   */
  getMcpServerLogsCommand(mcpServerId: string, lines: number = 100): string {
    const sanitizedId = sanitizeLabelValue(mcpServerId);
    return `kubectl logs -n ${this.namespace} -l mcp-server-id=${sanitizedId} --tail=${lines} -f`;
  }

  /**
   * Get the kubectl command for describing pods for an MCP server
   */
  getMcpServerDescribeCommand(mcpServerId: string): string {
    const sanitizedId = sanitizeLabelValue(mcpServerId);
    return `kubectl describe pods -n ${this.namespace} -l mcp-server-id=${sanitizedId}`;
  }

  /**
   * Check if an MCP server has a running pod
   */
  async hasRunningPod(mcpServerId: string): Promise<boolean> {
    // Try to get from memory first, or lazy-load from database
    const k8sDeployment = await this.getOrLoadDeployment(mcpServerId);
    if (!k8sDeployment) {
      return false;
    }
    return k8sDeployment.hasRunningPod();
  }

  /**
   * Get the appropriate kubectl command based on pod status
   * Returns logs command if pod is running, describe command otherwise
   */
  async getAppropriateCommand(
    mcpServerId: string,
    lines: number = 100,
  ): Promise<string> {
    const hasRunning = await this.hasRunningPod(mcpServerId);
    if (hasRunning) {
      return this.getMcpServerLogsCommand(mcpServerId, lines);
    }
    return this.getMcpServerDescribeCommand(mcpServerId);
  }

  /**
   * Exec into an MCP server pod, spawning an interactive shell.
   * Returns the K8s WebSocket for bridging to a browser WebSocket.
   */
  async execIntoMcpServer(
    mcpServerId: string,
    stdin: import("node:stream").Readable,
    stdout: import("node:stream").Writable,
    stderr: import("node:stream").Writable,
  ) {
    const k8sDeployment = await this.getOrLoadDeployment(mcpServerId);
    if (!k8sDeployment) {
      throw new Error("MCP server not found");
    }
    return k8sDeployment.execIntoContainer(stdin, stdout, stderr);
  }

  /**
   * Get the kubectl exec command for an MCP server
   */
  getExecCommand(mcpServerId: string): string {
    const sanitizedId = sanitizeLabelValue(mcpServerId);
    return `kubectl exec -it -n ${this.namespace} $(kubectl get pods -n ${this.namespace} -l mcp-server-id=${sanitizedId} -o jsonpath='{.items[0].metadata.name}') -c mcp-server -- /bin/sh`;
  }

  /**
   * Get all available tools from all running MCP servers
   */
  get allAvailableTools(): AvailableTool[] {
    return [];
  }

  /**
   * Refresh the state of all deployments from K8s.
   * Detects state changes like a running pod entering CrashLoopBackOff.
   */
  async refreshAllStates(): Promise<void> {
    const refreshPromises = Array.from(
      this.mcpServerIdToDeploymentMap.values(),
    ).map((deployment) => deployment.refreshState().catch(() => {}));
    await Promise.all(refreshPromises);
  }

  /**
   * Get the runtime status summary
   */
  get statusSummary(): K8sRuntimeStatusSummary {
    return {
      status: this.status,
      mcpServers: Object.fromEntries(
        Array.from(this.mcpServerIdToDeploymentMap.entries()).map(
          ([mcpServerId, k8sDeployment]) => [
            mcpServerId,
            k8sDeployment.statusSummary,
          ],
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

    // Stop all deployments
    const stopPromises = Array.from(this.mcpServerIdToDeploymentMap.keys()).map(
      async (serverId) => {
        try {
          await this.stopServer(serverId);
        } catch (error) {
          logger.error(
            { err: error },
            `Failed to stop MCP server deployment ${serverId} during shutdown:`,
          );
        }
      },
    );

    await Promise.allSettled(stopPromises);
    logger.info("MCP Server Runtime shutdown complete");
  }

  /**
   * List Archestra-managed docker-registry secrets in the namespace.
   * Filters by `app=mcp-server,type=regcred` labels to exclude pre-existing secrets.
   * For non-admin users, further filters by `team-id` label matching the user's team IDs.
   *
   * Returns empty array when called without options to prevent accidental unscoped access.
   */
  async listDockerRegistrySecrets(options?: {
    isAdmin?: boolean;
    teamIds?: string[];
  }): Promise<Array<{ name: string }>> {
    if (!this.k8sApi) {
      return [];
    }

    // Default to restrictive: require explicit isAdmin or teamIds
    if (!options?.isAdmin && !options?.teamIds) {
      return [];
    }

    try {
      const secrets = await this.k8sApi.listNamespacedSecret({
        namespace: this.namespace,
        fieldSelector: "type=kubernetes.io/dockerconfigjson",
        labelSelector: "app=mcp-server,type=regcred",
      });

      let filtered = secrets.items;

      // For non-admin users, filter by team-id label
      if (!options.isAdmin && options.teamIds) {
        const teamIdSet = new Set(options.teamIds);
        filtered = filtered.filter((s) => {
          const teamId = s.metadata?.labels?.["team-id"];
          return teamId != null && teamIdSet.has(teamId);
        });
      }

      return filtered
        .map((s) => ({ name: s.metadata?.name ?? "" }))
        .filter((s) => s.name.length > 0);
    } catch (error) {
      logger.warn(
        { err: error },
        "Failed to list docker-registry secrets in namespace",
      );
      return [];
    }
  }

  /**
   * Backfill `team-id` labels on existing regcred secrets that were created
   * before this label was introduced. Uses the installed servers list to map
   * mcp-server-id → teamId.
   */
  private async backfillRegcredTeamLabels(
    installedServers: McpServer[],
  ): Promise<void> {
    if (!this.k8sApi) return;

    const serverIdToTeamId = new Map<string, string>();
    for (const server of installedServers) {
      if (server.teamId) {
        serverIdToTeamId.set(server.id, server.teamId);
      }
    }

    if (serverIdToTeamId.size === 0) return;

    try {
      const secrets = await this.k8sApi.listNamespacedSecret({
        namespace: this.namespace,
        labelSelector: "app=mcp-server,type=regcred",
        fieldSelector: "type=kubernetes.io/dockerconfigjson",
      });

      for (const secret of secrets.items) {
        const labels = secret.metadata?.labels;
        if (!labels || labels["team-id"]) continue; // already has team-id

        const serverId = labels["mcp-server-id"];
        if (!serverId) continue;

        const teamId = serverIdToTeamId.get(serverId);
        if (!teamId) continue;

        const secretName = secret.metadata?.name;
        if (!secretName) continue;

        try {
          await this.k8sApi.patchNamespacedSecret({
            name: secretName,
            namespace: this.namespace,
            body: {
              metadata: {
                labels: {
                  "team-id": sanitizeLabelValue(teamId),
                },
              },
            },
          });
          logger.info(
            { secretName, teamId },
            "Backfilled team-id label on regcred secret",
          );
        } catch (patchError) {
          logger.warn(
            { err: patchError, secretName },
            "Failed to backfill team-id label on regcred secret",
          );
        }
      }
    } catch (error) {
      logger.warn(
        { err: error },
        "Failed to list secrets for team-id backfill",
      );
    }
  }

  private writeLogsUnavailableMessage(
    responseStream: NodeJS.WritableStream,
    mcpServerId: string,
  ): void {
    if ("destroyed" in responseStream && responseStream.destroyed) {
      return;
    }

    const reason = this.k8sApi
      ? "Deployment not loaded in runtime."
      : "Kubernetes runtime is not configured on this instance.";
    const command = this.getMcpServerDescribeCommand(mcpServerId);
    const message = [
      "Unable to stream logs for this MCP server.",
      reason,
      "Try running:",
      command,
      "",
    ].join("\n");

    responseStream.write(message);
    responseStream.end();
  }
}

export default new McpServerRuntimeManager();
