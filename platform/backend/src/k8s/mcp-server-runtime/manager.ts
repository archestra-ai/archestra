import type * as k8s from "@kubernetes/client-node";
import { getK8sCapabilitiesFromApi } from "@/k8s/capabilities";
import {
  checkNamespaceDeployAccess,
  createK8sClients,
  loadKubeConfig,
  namespaceAccessMessage,
  sanitizeLabelValue,
} from "@/k8s/shared";
import logger from "@/logging";
import {
  EnvironmentModel,
  InternalMcpCatalogModel,
  McpHttpSessionModel,
  McpServerModel,
  OrganizationModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import { resolveEffectiveNetworkPolicy } from "@/services/environments/network-policy";
import type {
  EffectiveNetworkPolicy,
  K8sNetworkPolicyCapabilities,
  McpServer,
} from "@/types";
import { ensureEgressBaselineNetworkPolicy } from "./egress-baseline";
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

type CatalogItem = Awaited<ReturnType<typeof InternalMcpCatalogModel.findById>>;
type EnvironmentRow = Awaited<ReturnType<typeof EnvironmentModel.findById>>;
type OrganizationRow = Awaited<ReturnType<typeof OrganizationModel.getById>>;
type NetworkPolicyResolutionCache = {
  environmentsById: Map<string, EnvironmentRow>;
  organizationsById: Map<string, OrganizationRow>;
};
type DockerRegistrySecretSummary = {
  name: string;
  registryServers: string[];
};

/**
 * McpServerRuntimeManager manages MCP servers running in Kubernetes.
 * @public — exported for testability
 */
export class McpServerRuntimeManager {
  private k8sApi?: k8s.CoreV1Api;
  private k8sAppsApi?: k8s.AppsV1Api;
  private k8sAuthApi?: k8s.AuthorizationV1Api;
  private k8sNetworkingApi?: k8s.NetworkingV1Api;
  private k8sCustomObjectsApi?: k8s.CustomObjectsApi;
  private k8sAttach?: k8s.Attach;
  private k8sLog?: k8s.Log;
  private k8sExec?: k8s.Exec;
  private namespace: string = "default";
  private mcpServerIdToDeploymentMap: Map<string, K8sDeployment> = new Map();
  // Per-namespace in-flight ensure of the egress default-deny baseline, so
  // concurrent deploys share one call; cleared on start() to re-assert on re-init.
  private egressBaselineByNamespace: Map<string, Promise<void>> = new Map();
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
      this.k8sAuthApi = clients.authApi;
      this.k8sNetworkingApi = clients.networkingApi;
      this.k8sCustomObjectsApi = clients.customObjectsApi;
      this.k8sAttach = clients.attach;
      this.k8sExec = clients.exec;
      this.k8sLog = clients.log;
      this.namespace = clients.namespace;
    } catch (error) {
      logger.error({ err: error }, "Failed to load Kubernetes config");
      this.status = "error";
      this.k8sApi = undefined;
      this.k8sAppsApi = undefined;
      this.k8sAuthApi = undefined;
      this.k8sNetworkingApi = undefined;
      this.k8sCustomObjectsApi = undefined;
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

  get platformNamespace(): string {
    return this.namespace;
  }

  async validateNamespace(namespaceName: string): Promise<void> {
    if (!this.k8sAuthApi) {
      throw new Error("Kubernetes API client not initialized");
    }
    const result = await checkNamespaceDeployAccess(
      namespaceName,
      this.k8sAuthApi,
    );
    if (!result.ok) {
      throw new Error(namespaceAccessMessage(namespaceName, result.reason));
    }
  }

  /**
   * Initialize the runtime and start all installed MCP servers
   */
  async start(): Promise<void> {
    if (
      !this.k8sApi ||
      !this.k8sAppsApi ||
      !this.k8sNetworkingApi ||
      !this.k8sCustomObjectsApi
    ) {
      throw new Error("Kubernetes API client not initialized");
    }

    try {
      this.status = "initializing";
      this.egressBaselineByNamespace.clear();
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
      const localCatalogItems: CatalogItem[] = [];
      for (const server of installedServers) {
        if (server.catalogId) {
          const catalogItem = await InternalMcpCatalogModel.findById(
            server.catalogId,
          );
          if (catalogItem?.serverType === "local") {
            localServers.push(server);
            localCatalogItems.push(catalogItem);
          }
        }
      }

      logger.info(`Found ${localServers.length} local MCP servers to start`);

      const networkPolicyCapabilities = (
        await getK8sCapabilitiesFromApi(this.k8sCustomObjectsApi)
      ).networkPolicy;
      const networkPolicyResolutionCache =
        await this.buildNetworkPolicyResolutionCache(localCatalogItems);

      // Start all local servers in parallel
      const startPromises = localServers.map(async (mcpServer) => {
        await this.startServer(mcpServer, undefined, undefined, {
          networkPolicyCapabilities,
          networkPolicyResolutionCache,
        });
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

      this.cleanupOrphanedDeployments(installedServers).catch((err) => {
        logger.warn({ err }, "Failed to cleanup orphaned MCP deployments");
      });
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to initialize MCP Server Runtime: ${errorMsg}`);
      this.status = "error";
      this.onRuntimeStartupError(new Error(errorMsg));
      throw error;
    }
  }

  private ensureEgressBaseline(
    namespace: string,
    capabilities: K8sNetworkPolicyCapabilities,
  ): Promise<void> {
    let ensured = this.egressBaselineByNamespace.get(namespace);
    if (!ensured) {
      const networkingApi = this.k8sNetworkingApi;
      const customObjectsApi = this.k8sCustomObjectsApi;
      if (!networkingApi || !customObjectsApi) return Promise.resolve();
      ensured = ensureEgressBaselineNetworkPolicy({
        networkingApi,
        customObjectsApi,
        namespace,
        capabilities,
      }).then((succeeded) => {
        // Don't cache a failed attempt as done — drop it so the next deploy in
        // this namespace retries rather than leaving pods without the baseline.
        if (!succeeded) this.egressBaselineByNamespace.delete(namespace);
      });
      this.egressBaselineByNamespace.set(namespace, ensured);
    }
    return ensured;
  }

  private async resolveNamespaceForCatalog(
    catalogItem:
      | Awaited<ReturnType<typeof InternalMcpCatalogModel.findById>>
      | null
      | undefined,
    cache?: NetworkPolicyResolutionCache,
  ): Promise<string> {
    if (!catalogItem?.environmentId) return this.namespace;
    const env =
      cache?.environmentsById.get(catalogItem.environmentId) ??
      (await EnvironmentModel.findById(catalogItem.environmentId));
    return env?.namespace ?? this.namespace;
  }

  private async resolveNetworkPolicyForDeployment(params: {
    mcpServer: McpServer;
    catalogItem:
      | Awaited<ReturnType<typeof InternalMcpCatalogModel.findById>>
      | null
      | undefined;
    cache?: NetworkPolicyResolutionCache;
  }): Promise<EffectiveNetworkPolicy> {
    const environment =
      params.catalogItem?.environmentId && params.cache
        ? params.cache.environmentsById.get(params.catalogItem.environmentId)
        : params.catalogItem?.environmentId
          ? await EnvironmentModel.findById(params.catalogItem.environmentId)
          : null;
    const organizationId =
      params.catalogItem?.organizationId ?? environment?.organizationId ?? null;

    const organization = organizationId
      ? params.cache
        ? params.cache.organizationsById.get(organizationId)
        : await OrganizationModel.getById(organizationId)
      : await OrganizationModel.getFirst();

    if (!organization) return { source: "built_in", policy: null };

    return resolveEffectiveNetworkPolicy({
      organizationId: organization.id,
      environmentId: params.catalogItem?.environmentId,
      environmentNetworkPolicy: environment?.networkPolicy,
      defaultNetworkPolicy: organization?.defaultNetworkPolicy,
    });
  }

  private async buildNetworkPolicyResolutionCache(
    catalogItems: CatalogItem[],
  ): Promise<NetworkPolicyResolutionCache> {
    const environmentIds = uniqueStrings(
      catalogItems
        .map((catalogItem) => catalogItem?.environmentId)
        .filter((id): id is string => Boolean(id)),
    );
    const environments = await Promise.all(
      environmentIds.map((id) => EnvironmentModel.findById(id)),
    );
    const environmentsById = new Map<string, EnvironmentRow>();
    for (const environment of environments) {
      if (environment) environmentsById.set(environment.id, environment);
    }

    const organizationIds = uniqueStrings([
      ...catalogItems
        .map((catalogItem) => catalogItem?.organizationId)
        .filter((id): id is string => Boolean(id)),
      ...environments
        .map((environment) => environment?.organizationId)
        .filter((id): id is string => Boolean(id)),
    ]);
    const organizations = await Promise.all(
      organizationIds.map((id) => OrganizationModel.getById(id)),
    );
    const organizationsById = new Map<string, OrganizationRow>();
    for (const organization of organizations) {
      if (!organization) continue;
      organizationsById.set(organization.id, organization);
    }

    return {
      environmentsById,
      organizationsById,
    };
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
    options?: {
      networkPolicyCapabilities?: K8sNetworkPolicyCapabilities;
      networkPolicyResolutionCache?: NetworkPolicyResolutionCache;
    },
  ): Promise<void> {
    if (
      !this.k8sApi ||
      !this.k8sAppsApi ||
      !this.k8sNetworkingApi ||
      !this.k8sCustomObjectsApi
    ) {
      throw new Error("Kubernetes API client not initialized");
    }

    const { id, name } = mcpServer;
    logger.info(`Starting MCP server deployment: id="${id}", name="${name}"`);

    try {
      // Fetch catalog item (needed for conditional env var logic).
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

      // Overlay plain (non-secret) per-install env values from
      // `mcp_server.environmentValues`. The Secret bag above covers
      // secret-typed prompted values; this covers the plain-text
      // complement so the full set of user-supplied install values is
      // applied on every (re)deploy.
      if (mcpServer.environmentValues) {
        for (const [key, value] of Object.entries(
          mcpServer.environmentValues,
        )) {
          if (value != null) {
            if (!effectiveEnvironmentValues) {
              effectiveEnvironmentValues = {};
            }
            effectiveEnvironmentValues[key] = String(value);
          }
        }
      }

      const deploymentNamespace = await this.resolveNamespaceForCatalog(
        catalogItem,
        options?.networkPolicyResolutionCache,
      );
      const networkPolicyCapabilities =
        options?.networkPolicyCapabilities ??
        (await getK8sCapabilitiesFromApi(this.k8sCustomObjectsApi))
          .networkPolicy;

      // Ensure the namespace default-deny baseline before the pod exists, so an
      // un-reconciled or apply-failed pod is denied by default rather than open.
      await this.ensureEgressBaseline(
        deploymentNamespace,
        networkPolicyCapabilities,
      );

      const k8sDeployment = new K8sDeployment({
        mcpServer,
        k8sApi: this.k8sApi,
        k8sAppsApi: this.k8sAppsApi,
        k8sNetworkingApi: this.k8sNetworkingApi,
        k8sCustomObjectsApi: this.k8sCustomObjectsApi,
        k8sAttach: this.k8sAttach,
        k8sLog: this.k8sLog,
        namespace: deploymentNamespace,
        catalogItem,
        userConfigValues,
        environmentValues: effectiveEnvironmentValues,
        effectiveNetworkPolicy: await this.resolveNetworkPolicyForDeployment({
          mcpServer,
          catalogItem,
          cache: options?.networkPolicyResolutionCache,
        }),
        networkPolicyCapabilities,
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
      // Multi-tenant catalogs share one K8s deployment across all callers.
      // Only the last caller out should delete the deployment / service /
      // secret. Earlier callers just drop their in-memory reference.
      const sharedWithOthers =
        await McpServerRuntimeManager.isSharedMultitenantDeployment(
          mcpServerId,
        );

      if (!sharedWithOthers) {
        // Delete deployment first
        await k8sDeployment.stopDeployment();

        // Delete K8s Service (if it exists, for HTTP-based servers)
        await k8sDeployment.deleteK8sService();

        // Delete K8s Secret (if it exists)
        await k8sDeployment.deleteK8sSecret();

        // Delete docker-registry secrets (if any were created for imagePullSecrets)
        await k8sDeployment.deleteDockerRegistrySecrets();

        // Delete K8s NetworkPolicy (if it exists)
        await k8sDeployment.deleteK8sNetworkPolicy();
      } else {
        logger.info(
          { mcpServerId },
          "Skipping K8s deployment teardown: multi-tenant catalog still has other callers",
        );
      }

      this.mcpServerIdToDeploymentMap.delete(mcpServerId);
    }
  }

  /**
   * Returns true when the given mcp_server row points at a multi-tenant
   * catalog that still has at least one other mcp_server row aliasing the
   * same shared K8s deployment.
   */
  private static async isSharedMultitenantDeployment(
    mcpServerId: string,
  ): Promise<boolean> {
    const mcpServer = await McpServerModel.findById(mcpServerId);
    if (!mcpServer?.catalogId) return false;

    const catalogItem = await InternalMcpCatalogModel.findById(
      mcpServer.catalogId,
    );
    if (!catalogItem?.multitenant) return false;

    const siblings = await McpServerModel.findByCatalogId(mcpServer.catalogId);
    return siblings.some((s) => s.id !== mcpServerId);
  }

  /**
   * Get a deployment by MCP server ID, loading from database if not in memory.
   * This handles the case where multiple replicas exist and the deployment was
   * created by a different replica.
   */
  async getOrLoadDeployment(
    mcpServerId: string,
    opts?: { namespaceOverride?: string },
  ): Promise<K8sDeployment | undefined> {
    // An explicit namespace override (relocation teardown) bypasses the cache: a
    // cached entry can hold a stale namespace, the one value we must not trust
    // here. Build fresh, pinned to the given namespace; don't touch the cache.
    const namespaceOverride = opts?.namespaceOverride;
    if (!namespaceOverride) {
      // First check if already in memory
      const existing = this.mcpServerIdToDeploymentMap.get(mcpServerId);
      if (existing) {
        return existing;
      }
    }

    // Not in memory - try to load from database
    if (
      !this.k8sApi ||
      !this.k8sAppsApi ||
      !this.k8sNetworkingApi ||
      !this.k8sCustomObjectsApi ||
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
        k8sNetworkingApi: this.k8sNetworkingApi,
        k8sCustomObjectsApi: this.k8sCustomObjectsApi,
        k8sAttach: this.k8sAttach,
        k8sLog: this.k8sLog,
        namespace:
          namespaceOverride ??
          (await this.resolveNamespaceForCatalog(catalogItem)),
        catalogItem,
        effectiveNetworkPolicy: await this.resolveNetworkPolicyForDeployment({
          mcpServer,
          catalogItem,
        }),
        networkPolicyCapabilities: (
          await getK8sCapabilitiesFromApi(this.k8sCustomObjectsApi)
        ).networkPolicy,
        k8sExec: this.k8sExec,
      });

      // Teardown path (explicit namespace): skip endpoint resolution and the
      // cache so a torn-down deployment never overwrites a live cache entry.
      if (namespaceOverride) {
        return k8sDeployment;
      }

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
   * Tear down a local catalog's per-install deployments in the namespace
   * resolved from the SUPPLIED catalog snapshot, bypassing the in-memory cache.
   *
   * During an environment reassignment, call this with the pre-update catalog
   * item (which still holds the old environment) BEFORE recreating the
   * deployment in the new namespace. Deriving the namespace from the snapshot —
   * not the live row or a cached deployment — is what makes the teardown correct
   * on a cache-cold or cache-stale replica, which would otherwise re-resolve the
   * new namespace and orphan the old-namespace pod.
   * @public — invoked from the internal-mcp-catalog PUT route
   */
  async tearDownOldNamespaceDeployments(
    catalogSnapshot:
      | Awaited<ReturnType<typeof InternalMcpCatalogModel.findById>>
      | null
      | undefined,
  ): Promise<void> {
    if (!this.isEnabled || !catalogSnapshot) {
      return;
    }
    const namespace = await this.resolveNamespaceForCatalog(catalogSnapshot);
    const installs = await McpServerModel.findByCatalogId(catalogSnapshot.id);
    await Promise.all(
      installs.map(async (mcpServer) => {
        const deployment = await this.getOrLoadDeployment(mcpServer.id, {
          namespaceOverride: namespace,
        });
        if (!deployment) {
          return;
        }
        await deployment.removeDeployment();
        // Drop any cached entry so the recreate path rebuilds against the new
        // namespace instead of returning this torn-down, old-namespace object.
        this.mcpServerIdToDeploymentMap.delete(mcpServer.id);
      }),
    );
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
      const sharedWithOthers =
        await McpServerRuntimeManager.isSharedMultitenantDeployment(
          mcpServerId,
        );
      if (sharedWithOthers) {
        logger.info(
          { mcpServerId },
          "Skipping K8s deployment removal: multi-tenant catalog still has other callers",
        );
      } else {
        await k8sDeployment.removeDeployment();
        logger.info(
          `Successfully removed MCP server deployment ${mcpServerId}`,
        );
      }
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
   * Reinstall the shared K8s Deployment for a multi-tenant local catalog.
   *
   * Per-install `restartServer` is a no-op when siblings exist (the sibling
   * guard in `stopServer` preserves the shared pod). This method is the
   * catalog-level equivalent: it explicitly tears down and recreates the
   * shared Deployment so catalog-scope spec edits (image, command, args,
   * transport) actually roll out. Uses the same delete + create primitive
   * single-tenant Reinstall uses; the sibling guard is intentionally
   * bypassed because this is a catalog-level action, not a per-tenant one.
   *
   * Tool re-sync is the caller's responsibility (the endpoint runs it for
   * every install attached to the catalog after the pod is Ready).
   */
  async reinstallSharedDeployment(catalogId: string): Promise<void> {
    logger.info(`Reinstalling shared deployment for catalog: ${catalogId}`);

    const installs = await McpServerModel.findByCatalogId(catalogId);
    if (installs.length === 0) {
      logger.info(
        { catalogId },
        "No installs attached to catalog; nothing to reinstall",
      );
      return;
    }

    // Pick any install as the representative — they all alias the same
    // shared Deployment.
    const representative = installs[0];

    // Stale HTTP MCP sessions for ALL installs become invalid once the
    // pod is recreated.
    for (const install of installs) {
      await McpHttpSessionModel.deleteByMcpServerId(install.id);
    }

    const k8sDeployment = await this.getOrLoadDeployment(representative.id);
    if (k8sDeployment) {
      // Unconditional teardown — explicitly bypasses the
      // `isSharedMultitenantDeployment` guard that `stopServer` applies.
      // That guard exists for per-tenant uninstalls; catalog-level
      // reinstall is authorized to remove the shared pod.
      await k8sDeployment.stopDeployment();
      await k8sDeployment.deleteK8sService();
      await k8sDeployment.deleteK8sSecret();
      await k8sDeployment.deleteDockerRegistrySecrets();
      await k8sDeployment.deleteK8sNetworkPolicy();
    }

    // Clear every sibling's in-memory entry — the K8s objects are gone.
    for (const install of installs) {
      this.mcpServerIdToDeploymentMap.delete(install.id);
    }

    // Match single-tenant restart cadence: brief pause before recreate.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await this.startServer(representative);

    const newDeployment = await this.getOrLoadDeployment(representative.id);
    if (newDeployment) {
      await newDeployment.waitForDeploymentReady(60, 2000);
    }

    logger.info(
      { catalogId, representativeId: representative.id },
      "Shared deployment reinstalled successfully",
    );
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

      // Multi-tenant catalogs share one K8s deployment across all installs.
      // A per-install restart has nothing to actually restart here: the
      // sibling guard in `stopServer` correctly preserves the shared pod,
      // but `startServer` would then try to create the deployment/service
      // again and get a 409 from K8s ("already exists"), surfacing as a
      // bogus "Installation failed" on the install row even though the
      // pod is healthy.
      //
      // For multi-tenant catalogs the authorized path to recreate the
      // shared pod is `reinstallSharedDeployment` (catalog-level, invoked
      // by POST /api/internal_mcp_catalog/:id/reinstall). It bypasses the
      // sibling guard and tears down + recreates the pod for everyone in
      // one shot. Per-install reinstall on a multi-tenant catalog is a
      // bookkeeping operation (persist new prompted secrets + tool resync
      // against the existing pod) and must not touch K8s state.
      // TODO: ideally it all should live in a single method, and not be split
      const isShared =
        await McpServerRuntimeManager.isSharedMultitenantDeployment(
          mcpServerId,
        );
      if (isShared) {
        await this.getOrLoadDeployment(mcpServerId);
        logger.info(
          { mcpServerId },
          "Skipping K8s deployment restart: multi-tenant catalog has other callers; use reinstallSharedDeployment for catalog-level rollouts",
        );
        return;
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
    return {
      logs: await k8sDeployment.getRecentLogs(lines),
      containerName,
      // Construct the kubectl command for the user to manually get the logs if they'd like.
      // Use the catalog-stable deployment name as a label so multi-tenant aliasing works
      // (per-row mcp-server-id label only matches the first caller's pod).
      command: `kubectl logs -n ${k8sDeployment.k8sNamespace} deployment/${k8sDeployment.k8sDeploymentName} --tail=${lines}`,
      namespace: k8sDeployment.k8sNamespace,
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
      await this.writeLogsUnavailableMessage(responseStream, mcpServerId);
      return;
    }

    await k8sDeployment.streamLogs(responseStream, lines, abortSignal);
  }

  /**
   * Get the kubectl command for streaming logs from an MCP server
   */
  async getMcpServerLogsCommand(
    mcpServerId: string,
    lines: number = 100,
  ): Promise<string> {
    const k8sDeployment = await this.getOrLoadDeployment(mcpServerId);
    const deploymentName = k8sDeployment?.k8sDeploymentName;
    const ns = k8sDeployment?.k8sNamespace ?? this.namespace;
    if (deploymentName) {
      return `kubectl logs -n ${ns} deployment/${deploymentName} --tail=${lines} -f`;
    }
    const sanitizedId = sanitizeLabelValue(mcpServerId);
    return `kubectl logs -n ${ns} -l mcp-server-id=${sanitizedId} --tail=${lines} -f`;
  }

  /**
   * Get the kubectl command for describing pods for an MCP server
   */
  async getMcpServerDescribeCommand(mcpServerId: string): Promise<string> {
    const k8sDeployment = await this.getOrLoadDeployment(mcpServerId);
    const deploymentName = k8sDeployment?.k8sDeploymentName;
    const ns = k8sDeployment?.k8sNamespace ?? this.namespace;
    if (deploymentName) {
      return `kubectl describe deployment -n ${ns} ${deploymentName}`;
    }
    const sanitizedId = sanitizeLabelValue(mcpServerId);
    return `kubectl describe pods -n ${ns} -l mcp-server-id=${sanitizedId}`;
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
    onStatus?: (status: k8s.V1Status) => void,
  ) {
    const k8sDeployment = await this.getOrLoadDeployment(mcpServerId);
    if (!k8sDeployment) {
      throw new Error("MCP server not found");
    }
    return k8sDeployment.execIntoContainer(stdin, stdout, stderr, { onStatus });
  }

  /**
   * Get the kubectl exec command for an MCP server
   */
  getExecCommand(mcpServerId: string): string {
    const ns =
      this.mcpServerIdToDeploymentMap.get(mcpServerId)?.k8sNamespace ??
      this.namespace;
    const sanitizedId = sanitizeLabelValue(mcpServerId);
    return `kubectl exec -it -n ${ns} $(kubectl get pods -n ${ns} -l mcp-server-id=${sanitizedId} -o jsonpath='{.items[0].metadata.name}') -c mcp-server -- /bin/sh`;
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
  }): Promise<DockerRegistrySecretSummary[]> {
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
        .map((s) => ({
          name: s.metadata?.name ?? "",
          registryServers: getDockerConfigRegistryServers(s),
        }))
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

  /**
   * Sweep deployments whose names no longer match the current name produced by
   * K8sDeployment.constructDeploymentName for their owning server.
   */
  private async cleanupOrphanedDeployments(
    installedServers: McpServer[],
  ): Promise<void> {
    if (!this.k8sApi || !this.k8sAppsApi) return;

    const serverById = new Map<string, McpServer>();
    for (const server of installedServers) {
      serverById.set(server.id, server);
    }

    const catalogCache = new Map<
      string,
      Awaited<ReturnType<typeof InternalMcpCatalogModel.findById>>
    >();
    const getCatalog = async (catalogId: string | null | undefined) => {
      if (!catalogId) return null;
      if (catalogCache.has(catalogId)) {
        return catalogCache.get(catalogId) ?? null;
      }
      const catalog = await InternalMcpCatalogModel.findById(catalogId);
      catalogCache.set(catalogId, catalog);
      return catalog;
    };

    try {
      const deployments = await this.k8sAppsApi.listNamespacedDeployment({
        namespace: this.namespace,
        labelSelector: "app=mcp-server",
      });

      for (const deployment of deployments.items) {
        const labels = deployment.metadata?.labels;
        const deploymentName = deployment.metadata?.name;
        if (!labels || !deploymentName) continue;

        const serverId = labels["mcp-server-id"];
        if (!serverId) continue;

        const server = serverById.get(serverId);
        if (!server) continue;

        const catalog = await getCatalog(server.catalogId);
        const expectedName = K8sDeployment.constructDeploymentName(
          server,
          catalog,
        );

        if (deploymentName === expectedName) continue;

        logger.info(
          { deploymentName, expectedName, serverId },
          "Deleting orphaned MCP deployment with stale name",
        );

        try {
          await this.k8sAppsApi.deleteNamespacedDeployment({
            name: deploymentName,
            namespace: this.namespace,
          });
        } catch (err) {
          logger.warn(
            { err, deploymentName },
            "Failed to delete orphaned MCP deployment",
          );
        }

        try {
          await this.k8sApi.deleteNamespacedService({
            name: `${deploymentName}-service`,
            namespace: this.namespace,
          });
        } catch (err) {
          logger.debug(
            { err, deploymentName },
            "No orphaned service to delete (or already gone)",
          );
        }
      }
    } catch (error) {
      logger.warn({ err: error }, "Failed to sweep orphaned MCP deployments");
    }
  }

  private async writeLogsUnavailableMessage(
    responseStream: NodeJS.WritableStream,
    mcpServerId: string,
  ): Promise<void> {
    if ("destroyed" in responseStream && responseStream.destroyed) {
      return;
    }

    const reason = this.k8sApi
      ? "Deployment not loaded in runtime."
      : "Kubernetes runtime is not configured on this instance.";
    const command = await this.getMcpServerDescribeCommand(mcpServerId);
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

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function getDockerConfigRegistryServers(secret: k8s.V1Secret): string[] {
  const encodedDockerConfig = secret.data?.[".dockerconfigjson"];
  if (!encodedDockerConfig) {
    return [];
  }

  try {
    const dockerConfig = JSON.parse(
      Buffer.from(encodedDockerConfig, "base64").toString("utf8"),
    );
    if (
      !dockerConfig ||
      typeof dockerConfig !== "object" ||
      !("auths" in dockerConfig) ||
      !dockerConfig.auths ||
      typeof dockerConfig.auths !== "object" ||
      Array.isArray(dockerConfig.auths)
    ) {
      return [];
    }

    return Object.keys(dockerConfig.auths).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    logger.warn({ err: error }, "Failed to parse docker-registry secret data");
    return [];
  }
}

export default new McpServerRuntimeManager();
