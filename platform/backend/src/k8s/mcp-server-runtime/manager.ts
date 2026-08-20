import type { McpDeploymentState } from "@archestra/shared";
import type * as k8s from "@kubernetes/client-node";
import { Watch } from "@kubernetes/client-node";
import config from "@/config";
import { getK8sCapabilitiesFromApi } from "@/k8s/capabilities";
import {
  checkNamespaceDeployAccess,
  createK8sClients,
  isK8sNotFoundError,
  loadKubeConfig,
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  MCP_HIBERNATED_ANNOTATION,
  // SPDX-SnippetEnd
  namespaceAccessMessage,
  sanitizeLabelValue,
} from "@/k8s/shared";
import logger from "@/logging";
import {
  type ClusterLeaseGuard,
  ClusterLeaseHeldError,
  EnvironmentModel,
  InternalMcpCatalogModel,
  McpDeploymentLeaseModel,
  McpHttpSessionModel,
  McpServerModel,
  OrganizationModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import { resolveEffectiveNetworkPolicy } from "@/services/environments/network-policy";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// biome-ignore lint/style/noRestrictedImports: runtime-gated EE model import
import { mcpActiveUseTracker } from "@/services/mcp-active-use.ee";
// SPDX-SnippetEnd
import type {
  EffectiveNetworkPolicy,
  K8sNetworkPolicyCapabilities,
  McpServer,
} from "@/types";
import { mapWithConcurrency } from "@/utils/concurrency";
import {
  MCP_DEPLOYMENT_TRANSITION_DEADLINE_MS,
  MCP_DEPLOYMENT_TRANSITION_LEASE_SCOPE,
} from "./deployment-transition";
import { ensureEgressBaselineNetworkPolicy } from "./egress-baseline";
import {
  createHardResetStatusMarker,
  HARD_RESET_STATUS_MARKER_PREFIX,
  markHardResetTeardownComplete,
  parseHardResetStatusMarker,
  writeHardResetStatuses,
} from "./hard-reset-status";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  FOREIGN_RESUME_COOLDOWN_MAX_EXPONENT,
  FOREIGN_RESUME_LIMIT,
  type HibernationRuntimeHost,
  idleHibernationWindowSeconds,
  isIdleHibernationOffered,
  McpServerWakeError,
  McpServerWakePendingError,
  SWEEP_DEADLINE_MS,
  sweepIdleDeployments,
  wakeDeployment,
  wakeResponseBudgetMs,
  withDeadline,
  // biome-ignore lint/style/noRestrictedImports: runtime-gated EE model import
} from "./hibernation.ee";
// SPDX-SnippetEnd
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// biome-ignore lint/style/noRestrictedImports: runtime-gated EE model import
import { McpImagePrepuller } from "./image-prepuller.ee";
// SPDX-SnippetEnd
import K8sDeployment, {
  fetchPlatformPodNodeSelector,
  fetchPlatformPodTolerations,
} from "./k8s-deployment";
import { resolveRuntimeOwnerReferences } from "./runtime-owner";
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
 * What a hard reset actually did, reported back to the administrator who asked
 * for it. Structured rather than a success flag because the interesting part is
 * the detail: whether the old pod had to be force-killed (the deployment was
 * genuinely wedged, not merely slow), which sibling installs were swept up with
 * it, and which deployment was rebuilt.
 */
type McpServerHardResetResult = {
  mcpServerId: string;
  /** `namespace/name` of the Deployment that was destroyed and rebuilt. */
  physicalDeployment: string;
  /**
   * Every install whose derived runtime state was erased: the caller's, plus
   * every sibling sharing the physical deployment on a multitenant catalog.
   */
  resetServerIds: string[];
  teardown:
    | { outcome: "terminated" }
    | { outcome: "force-killed"; pods: string[] }
    | { outcome: "unverified"; reason: string };
  recreated:
    | false
    | { target: "shared-catalog-deployment"; catalogId: string }
    | { target: "install-deployment" };
  /**
   * Whether the rebuilt deployment is actually serving. Distinct from
   * `recreated`, which only says which Deployment was rebuilt: a recovery
   * action that reported success the moment a Deployment object existed would
   * call a crashlooping rebuild a recovery, and erase the very error the
   * administrator reached for the reset over.
   */
  rebuild: { outcome: "ready" } | { outcome: "not-ready"; reason: string };
};

type McpServerHardResetStart = {
  resetServerIds: string[];
  getStatusMarker: () => string;
};

type McpServerHardResetInFlight = {
  started: Promise<McpServerHardResetStart>;
  completion: Promise<McpServerHardResetResult>;
  acknowledgePending: (error?: unknown) => void;
  runFencedStatusWrite: ClusterLeaseGuard["runFencedMutation"];
  acknowledgeReporting: () => void;
};

/**
 * A hard reset that is under way, handed back as soon as its target is known
 * rather than when it finishes.
 *
 * The teardown-plus-rebuild takes minutes; no HTTP request may be held open
 * that long. So the reset is addressable before it settles: what it is acting
 * on is known up front and is true for the whole run, and `completion` is the
 * one place the report of it arrives — for the caller that starts the reset and
 * for every caller that joins it.
 */
type McpServerHardReset = {
  mcpServerId: string;
  /** `namespace/name` of the Deployment being destroyed and rebuilt. */
  physicalDeployment: string;
  /** Every install whose derived runtime state this reset erases. */
  resetServerIds: string[];
  completion: Promise<McpServerHardResetResult>;
  /** Only the initiating request records pending/final installation statuses. */
  reportsOutcome: boolean;
  /** Current durable compare-and-set identity for status recovery. */
  getStatusMarker: () => string;
  /** Allow destructive work after pending installation statuses are recorded. */
  acknowledgePending: (error?: unknown) => void;
  /** Fence status writes against a newer reset taking over the same lease. */
  runFencedStatusWrite: ClusterLeaseGuard["runFencedMutation"];
  /** Release the reset lease after the initiating request records its result. */
  acknowledgeReporting: () => void;
};

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Re-exported so demand-lane callers (mcp-client) keep importing the whole
 * runtime surface from one place — these belong with the hibernation lifecycle
 * that raises and bounds them.
 * @public — used by demand-lane callers (mcp-client) that wake servers on use
 */
export {
  McpServerWakeError,
  McpServerWakePendingError,
  wakeResponseBudgetMs,
  withDeadline,
};
// SPDX-SnippetEnd

/**
 * Another replica holds the cluster-wide lease for this physical deployment's
 * hard reset. Not a failure: the reset IS running, on a process that is not
 * this one, and its outcome lands on the install statuses like any reset that
 * outlives its request. Routes translate this into their "in-progress" shape.
 */
export class McpServerHardResetHeldElsewhereError extends Error {
  constructor(
    readonly physicalDeployment: string,
    readonly resetServerIds: string[],
  ) {
    super(
      `A hard reset of deployment ${physicalDeployment} is already running on another replica; its outcome will land on the install statuses.`,
    );
    this.name = "McpServerHardResetHeldElsewhereError";
  }
}

/**
 * McpServerRuntimeManager manages MCP servers running in Kubernetes.
 * @public — exported for testability
 */
export class McpServerRuntimeManager {
  private k8sApi?: k8s.CoreV1Api;
  private k8sAppsApi?: k8s.AppsV1Api;
  private k8sAuthApi?: k8s.AuthorizationV1Api;
  private k8sRbacApi?: k8s.RbacAuthorizationV1Api;
  private k8sNetworkingApi?: k8s.NetworkingV1Api;
  private k8sCustomObjectsApi?: k8s.CustomObjectsApi;
  private k8sAttach?: k8s.Attach;
  private k8sLog?: k8s.Log;
  private k8sExec?: k8s.Exec;
  private namespace: string = "default";
  private kubeConfig?: k8s.KubeConfig;
  private mcpServerIdToDeploymentMap: Map<string, K8sDeployment> = new Map();
  // Per-namespace in-flight ensure of the egress default-deny baseline, so
  // concurrent deploys share one call; cleared on start() to re-assert on re-init.
  private egressBaselineByNamespace: Map<string, Promise<void>> = new Map();
  private status: K8sRuntimeStatus = "not_initialized";
  // Periodic sweep of Failed/Evicted MCP pods (DiskPressure eviction cascades
  // can leave hundreds of Failed pod corpses that nothing else cleans up).
  private failedPodReapTimer?: NodeJS.Timeout;

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  // === Idle hibernation ===
  // Periodic sweep that scales idle MCP deployments to 0 replicas. Gating and
  // orchestration live in ./hibernation.ee; only the timer is here.
  private idleHibernationSweepTimer?: NodeJS.Timeout;
  // In-flight guard: a slow sweep (DB reads + K8s patches fan-out) must not
  // overlap the next tick.
  private idleHibernationSweepInFlight?: Promise<void>;
  // Keeps every node's image cache warm so a hibernated deployment can wake
  // without the registry. Owns its own timers, gating and failure handling in
  // ./image-prepuller.ee; nothing here ever awaits it.
  private imagePrepuller?: McpImagePrepuller;
  // Single-flight wakes keyed by physical deployment (`namespace/name`), so
  // every sibling install and every concurrent caller of a shared deployment
  // awaits ONE wake instead of racing scale-up patches.
  private wakeInFlightByPhysicalKey: Map<string, Promise<void>> = new Map();
  // Physical deployments this process put to sleep and has not woken itself.
  // A deployment that comes back while it is in here was resumed by somebody
  // else, which is the only way to notice we are sharing spec.replicas with
  // another controller.
  private hibernatedByUsAtByPhysicalKey = new Map<string, number>();
  // How many times each deployment has been resumed that way. Past the limit
  // it stops being a hibernation candidate: something else owns its replica
  // count, and re-hibernating it just kills the pod again on the next tick.
  private foreignResumeCountByPhysicalKey = new Map<string, number>();
  private foreignReplicaOwners = new Set<string>();
  // Sweeps left to skip for a deployment we have just seen resumed.
  private foreignResumeCooldownTicks = new Map<string, number>();
  // SPDX-SnippetEnd
  // Single-flight hard resets, keyed the same way: the teardown destroys the
  // pod every sibling install shares, so a second concurrent reset must join
  // the first rather than delete what the first one is recreating. Membership
  // is also what hides a deployment from the idle sweeper for the duration.
  private hardResetInFlightByPhysicalKey = new Map<
    string,
    McpServerHardResetInFlight
  >();
  private hardResetPhysicalKeyByServerId = new Map<string, string>();
  private hardResetStatusReconcileTimer?: NodeJS.Timeout;
  private hardResetStatusReconcileInFlight?: Promise<void>;
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  // Callbacks invoked (with every sibling server id) after a successful
  // hibernate, registered by mcp-client at module setup to invalidate its
  // pooled connections — a callback registry avoids a manager→mcp-client
  // import cycle.
  private hibernationListeners = new Set<
    (mcpServerIds: string[]) => Promise<void> | void
  >();
  // SPDX-SnippetEnd

  // === Deployment-state watch streams ===
  // Event-driven state refresh: long-lived K8s watch streams on the pods and
  // deployments this runtime creates (label app=mcp-server) trigger a
  // debounced refreshAllStates() sweep, so deployment states update when the
  // cluster changes instead of relying on a fixed-interval poll. Streams are
  // keyed `${namespace}|${kind}`.
  private deploymentStateWatchersStarted = false;
  private deploymentStateWatchersStopped = false;
  private watchedNamespaces = new Set<string>();
  private expectedWatchStreams = new Set<string>();
  private liveWatchStreams = new Set<string>();
  private watchStreamAborts = new Map<string, AbortController>();
  private watchStreamRestartTimers = new Map<string, NodeJS.Timeout>();
  private watchStreamFailureLogged = new Set<string>();
  private watchRefreshDebounceTimer?: NodeJS.Timeout;
  private stateRefreshListeners = new Set<() => void>();
  private refreshAllStatesInFlight?: Promise<void>;
  private refreshAllStatesFollowUpRequested = false;

  /**
   * Settles once the startup adopt pass has frozen every local install's
   * `deployment_name` (rejected if the pass failed or the runtime never
   * initialized). The rename cascade awaits this before its freeze-fallback:
   * post-adopt, a still-NULL row provably has no live deployment, so
   * freezing a recomputed name there cannot orphan anything. Single-shot —
   * a failed adopt keeps renames blocked until the process restarts
   * (churn-prevention outranks availability).
   */
  readonly deploymentNamesAdopted: Promise<void>;
  private resolveDeploymentNamesAdopted!: () => void;
  private rejectDeploymentNamesAdopted!: (error: Error) => void;

  // Callbacks for initialization events
  onRuntimeStartupSuccess: () => void = () => {};
  onRuntimeStartupError: (error: Error) => void = () => {};

  constructor() {
    this.deploymentNamesAdopted = new Promise((resolve, reject) => {
      this.resolveDeploymentNamesAdopted = resolve;
      this.rejectDeploymentNamesAdopted = reject;
    });
    // A rename may never happen — don't let an un-awaited adopt failure
    // surface as an unhandled rejection.
    this.deploymentNamesAdopted.catch(() => {});

    try {
      const { kubeConfig, namespace } = loadKubeConfig();
      const clients = createK8sClients(kubeConfig, namespace);

      // Retained for the deployment-state watch streams (k8s.Watch takes the
      // config, not a generated API client).
      this.kubeConfig = kubeConfig;
      this.k8sApi = clients.coreApi;
      this.k8sAppsApi = clients.appsApi;
      this.k8sAuthApi = clients.authApi;
      this.k8sRbacApi = clients.rbacApi;
      this.k8sNetworkingApi = clients.networkingApi;
      this.k8sCustomObjectsApi = clients.customObjectsApi;
      this.k8sAttach = clients.attach;
      this.k8sExec = clients.exec;
      this.k8sLog = clients.log;
      this.namespace = clients.namespace;
    } catch (error) {
      logger.error({ err: error }, "Failed to load Kubernetes config");
      this.rejectDeploymentNamesAdopted(
        new Error(
          "Kubernetes runtime failed to initialize; deployment names were not adopted",
        ),
      );
      this.status = "error";
      this.k8sApi = undefined;
      this.k8sAppsApi = undefined;
      this.k8sAuthApi = undefined;
      this.k8sRbacApi = undefined;
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
    return process.env.POD_NAMESPACE || this.namespace;
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
      await fetchPlatformPodNodeSelector(this.k8sApi, this.platformNamespace);
      await fetchPlatformPodTolerations(this.k8sApi, this.platformNamespace);

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

      // Freeze deployment identity BEFORE anything touches K8s: the
      // startServer loop below redeploys every install, so a pre-upgrade row
      // whose DB name diverged from its live deployment would otherwise
      // deploy under a freshly recomputed name and orphan the live one.
      // Errors are fatal by design — churn-prevention outranks runtime
      // availability.
      try {
        await this.adoptDeploymentNames({ localServers, localCatalogItems });
        this.resolveDeploymentNamesAdopted();
      } catch (error) {
        this.rejectDeploymentNamesAdopted(
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      }

      const networkPolicyCapabilities = (
        await getK8sCapabilitiesFromApi(
          this.k8sCustomObjectsApi,
          this.networkPolicyProbeSource(),
        )
      ).networkPolicy;
      const networkPolicyResolutionCache =
        await this.buildNetworkPolicyResolutionCache(localCatalogItems);

      // Start all local servers with bounded parallelism: each startServer
      // fires a burst of K8s API calls, and reconciling every install at
      // once can trip the API server's Priority & Fairness throttling
      // (429 "Too many requests"), making healthy deployments look broken.
      const results = await mapWithConcurrency(
        localServers,
        K8S_API_FANOUT_CONCURRENCY,
        (mcpServer) =>
          this.startServer(mcpServer, undefined, undefined, {
            networkPolicyCapabilities,
            networkPolicyResolutionCache,
          }),
      );

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

      // Re-assert every server's egress policy so a restart reconciles floors for
      // already-running servers, not only newly-created ones. Without this a
      // server whose deploy path didn't (re)apply its floor stays under the
      // namespace deny-all baseline — no egress — until a manual policy change.
      await this.reconcileEgressPolicies({
        localServers,
        localCatalogItems,
        capabilities: networkPolicyCapabilities,
        cache: networkPolicyResolutionCache,
      });

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

      this.startFailedPodReaper();
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      this.startIdleHibernationSweeper();
      this.imagePrepuller = new McpImagePrepuller({
        coreApi: this.k8sApi,
        appsApi: this.k8sAppsApi,
        rbacApi: this.k8sRbacApi,
        namespace: this.namespace,
        platformNamespace: this.platformNamespace,
      });
      this.imagePrepuller.start();
      // SPDX-SnippetEnd

      // Start watch streams only after the reconcile above settles: the mass
      // startServer pass generates a storm of pod/deployment events that
      // would just trigger redundant refresh sweeps mid-startup.
      this.startDeploymentStateWatchers();
      this.startHardResetStatusReconciler();
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to initialize MCP Server Runtime: ${errorMsg}`);
      this.status = "error";
      // Guarantee the adopt gate is always settled. A throw BEFORE the adopt
      // block (verifyK8sConnection, node-selector/tolerations fetch, findAll,
      // the per-server catalog lookup) would otherwise leave this promise
      // pending forever, and the rename route awaits it with no timeout —
      // hanging the request for the process lifetime. Safe to call
      // unconditionally: a promise ignores repeated settles, so an
      // already-resolved (adopt succeeded, a later await threw) or
      // already-rejected (constructor / adopt-block) promise is unaffected.
      this.rejectDeploymentNamesAdopted(
        error instanceof Error ? error : new Error(errorMsg),
      );
      this.onRuntimeStartupError(new Error(errorMsg));
      throw error;
    }
  }

  private async ensureEgressBaseline(
    namespace: string,
    capabilities: K8sNetworkPolicyCapabilities,
  ): Promise<void> {
    let ensured = this.egressBaselineByNamespace.get(namespace);
    if (!ensured) {
      const networkingApi = this.k8sNetworkingApi;
      const customObjectsApi = this.k8sCustomObjectsApi;
      if (!networkingApi || !customObjectsApi) return Promise.resolve();
      const ownerReferences = this.k8sRbacApi
        ? await resolveRuntimeOwnerReferences(this.k8sRbacApi, namespace).catch(
            () => undefined,
          )
        : undefined;
      ensured = ensureEgressBaselineNetworkPolicy({
        networkingApi,
        customObjectsApi,
        namespace,
        capabilities,
        ownerReferences,
      }).then((succeeded) => {
        // Don't cache a failed attempt as done — drop it so the next deploy in
        // this namespace retries rather than leaving pods without the baseline.
        if (!succeeded) this.egressBaselineByNamespace.delete(namespace);
      });
      this.egressBaselineByNamespace.set(namespace, ensured);
    }
    return ensured;
  }

  /**
   * Re-assert every local MCP server's egress policy (baseline + per-pod floor /
   * off / restricted), policy-only — no pod redeploy. Runs at the end of start()
   * so a restart re-applies the per-pod policy to servers that were already
   * running (or whose deploy path skipped it), instead of leaving them under the
   * namespace deny-all baseline with no floor — no egress — until a manual policy
   * change. Per-server failures are logged and skipped so one server can't abort
   * the sweep.
   */
  private async reconcileEgressPolicies(params: {
    localServers: McpServer[];
    localCatalogItems: CatalogItem[];
    capabilities: K8sNetworkPolicyCapabilities;
    cache: NetworkPolicyResolutionCache;
  }): Promise<void> {
    const {
      k8sApi,
      k8sAppsApi,
      k8sRbacApi,
      k8sNetworkingApi,
      k8sCustomObjectsApi,
      k8sAttach,
      k8sLog,
      k8sExec,
    } = this;
    if (
      !k8sApi ||
      !k8sAppsApi ||
      !k8sNetworkingApi ||
      !k8sCustomObjectsApi ||
      !k8sAttach ||
      !k8sLog ||
      !k8sExec
    ) {
      return;
    }

    logger.info(
      `Reconciling egress policies for ${params.localServers.length} MCP server(s)`,
    );

    for (let i = 0; i < params.localServers.length; i++) {
      const mcpServer = params.localServers[i];
      const catalogItem = params.localCatalogItems[i];
      try {
        const namespace = await this.resolveNamespaceForCatalog(
          catalogItem,
          params.cache,
        );
        const k8sDeployment = new K8sDeployment({
          mcpServer,
          k8sApi,
          k8sAppsApi,
          k8sRbacApi,
          k8sNetworkingApi,
          k8sCustomObjectsApi,
          k8sAttach,
          k8sLog,
          k8sExec,
          namespace,
          catalogItem,
          effectiveNetworkPolicy: null,
          networkPolicyCapabilities: params.capabilities,
        });
        await McpDeploymentLeaseModel.withLeaseWhenAvailable(
          {
            scope: MCP_DEPLOYMENT_TRANSITION_LEASE_SCOPE,
            key: McpServerRuntimeManager.physicalDeploymentKey(k8sDeployment),
            timeoutMs: MCP_DEPLOYMENT_TRANSITION_DEADLINE_MS,
          },
          async (lease) => {
            await lease.assertOwned();
            k8sDeployment.setEffectiveNetworkPolicy(
              await this.resolveNetworkPolicyForDeployment({
                mcpServer,
                catalogItem,
              }),
            );
            await lease.assertOwned();
            await this.ensureEgressBaseline(namespace, params.capabilities);
            await lease.assertOwned();
            await lease.runFencedMutation(() =>
              k8sDeployment.applyK8sNetworkPolicy(),
            );
          },
        );
      } catch (err) {
        logger.warn(
          { err, mcpServerId: mcpServer.id },
          "Failed to reconcile egress policy for MCP server on startup",
        );
      }
    }
  }

  private async resolveNamespaceForCatalog(
    catalogItem:
      | Awaited<ReturnType<typeof InternalMcpCatalogModel.findById>>
      | null
      | undefined,
    cache?: NetworkPolicyResolutionCache,
  ): Promise<string> {
    if (!catalogItem) return this.namespace;
    if (!catalogItem.environmentId) {
      // Default-environment catalog (environment_id = NULL): its namespace
      // lives on the organization row, not in `environments`.
      const organization = catalogItem.organizationId
        ? (cache?.organizationsById.get(catalogItem.organizationId) ??
          (await OrganizationModel.getById(catalogItem.organizationId)))
        : await OrganizationModel.getFirst();
      return organization?.defaultEnvironmentNamespace ?? this.namespace;
    }
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
      /** Pull the current image on this rollout (refresh-image flow). */
      freshImagePull?: boolean;
      /** Existing transition owner for restart/reset/reinstall call chains. */
      transitionLease?: ClusterLeaseGuard;
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
      // A server can land in a namespace (new environment) the state
      // watchers aren't covering yet.
      this.ensureWatchedNamespace(deploymentNamespace);
      const networkPolicyCapabilities =
        options?.networkPolicyCapabilities ??
        (
          await getK8sCapabilitiesFromApi(
            this.k8sCustomObjectsApi,
            this.networkPolicyProbeSource(),
          )
        ).networkPolicy;

      const k8sDeployment = new K8sDeployment({
        mcpServer,
        k8sApi: this.k8sApi,
        k8sAppsApi: this.k8sAppsApi,
        k8sRbacApi: this.k8sRbacApi,
        k8sNetworkingApi: this.k8sNetworkingApi,
        k8sCustomObjectsApi: this.k8sCustomObjectsApi,
        k8sAttach: this.k8sAttach,
        k8sLog: this.k8sLog,
        namespace: deploymentNamespace,
        catalogItem,
        userConfigValues,
        environmentValues: effectiveEnvironmentValues,
        effectiveNetworkPolicy: null,
        networkPolicyCapabilities,
        k8sExec: this.k8sExec,
      });

      if (options?.freshImagePull) {
        k8sDeployment.requestFreshImagePull();
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        // The rollout this arms pulls fresh only on the node the pod lands
        // on; every other node's pre-pull cache still holds the old digest,
        // and a later reschedule under `IfNotPresent` would happily run it.
        this.imagePrepuller?.noteImageRefreshed(
          catalogItem?.localConfig?.dockerImage,
        );
        // SPDX-SnippetEnd
      }

      // Register the deployment BEFORE starting it
      this.mcpServerIdToDeploymentMap.set(id, k8sDeployment);
      logger.info(`Registered MCP server deployment ${id} in map`);

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

      const start = async (lease: ClusterLeaseGuard) => {
        await lease.assertOwned();
        // Resolve after lease acquisition. A policy fetched while waiting can
        // be older than a concurrent settings change and must never overwrite
        // that newer restrictive policy once this holder finally runs.
        k8sDeployment.setEffectiveNetworkPolicy(
          await this.resolveNetworkPolicyForDeployment({
            mcpServer,
            catalogItem,
          }),
        );
        await lease.assertOwned();
        // Declarative prerequisites can span several API calls. Keep them out
        // of the DB row-lock transaction; ownership is rechecked between each
        // convergent phase, while destructive/final writes fence themselves.
        await this.ensureEgressBaseline(
          deploymentNamespace,
          networkPolicyCapabilities,
        );
        await lease.assertOwned();

        if (secretData && Object.keys(secretData).length > 0) {
          await k8sDeployment.createK8sSecret(secretData);
          logger.info(
            { mcpServerId: id, secretId: mcpServer.secretId },
            "Created K8s Secret from secret manager",
          );
          await lease.assertOwned();
        }

        // Regcred passwords live on the catalog secret, not the install.
        const generatedRegcredNames =
          await k8sDeployment.createDockerRegistrySecrets(
            regcredSecretData,
            imagePullSecrets,
          );
        await lease.assertOwned();
        const resolvedImagePullSecretNames =
          K8sDeployment.collectImagePullSecretNames(
            imagePullSecrets,
            generatedRegcredNames,
          );
        await k8sDeployment.startOrCreateDeployment(
          resolvedImagePullSecretNames,
          {
            assertOwned: lease.assertOwned,
            runFencedMutation: lease.runFencedMutation,
          },
        );
        await lease.assertOwned();
      };
      if (options?.transitionLease) {
        await start(options.transitionLease);
      } else {
        await McpDeploymentLeaseModel.withLeaseWhenAvailable(
          {
            scope: MCP_DEPLOYMENT_TRANSITION_LEASE_SCOPE,
            key: McpServerRuntimeManager.physicalDeploymentKey(k8sDeployment),
            timeoutMs: MCP_DEPLOYMENT_TRANSITION_DEADLINE_MS,
          },
          start,
        );
      }
      logger.info(`Successfully started MCP server deployment ${id} (${name})`);

      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      // A just-(re)created deployment gets a full idle window. Its persisted
      // last_used_at can be arbitrarily stale (live-reproduced: a reinstalled
      // deployment was hibernated ~10 s after creation). One stamp covers
      // every sibling sharing the physical deployment: the idle checks take
      // the MAXIMUM last-used across the group, so raising one raises all —
      // and resolving the sibling list here cost a query per install on every
      // startup.
      await mcpActiveUseTracker.stampIfEnabled(id);

      // An install, a restart, or a refresh-image rollout can change which
      // images the fleet runs. Debounced and never awaited.
      this.imagePrepuller?.requestReconcile();
      // SPDX-SnippetEnd
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

    if (!k8sDeployment) return;
    const physicalKey =
      McpServerRuntimeManager.physicalDeploymentKey(k8sDeployment);

    await McpDeploymentLeaseModel.withLeaseWhenAvailable(
      {
        scope: MCP_DEPLOYMENT_TRANSITION_LEASE_SCOPE,
        key: physicalKey,
        timeoutMs: MCP_DEPLOYMENT_TRANSITION_DEADLINE_MS,
      },
      async (lease) => {
        // Multi-tenant catalogs share one K8s deployment across all callers.
        // Only the last caller out should delete shared resources.
        const sharedWithOthers =
          await McpServerRuntimeManager.isSharedMultitenantDeployment(
            mcpServerId,
          );

        if (!sharedWithOthers) {
          await lease.runFencedMutation(() =>
            k8sDeployment.stopDeployment({ uidPrecondition: true }),
          );
          await lease.runFencedMutation(() => k8sDeployment.deleteK8sService());
          await lease.runFencedMutation(() => k8sDeployment.deleteK8sSecret());
          await lease.runFencedMutation(() =>
            k8sDeployment.deleteDockerRegistrySecrets(),
          );
          await lease.runFencedMutation(() =>
            k8sDeployment.deleteK8sNetworkPolicy(),
          );
        } else {
          logger.info(
            { mcpServerId },
            "Skipping K8s deployment teardown: multi-tenant catalog still has other callers",
          );
        }

        this.mcpServerIdToDeploymentMap.delete(mcpServerId);
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        await this.notifyHibernationListeners([mcpServerId]);
        // SPDX-SnippetEnd
      },
    );
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
        k8sRbacApi: this.k8sRbacApi,
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
          await getK8sCapabilitiesFromApi(
            this.k8sCustomObjectsApi,
            this.networkPolicyProbeSource(),
          )
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
      // A lazy load is how a deployment enters THIS process (the worker never
      // runs startServer), so its namespace joins the watch set here or not at
      // all — set-guarded, and a no-op until the watchers are started.
      this.ensureWatchedNamespace(k8sDeployment.k8sNamespace);
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
        await this.removeDeploymentWithTransitionLease(deployment);
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

    try {
      await this.stopServer(mcpServerId);
      logger.info(`Successfully removed MCP server deployment ${mcpServerId}`);
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to remove MCP server deployment ${mcpServerId}:`,
      );
      throw error;
    } finally {
      this.mcpServerIdToDeploymentMap.delete(mcpServerId);
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      // Drop demand-tracking state so an uninstalled server's watermark can't
      // keep a reinstalled successor's sibling group looking active.
      mcpActiveUseTracker.remove(mcpServerId);
      // The uninstalled server may have been the last user of its image.
      this.imagePrepuller?.requestReconcile();
      // SPDX-SnippetEnd
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
  async reinstallSharedDeployment(
    catalogId: string,
    options?: {
      freshImagePull?: boolean;
      /**
       * Wait for the recreated deployment to actually serve before returning.
       * On by default. A caller that confirms readiness itself turns it off, so
       * one rebuild is never budgeted for two consecutive ready-waits.
       */
      awaitReady?: boolean;
      /** Existing transition owner, used only by the hard-reset rebuild. */
      transitionLease?: ClusterLeaseGuard;
    },
  ): Promise<void> {
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
    const k8sDeployment = await this.getOrLoadDeployment(representative.id);
    if (!k8sDeployment) {
      throw new Error(
        `Shared catalog ${catalogId} has no Kubernetes deployment to reinstall`,
      );
    }

    const reinstall = async (lease: ClusterLeaseGuard) => {
      await lease.assertOwned();

      // Stale HTTP MCP sessions for ALL installs become invalid once the
      // pod is recreated.
      for (const install of installs) {
        await McpHttpSessionModel.deleteByMcpServerId(install.id);
      }

      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await this.notifyHibernationListeners(installs.map(({ id }) => id));
      // SPDX-SnippetEnd

      // Unconditional teardown — explicitly bypasses the per-install sibling
      // guard. Declarative Service/Secret/policy objects remain and are
      // reconciled by startServer; only the Deployment needs replacement.
      await lease.runFencedMutation(() =>
        k8sDeployment.stopDeployment({ uidPrecondition: true }),
      );

      // Clear every sibling's in-memory entry — the K8s objects are gone.
      for (const install of installs) {
        this.mcpServerIdToDeploymentMap.delete(install.id);
      }

      // Match single-tenant restart cadence: brief pause before recreate.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await lease.assertOwned();

      await this.startServer(representative, undefined, undefined, {
        freshImagePull: options?.freshImagePull,
        transitionLease: lease,
      });

      if (options?.awaitReady !== false) {
        const newDeployment = await this.getOrLoadDeployment(representative.id);
        if (newDeployment) {
          await newDeployment.waitForDeploymentReady(60, 2000);
        }
      }
      await lease.assertOwned();

      logger.info(
        { catalogId, representativeId: representative.id },
        "Shared deployment reinstalled successfully",
      );
    };

    if (options?.transitionLease) {
      await reinstall(options.transitionLease);
      return;
    }
    await McpDeploymentLeaseModel.withLeaseWhenAvailable(
      {
        scope: MCP_DEPLOYMENT_TRANSITION_LEASE_SCOPE,
        key: McpServerRuntimeManager.physicalDeploymentKey(k8sDeployment),
        timeoutMs: MCP_DEPLOYMENT_TRANSITION_DEADLINE_MS,
      },
      reinstall,
    );
  }

  /**
   * Restart a single MCP server deployment
   */
  async restartServer(
    mcpServerId: string,
    options?: { freshImagePull?: boolean },
  ): Promise<void> {
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

      const k8sDeployment = await this.getOrLoadDeployment(mcpServerId);
      if (!k8sDeployment) {
        throw new Error(
          `MCP server ${mcpServerId} has no Kubernetes deployment to restart`,
        );
      }
      await McpDeploymentLeaseModel.withLeaseWhenAvailable(
        {
          scope: MCP_DEPLOYMENT_TRANSITION_LEASE_SCOPE,
          key: McpServerRuntimeManager.physicalDeploymentKey(k8sDeployment),
          timeoutMs: MCP_DEPLOYMENT_TRANSITION_DEADLINE_MS,
        },
        async (lease) => {
          // Existing HTTP sessions and pooled clients address the old pod.
          await McpHttpSessionModel.deleteByMcpServerId(mcpServerId);
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          await this.notifyHibernationListeners([mcpServerId]);
          // SPDX-SnippetEnd
          await lease.runFencedMutation(() =>
            k8sDeployment.stopDeployment({ uidPrecondition: true }),
          );
          this.mcpServerIdToDeploymentMap.delete(mcpServerId);

          await new Promise((resolve) => setTimeout(resolve, 2000));
          await lease.assertOwned();
          await this.startServer(mcpServer, undefined, undefined, {
            freshImagePull: options?.freshImagePull,
            transitionLease: lease,
          });
          await lease.assertOwned();
        },
      );

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
   * Return a wedged MCP server to a clean slate: destroy its physical
   * deployment, erase every piece of derived state this runtime holds for it,
   * and rebuild it from current configuration with a fresh image pull.
   *
   * The recovery path of last resort, for the deployment no ordinary lifecycle
   * action can move — a finalizer that never fires, a container that ignores
   * SIGTERM, a cached image that is itself the fault. Its whole purpose is that
   * an administrator can perform it without a cluster administrator, a database
   * session, or an engineer, so it escalates (force-kill) rather than give up,
   * and it always ends by redeploying.
   *
   * Only DERIVED state is erased. Stored configuration is not state: an
   * install's `hibernation_mode` is a choice an administrator made, and a
   * recovery action is not entitled to revert it.
   *
   * Single-flighted per PHYSICAL deployment — a multitenant catalog's installs
   * all alias one pod, so concurrent resets share one teardown.
   *
   * Returns once the reset is under way and its target is known; the report of
   * what it did arrives on {@link McpServerHardReset.completion}, which outlives
   * whatever request asked for the reset.
   */
  async hardResetDeployment(mcpServerId: string): Promise<McpServerHardReset> {
    if (!this.isEnabled) {
      throw new Error(
        "Kubernetes runtime is not available; cannot hard-reset a deployment",
      );
    }

    const joinedPhysicalKey =
      this.hardResetPhysicalKeyByServerId.get(mcpServerId);
    const joinedInFlight = joinedPhysicalKey
      ? this.hardResetInFlightByPhysicalKey.get(joinedPhysicalKey)
      : undefined;
    if (joinedPhysicalKey && joinedInFlight) {
      const started = await joinedInFlight.started;
      return {
        mcpServerId,
        physicalDeployment: joinedPhysicalKey,
        resetServerIds: started.resetServerIds,
        reportsOutcome: false,
        getStatusMarker: started.getStatusMarker,
        acknowledgePending: joinedInFlight.acknowledgePending,
        runFencedStatusWrite: joinedInFlight.runFencedStatusWrite,
        acknowledgeReporting: joinedInFlight.acknowledgeReporting,
        completion: joinedInFlight.completion.then((outcome) => ({
          ...outcome,
          mcpServerId,
        })),
      };
    }
    if (joinedPhysicalKey) {
      this.hardResetPhysicalKeyByServerId.delete(mcpServerId);
    }

    const mcpServer = await McpServerModel.findById(mcpServerId);
    if (!mcpServer) {
      throw new Error(`MCP server with id ${mcpServerId} not found`);
    }

    const deployment = await this.getOrLoadDeployment(mcpServerId);
    if (!deployment) {
      throw new Error(
        `MCP server ${mcpServerId} has no Kubernetes deployment to reset`,
      );
    }

    const physicalKey =
      McpServerRuntimeManager.physicalDeploymentKey(deployment);
    let inFlight = this.hardResetInFlightByPhysicalKey.get(physicalKey);
    const reportsOutcome = !inFlight;
    if (!inFlight) {
      let resolveStarted!: (started: McpServerHardResetStart) => void;
      let rejectStarted!: (error: unknown) => void;
      const started = new Promise<McpServerHardResetStart>(
        (resolve, reject) => {
          resolveStarted = resolve;
          rejectStarted = reject;
        },
      );
      let statusWriteFence: ClusterLeaseGuard["runFencedMutation"] | undefined;
      let currentStatusMarker: string | undefined;
      const getStatusMarker = () => {
        if (!currentStatusMarker) {
          throw new Error("Hard reset status marker was not initialized");
        }
        return currentStatusMarker;
      };
      const runFencedStatusWrite: ClusterLeaseGuard["runFencedMutation"] =
        async (fn) => {
          await started;
          if (!statusWriteFence) {
            throw new Error("Hard reset status fence was not initialized");
          }
          return statusWriteFence(fn);
        };
      let resolveCompletion!: (result: McpServerHardResetResult) => void;
      let rejectCompletion!: (error: unknown) => void;
      const completion = new Promise<McpServerHardResetResult>(
        (resolve, reject) => {
          resolveCompletion = resolve;
          rejectCompletion = reject;
        },
      );
      let releasePending!: () => void;
      let rejectPending!: (error: unknown) => void;
      const pendingAcknowledged = new Promise<void>((resolve, reject) => {
        releasePending = resolve;
        rejectPending = reject;
      });
      let pendingWasAcknowledged = false;
      const acknowledgePending = (error?: unknown) => {
        if (pendingWasAcknowledged) return;
        pendingWasAcknowledged = true;
        if (error === undefined) releasePending();
        else rejectPending(error);
      };
      let releaseReporting!: () => void;
      const reportingFinished = new Promise<void>((resolve) => {
        releaseReporting = resolve;
      });
      let reportingAcknowledged = false;
      const acknowledgeReporting = () => {
        if (reportingAcknowledged) return;
        reportingAcknowledged = true;
        releaseReporting();
      };
      let startedResolved = false;
      let completionSettled = false;
      let knownResetServerIds: string[] = [];
      let entry!: McpServerHardResetInFlight;

      const leasedOperation = McpDeploymentLeaseModel.withLease(
        { scope: HARD_RESET_LEASE_SCOPE, key: physicalKey },
        async (lease) => {
          statusWriteFence = lease.runFencedMutation;
          // Resolve the blast radius only after this replica owns the hard-reset
          // lease. The same set describes pending status and the actual reset.
          const resetServerIds =
            await this.resolveSiblingServerIds(mcpServerId);

          try {
            return await McpDeploymentLeaseModel.withLeaseWhenAvailable(
              {
                scope: MCP_DEPLOYMENT_TRANSITION_LEASE_SCOPE,
                key: physicalKey,
                timeoutMs: HARD_RESET_TRANSITION_ACQUIRE_TIMEOUT_MS,
              },
              async (transitionLease) => {
                // Capture the exact deployment this reset owns only after the
                // transition lease excludes restart/wake/reinstall writers.
                // Reconciliation can then require a different UID before it
                // calls an interrupted reset successful.
                const originalDeployment =
                  await deployment.readLiveDeployment();
                const statusMarker = createHardResetStatusMarker({
                  physicalDeployment: physicalKey,
                  originalDeploymentUid: originalDeployment
                    ? originalDeployment.metadata?.uid
                    : null,
                });
                currentStatusMarker = statusMarker;
                knownResetServerIds = resetServerIds;
                for (const serverId of resetServerIds) {
                  this.hardResetPhysicalKeyByServerId.set(
                    serverId,
                    physicalKey,
                  );
                }
                startedResolved = true;
                resolveStarted({ resetServerIds, getStatusMarker });
                // No destructive write starts before the initiating request
                // has put every affected install into its in-progress state.
                await pendingAcknowledged;

                try {
                  const result = await this.runHardReset({
                    mcpServer,
                    deployment,
                    leases: [lease, transitionLease],
                    physicalKey,
                    resetServerIds,
                    getStatusMarker,
                    setStatusMarker: (marker) => {
                      currentStatusMarker = marker;
                    },
                  });
                  completionSettled = true;
                  resolveCompletion(result);
                  await reportingFinished;
                  return result;
                } catch (error) {
                  completionSettled = true;
                  rejectCompletion(error);
                  await reportingFinished;
                  throw error;
                }
              },
            );
          } catch (error) {
            if (!completionSettled) {
              completionSettled = true;
              rejectCompletion(error);
              if (startedResolved) await reportingFinished;
            }
            throw error;
          }
        },
      )
        .catch(async (error) => {
          let mapped = error;
          if (
            !startedResolved &&
            !statusWriteFence &&
            error instanceof ClusterLeaseHeldError
          ) {
            let remoteResetServerIds = [mcpServerId];
            try {
              remoteResetServerIds =
                await this.resolveSiblingServerIds(mcpServerId);
            } catch {
              // Informational only: the owning replica already has the strict
              // set and reports every status. Never turn an active reset into
              // a failed request because this observer could not resolve it.
            }
            mapped = new McpServerHardResetHeldElsewhereError(
              physicalKey,
              remoteResetServerIds,
            );
          }
          if (!startedResolved) rejectStarted(mapped);
          if (!completionSettled) rejectCompletion(mapped);
          // No reporting owner exists when startup itself failed.
          if (!startedResolved) {
            acknowledgePending();
            acknowledgeReporting();
          }
          throw mapped;
        })
        .finally(() => {
          if (this.hardResetInFlightByPhysicalKey.get(physicalKey) === entry) {
            this.hardResetInFlightByPhysicalKey.delete(physicalKey);
          }
          for (const serverId of knownResetServerIds) {
            if (
              this.hardResetPhysicalKeyByServerId.get(serverId) === physicalKey
            ) {
              this.hardResetPhysicalKeyByServerId.delete(serverId);
            }
          }
        });
      // Observe both internal promises if acquisition fails before a handle is
      // returned. The caller still receives the startup rejection below.
      leasedOperation.catch(() => {});
      completion.catch(() => {});
      entry = {
        started,
        completion,
        acknowledgePending,
        runFencedStatusWrite,
        acknowledgeReporting,
      };
      inFlight = entry;
      this.hardResetInFlightByPhysicalKey.set(physicalKey, inFlight);
    }

    const started = await inFlight.started;
    const reset = inFlight.completion;

    return {
      mcpServerId,
      physicalDeployment: physicalKey,
      resetServerIds: started.resetServerIds,
      reportsOutcome,
      getStatusMarker: started.getStatusMarker,
      acknowledgePending: inFlight.acknowledgePending,
      runFencedStatusWrite: inFlight.runFencedStatusWrite,
      acknowledgeReporting: inFlight.acknowledgeReporting,
      // A joining caller shares the teardown, not the identity of whoever
      // started it: on a multitenant catalog the in-flight reset was very
      // likely asked for by a DIFFERENT install, and handing its result back
      // verbatim would report on a server this caller never named. Everything
      // else in the result describes the one physical deployment and is true
      // for both.
      completion: reset.then((outcome) =>
        outcome.mcpServerId === mcpServerId
          ? outcome
          : { ...outcome, mcpServerId },
      ),
    };
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * Ensure the physical deployment backing an MCP server is awake before a
   * demand-path call reaches it.
   *
   * Fast path (no K8s API call): runtime disabled, server unknown/not local, or
   * hibernation is not offered and the loaded deployment has a serving cached
   * state. While hibernation is offered, even cached "running" is validated
   * against cluster truth because another replica may have scaled it to zero.
   * Cached "waking" always takes the slow path: a wake this process did not
   * start has no in-flight promise to join and must still be resumable.
   *
   * Slow path: wait for any cluster-wide hibernation transition, then
   * single-flight per physical deployment — refresh cluster truth, scale up if
   * hibernated (or resume a half-woken deployment), wait for readiness, clear
   * the hibernation annotation, and mark every loaded sibling alias running.
   * Throws {@link McpServerWakeError} when the wait budget elapses; the wake
   * keeps progressing in the cluster and a later call resumes it.
   *
   * A hard reset owning this deployment pre-empts both paths: there is nothing
   * to wake while the Deployment is being destroyed and rebuilt.
   */
  async ensureAwake(mcpServerId: string): Promise<void> {
    if (!this.isEnabled) return;

    // A shared reset may know this sibling even when its deployment is not in
    // the runtime cache. Reject before loading it: the reset's fenced K8s write
    // can legitimately hold the lease transaction while demand arrives.
    const hardResetPhysicalKey =
      this.hardResetPhysicalKeyByServerId.get(mcpServerId);
    if (
      hardResetPhysicalKey &&
      this.hardResetInFlightByPhysicalKey.has(hardResetPhysicalKey)
    ) {
      throw new McpServerHardResetInProgressError(
        hardResetPhysicalKey.slice(hardResetPhysicalKey.indexOf("/") + 1),
      );
    }

    // During a rolling config change, another replica may still be sweeping.
    // Unknown is therefore conservative: the sync accessor starts hydration,
    // and only a known-false org toggle plus local-off config restores the
    // zero-cost cache fast path.
    const hibernationMayExist =
      isIdleHibernationOffered() ||
      OrganizationModel.getMcpIdleHibernationEnabledSync() !== false;

    const loaded = this.mcpServerIdToDeploymentMap.get(mcpServerId);
    if (loaded) {
      this.assertNotHardResetting(loaded);
      // A wake already in flight for this physical deployment: join it even
      // though beginWake has moved the cached state past "hibernated".
      const inFlight = this.wakeInFlightByPhysicalKey.get(
        McpServerRuntimeManager.physicalDeploymentKey(loaded),
      );
      if (inFlight) return inFlight;
      const cachedState = loaded.statusSummary.state;
      // "not_created" is a cache-cold alias, not a claim about the cluster.
      // Fall through and let wakeDeployment read cluster truth — treating it
      // as awake here made a cross-replica hibernation a permanent no-op.
      //
      // "failed" is distrusted for the mirror-image reason: it is the one
      // cached state that says the deployment CANNOT serve, so short-circuiting
      // on it returned "awake" for a server whose pod is broken and left the
      // caller to discover that as a transport timeout. It is also the state a
      // wake leaves behind when it aborts, which made every later call skip the
      // wake entirely. wakeDeployment re-reads the cluster and either finds it
      // recovered or raises the deployment's own failure.
      if (
        cachedState !== "hibernated" &&
        cachedState !== "waking" &&
        cachedState !== "not_created" &&
        cachedState !== "failed"
      ) {
        // Without hibernation this remains the zero-cost hot path. Once the
        // operator offers scale-to-zero, another replica can have hibernated
        // this deployment while our watch/cache still says running; validate
        // cluster truth below before dispatch.
        if (!hibernationMayExist) return;
      }
    }

    // Cached "hibernated"/"waking"/"not_created", or state unknown (deployment
    // not loaded — e.g. hibernated by another replica): resolve the deployment
    // and share one wake per physical deployment.
    const deployment = loaded ?? (await this.getOrLoadDeployment(mcpServerId));
    if (!deployment) return; // remote/unknown server, or runtime can't load it

    // Re-checked on the alias we just resolved: a reset may have started while
    // the lookup above ran, and a cache-cold caller reaches this line without
    // ever having passed the check at the top.
    this.assertNotHardResetting(deployment);

    const key = McpServerRuntimeManager.physicalDeploymentKey(deployment);
    // Explicit demand means this deployment is ours to wake again. If another
    // controller still owns replicas, repeated external resumes will prove it
    // again after the next sleep; stale process-local suppression must not
    // permanently disable hibernation after legitimate use.
    this.foreignReplicaOwners.delete(key);
    this.foreignResumeCountByPhysicalKey.delete(key);
    this.foreignResumeCooldownTicks.delete(key);
    // We are waking it, so its next "running" is ours and must not be read as
    // another controller restoring the replica count.
    this.hibernatedByUsAtByPhysicalKey.delete(key);
    let wake = this.wakeInFlightByPhysicalKey.get(key);
    if (!wake) {
      // The deadline is the self-heal catch-all: if an attempt never settles
      // (a hung Kubernetes call, an unhandled corner), every waiter is
      // released with a retryable error and the slot frees, so the next
      // demand starts a fresh attempt instead of queueing behind a wedge.
      // The abandoned attempt stays harmless: its writes are CAS-guarded.
      const wakeDeployment = (lease?: ClusterLeaseGuard) =>
        this.wakeDeployment(mcpServerId, deployment, lease);
      const deadlineAt = Date.now() + MCP_DEPLOYMENT_TRANSITION_DEADLINE_MS;
      const makeDeadlineError = () =>
        new McpServerWakeError(deployment.statusSummary.serverName, {
          detail: "the wake attempt did not settle within its deadline",
        });
      const transition = hibernationMayExist
        ? McpDeploymentLeaseModel.withLeaseWhenAvailable(
            {
              scope: MCP_DEPLOYMENT_TRANSITION_LEASE_SCOPE,
              key,
              timeoutMs: MCP_DEPLOYMENT_TRANSITION_DEADLINE_MS,
            },
            async (lease) => {
              lease.throwIfLost();
              await lease.runFencedMutation(() =>
                deployment.clearForeignReplicaOwner(),
              );
              await lease.assertOwned();
              await withDeadline(
                wakeDeployment(lease),
                Math.max(1, deadlineAt - Date.now()),
                makeDeadlineError,
              );
              await lease.assertOwned();
            },
          ).catch((error) => {
            if (error instanceof ClusterLeaseHeldError) {
              throw new McpServerWakeError(
                deployment.statusSummary.serverName,
                {
                  cause: error,
                  detail:
                    "another replica did not finish the deployment's lifecycle transition in time",
                },
              );
            }
            throw error;
          })
        : withDeadline(
            wakeDeployment(),
            MCP_DEPLOYMENT_TRANSITION_DEADLINE_MS,
            makeDeadlineError,
          );
      wake = transition.finally(() => {
        this.wakeInFlightByPhysicalKey.delete(key);
      });
      this.wakeInFlightByPhysicalKey.set(key, wake);
    }
    return wake;
  }

  /**
   * Whether this process has SEEN the deployment behind this server stop
   * serving: hibernated, or scaled back up and not ready yet. Memory-only
   * (never a K8s call); background paths use it to skip servers they must not
   * wake or connect to.
   *
   * Only states a lifecycle transition actually produces count as an answer.
   * "not_created" is not one of them — it is where every K8sDeployment starts,
   * before a cluster refresh classifies it. So an unobserved deployment is
   * reported as NOT dormant rather than guessing from absent cache state.
   *
   * Future-hibernation gates do not erase observed state. An administrator can
   * disable the feature while deployments are still asleep; passive discovery
   * must keep skipping those deployments until demand wakes them.
   */
  isDeploymentDormant(mcpServerId: string): boolean {
    if (!this.isEnabled) return false;
    const deployment = this.mcpServerIdToDeploymentMap.get(mcpServerId);
    if (!deployment) return false;
    const { state } = deployment.statusSummary;
    return state === "hibernated" || state === "waking";
  }

  /**
   * Run passive discovery only while a local deployment is confirmed serving.
   * Unlike ensureAwake this never scales a deployment up. Holding the
   * transition lease through client creation and the request prevents a sweep
   * from deleting sessions underneath a background read.
   */
  async runIfDeploymentServing<T>(
    mcpServerId: string,
    operation: () => Promise<T>,
  ): Promise<{ ran: false } | { ran: true; value: T }> {
    if (!this.isEnabled) return { ran: true, value: await operation() };
    const deployment = await this.getOrLoadDeployment(mcpServerId);
    if (!deployment) return { ran: true, value: await operation() };

    const hibernationMayExist =
      isIdleHibernationOffered() ||
      OrganizationModel.getMcpIdleHibernationEnabledSync() !== false;
    if (!hibernationMayExist) {
      return { ran: true, value: await operation() };
    }

    const key = McpServerRuntimeManager.physicalDeploymentKey(deployment);
    try {
      return await McpDeploymentLeaseModel.withLease(
        { scope: MCP_DEPLOYMENT_TRANSITION_LEASE_SCOPE, key },
        async (lease) => {
          await deployment.refreshState({
            runFencedMutation: lease.runFencedMutation,
          });
          let state = deployment.statusSummary.state;
          if (state === "not_created") {
            const live = await deployment.readLiveDeployment();
            if (
              !live ||
              (live.spec?.replicas ?? 0) < 1 ||
              K8sDeployment.hasHibernationAnnotation(live)
            ) {
              return { ran: false } as const;
            }
            state = "running";
          }
          if (state !== "running") return { ran: false } as const;

          lease.throwIfLost();
          const value = await operation();
          await lease.assertOwned();
          return { ran: true, value } as const;
        },
      );
    } catch (error) {
      if (error instanceof ClusterLeaseHeldError) return { ran: false };
      throw error;
    }
  }
  // SPDX-SnippetEnd

  /**
   * Whether this install still resolves to something the runtime can build a
   * deployment object for: a live mcp_server row on a local catalog entry, with
   * the K8s clients to act on it. Callers use it to refuse a destructive action
   * BEFORE they have mutated anything of their own.
   *
   * Local configuration only — it deliberately does NOT read the cluster. A
   * missing Deployment is not a reason to refuse a hard reset; it is one of the
   * things a hard reset repairs. What it does catch is an install with nothing
   * to act on at all: a row whose catalog entry has since been pointed at a
   * remote server, or whose catalog is gone.
   * @public — the hard-reset route's precondition check
   */
  async hasResolvableDeployment(mcpServerId: string): Promise<boolean> {
    if (!this.isEnabled) return false;
    return Boolean(await this.getOrLoadDeployment(mcpServerId));
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * Register a callback fired (awaited) after a successful hibernate with the
   * ids of EVERY sibling install sharing the hibernated deployment. mcp-client
   * registers here at module setup to invalidate its pooled connections; the
   * registry direction avoids a manager→mcp-client import cycle.
   */
  registerHibernationListener(
    listener: (mcpServerIds: string[]) => Promise<void> | void,
  ): void {
    this.hibernationListeners.add(listener);
  }
  // SPDX-SnippetEnd

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
  async refreshAllStates(options?: {
    ensureFreshAfterInFlight?: boolean;
  }): Promise<void> {
    // Single-flight: refreshState mutates per-deployment state and is not
    // concurrency-safe, so concurrent triggers (status polling, watch
    // events) coalesce onto the in-flight sweep.
    if (this.refreshAllStatesInFlight) {
      if (options?.ensureFreshAfterInFlight) {
        this.refreshAllStatesFollowUpRequested = true;
      }
      return this.refreshAllStatesInFlight;
    }
    this.refreshAllStatesInFlight = (async () => {
      do {
        this.refreshAllStatesFollowUpRequested = false;
        const deployments = Array.from(
          this.mcpServerIdToDeploymentMap.entries(),
        );
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        const replacedPhysicalDeployments = new Set<string>();
        // SPDX-SnippetEnd
        await mapWithConcurrency(
          // Bounded: each refresh makes several K8s API calls — unbounded
          // parallelism across a large install base is a steady source of API
          // Priority & Fairness throttling (429s).
          deployments,
          K8S_API_FANOUT_CONCURRENCY,
          async ([, deployment]) => {
            // SPDX-SnippetBegin
            // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
            // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
            const before = deployment.statusSummary;
            // SPDX-SnippetEnd
            await deployment.refreshState();
            // SPDX-SnippetBegin
            // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
            // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
            const after = deployment.statusSummary;
            if (
              (before.podName && before.podName !== after.podName) ||
              (before.state === "running" && after.state !== "running")
            ) {
              replacedPhysicalDeployments.add(
                McpServerRuntimeManager.physicalDeploymentKey(deployment),
              );
            }
            // SPDX-SnippetEnd
          },
        ).catch(() => {});
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        if (replacedPhysicalDeployments.size > 0) {
          const invalidatedServerIds = deployments
            .filter(([, deployment]) =>
              replacedPhysicalDeployments.has(
                McpServerRuntimeManager.physicalDeploymentKey(deployment),
              ),
            )
            .map(([mcpServerId]) => mcpServerId);
          await this.notifyHibernationListeners(invalidatedServerIds);
        }
        // SPDX-SnippetEnd
      } while (this.refreshAllStatesFollowUpRequested);
    })();
    try {
      await this.refreshAllStatesInFlight;
    } finally {
      this.refreshAllStatesInFlight = undefined;
      if (this.refreshAllStatesFollowUpRequested) {
        await this.refreshAllStates(options);
      }
    }
  }

  /**
   * Subscribe to deployment-state refreshes triggered by K8s watch events.
   * Fired after a watch-triggered refreshAllStates() sweep completes, so
   * listeners (the websocket status push) can fan the fresh statusSummary out
   * to clients immediately instead of waiting for their next poll tick.
   * Returns an unsubscribe function.
   */
  onDeploymentStatesRefreshed(listener: () => void): () => void {
    this.stateRefreshListeners.add(listener);
    return () => {
      this.stateRefreshListeners.delete(listener);
    };
  }

  /**
   * Whether every expected deployment-state watch stream is currently open.
   * When true, cluster changes push state refreshes and pollers only need a
   * slow resync; when false (e.g. missing `watch` RBAC, connectivity loss),
   * pollers should fall back to their fast interval.
   */
  get deploymentStateWatchersActive(): boolean {
    if (!this.deploymentStateWatchersStarted) return false;
    if (this.expectedWatchStreams.size === 0) return false;
    for (const key of this.expectedWatchStreams) {
      if (!this.liveWatchStreams.has(key)) return false;
    }
    return true;
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

    this.stopDeploymentStateWatchers();

    if (this.failedPodReapTimer) {
      clearInterval(this.failedPodReapTimer);
      this.failedPodReapTimer = undefined;
    }

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    if (this.idleHibernationSweepTimer) {
      clearInterval(this.idleHibernationSweepTimer);
      this.idleHibernationSweepTimer = undefined;
    }
    mcpActiveUseTracker.stop();
    this.imagePrepuller?.stop();
    this.imagePrepuller = undefined;
    this.wakeInFlightByPhysicalKey.clear();
    // SPDX-SnippetEnd
    this.hardResetInFlightByPhysicalKey.clear();
    if (this.hardResetStatusReconcileTimer) {
      clearInterval(this.hardResetStatusReconcileTimer);
      this.hardResetStatusReconcileTimer = undefined;
    }
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    this.hibernatedByUsAtByPhysicalKey.clear();
    this.foreignResumeCountByPhysicalKey.clear();
    this.foreignResumeCooldownTicks.clear();
    this.foreignReplicaOwners.clear();
    // SPDX-SnippetEnd

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
   * One-shot startup pass that freezes each local install's K8s deployment
   * name into the DB. The live cluster is the source of truth: a row whose
   * DB name diverged from its running deployment (renamed via API before the
   * upgrade, never reinstalled) adopts the deployment's ACTUAL name, so
   * nothing churns — recomputing from the DB name is only safe for rows with
   * no live deployment at all.
   *
   * Multitenant catalogs share one deployment per catalog (the
   * `mcp-server-id` label carries the catalog id there — see
   * `getPodSelectorServerId`), so their name freezes onto the catalog row.
   *
   * Idempotent (already-frozen rows are skipped). Errors propagate — the
   * caller treats them as fatal to start().
   */
  private async adoptDeploymentNames(params: {
    localServers: McpServer[];
    localCatalogItems: CatalogItem[];
  }): Promise<void> {
    const { localServers, localCatalogItems } = params;
    if (!this.k8sAppsApi) {
      throw new Error("Kubernetes API client not initialized");
    }

    // List every namespace local catalogs deploy into (platform + per-environment),
    // then group live deployments by their selector identity label (server id
    // single-tenant, catalog id multitenant).
    const namespaces = await this.namespacesForLocalCatalogs(localCatalogItems);
    const deploymentsBySelectorId =
      await this.listMcpDeploymentsGroupedBySelectorId(namespaces);

    // Duplicate deployments for one id are the historical orphan bug itself.
    // Prefer the one matching the legacy recompute (the row's current name
    // still points at it); otherwise adopt the newest. Losers stay
    // name-mismatched against the frozen name and the orphan sweep deletes
    // them.
    const pickLiveName = (
      selectorId: string,
      legacyRecompute: string,
    ): string | null => {
      const candidates = deploymentsBySelectorId.get(selectorId);
      if (!candidates || candidates.length === 0) return null;
      const legacyMatch = candidates.find(
        (d) => d.metadata?.name === legacyRecompute,
      );
      if (legacyMatch) return legacyMatch.metadata?.name ?? null;
      const newest = [...candidates].sort(
        (a, b) =>
          (b.metadata?.creationTimestamp?.getTime() ?? 0) -
          (a.metadata?.creationTimestamp?.getTime() ?? 0),
      )[0];
      return newest.metadata?.name ?? null;
    };

    let adopted = 0;
    let recomputed = 0;
    const frozenByCatalogId = new Map<string, string>();

    for (let i = 0; i < localServers.length; i++) {
      const server = localServers[i];
      const catalog = localCatalogItems[i];

      if (catalog?.multitenant && server.catalogId) {
        // Shared deployment — freeze on the catalog row, once per catalog.
        if (catalog.deploymentName || frozenByCatalogId.has(catalog.id)) {
          continue;
        }
        const legacyRecompute = K8sDeployment.constructDeploymentName(
          server,
          catalog,
        );
        const liveName = pickLiveName(catalog.id, legacyRecompute);
        const frozen = liveName ?? legacyRecompute;
        await InternalMcpCatalogModel.setDeploymentName({
          id: catalog.id,
          deploymentName: frozen,
        });
        frozenByCatalogId.set(catalog.id, frozen);
        if (liveName) adopted++;
        else recomputed++;
        continue;
      }

      if (server.deploymentName) continue;
      const legacyRecompute = K8sDeployment.constructDeploymentName(
        server,
        catalog,
      );
      const liveName = pickLiveName(server.id, legacyRecompute);
      const frozen = liveName ?? legacyRecompute;
      await McpServerModel.setDeploymentName({
        id: server.id,
        deploymentName: frozen,
      });
      // Mutate in place — the same row objects feed startServer, the egress
      // reconcile, and the orphan sweep this startup.
      server.deploymentName = frozen;
      if (liveName) adopted++;
      else recomputed++;
    }

    // start() fetches a separate catalog object per install, so every copy of
    // a just-frozen multitenant catalog must be updated — not only the one
    // that happened to trigger the freeze.
    if (frozenByCatalogId.size > 0) {
      for (const catalog of localCatalogItems) {
        if (!catalog) continue;
        const frozen = frozenByCatalogId.get(catalog.id);
        if (frozen && !catalog.deploymentName) {
          catalog.deploymentName = frozen;
        }
      }
    }

    if (adopted > 0 || recomputed > 0) {
      logger.info(
        { adopted, recomputed },
        "Froze MCP deployment names (adopted from live cluster / recomputed for rows with no deployment)",
      );
    }
  }

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
      const namespaces = await this.namespacesForInstalledLocalServers(
        installedServers,
        getCatalog,
      );

      for (const deploymentNamespace of namespaces) {
        const deployments = await this.k8sAppsApi.listNamespacedDeployment({
          namespace: deploymentNamespace,
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

          // Relocation sweep: the deployment lives in a namespace the catalog
          // no longer resolves to (e.g. an upgrade taught the resolver about
          // the default environment's namespace, or a namespace change landed
          // while the platform was down). The startup startServer pass has
          // already (re)created the deployment in the resolved namespace, so
          // this copy is a stale duplicate — tear it down fully (deployment,
          // service, secrets, network policy) in its own namespace.
          const expectedNamespace =
            await this.resolveNamespaceForCatalog(catalog);
          if (deploymentNamespace !== expectedNamespace) {
            logger.info(
              {
                deploymentName,
                serverId,
                deploymentNamespace,
                expectedNamespace,
              },
              "Removing MCP deployment left behind in a stale namespace",
            );
            try {
              // Full teardown (deployment, service, secrets, network policy)
              // of the row's constructed-name resources in the stale namespace.
              const staleDeployment = await this.getOrLoadDeployment(
                server.id,
                { namespaceOverride: deploymentNamespace },
              );
              if (staleDeployment) {
                await this.removeDeploymentWithTransitionLease(staleDeployment);
              }
              // The live object can carry a diverged (legacy) name the
              // constructed-name teardown above missed. In a non-resolved
              // namespace ANY deployment labeled with this server id is stale
              // by definition, so deleting by its live name is safe.
              if (
                deploymentName !==
                K8sDeployment.constructDeploymentName(server, catalog)
              ) {
                await this.k8sAppsApi.deleteNamespacedDeployment({
                  name: deploymentName,
                  namespace: deploymentNamespace,
                });
                await this.k8sApi
                  .deleteNamespacedService({
                    name: `${deploymentName}-service`,
                    namespace: deploymentNamespace,
                  })
                  .catch(() => {});
              }
            } catch (err) {
              logger.warn(
                { err, deploymentName, deploymentNamespace },
                "Failed to remove MCP deployment from stale namespace",
              );
            }
            continue;
          }

          // Only ever compare against a FROZEN name. The adopt pass runs
          // before this sweep and freezes every local single-tenant row, so
          // NULL here means the expected name can't be proven — never delete
          // on a recomputed guess.
          if (!server.deploymentName) continue;

          const expectedName = K8sDeployment.constructDeploymentName(
            server,
            catalog,
          );

          if (deploymentName === expectedName) continue;

          logger.info(
            { deploymentName, expectedName, serverId, deploymentNamespace },
            "Deleting orphaned MCP deployment with stale name",
          );

          try {
            await this.k8sAppsApi.deleteNamespacedDeployment({
              name: deploymentName,
              namespace: deploymentNamespace,
            });
          } catch (err) {
            logger.warn(
              { err, deploymentName, deploymentNamespace },
              "Failed to delete orphaned MCP deployment",
            );
          }

          try {
            await this.k8sApi.deleteNamespacedService({
              name: `${deploymentName}-service`,
              namespace: deploymentNamespace,
            });
          } catch (err) {
            logger.debug(
              { err, deploymentName, deploymentNamespace },
              "No orphaned service to delete (or already gone)",
            );
          }
        }
      }
    } catch (error) {
      logger.warn({ err: error }, "Failed to sweep orphaned MCP deployments");
    }
  }

  /**
   * Start the periodic sweep of Failed/Evicted MCP server pods.
   *
   * A node under DiskPressure evicts MCP pods and then rejects their
   * replacements, leaving a `Failed` pod corpse behind on every attempt.
   * Nothing in Kubernetes cleans these up for Deployment-owned pods, so a
   * single transient DiskPressure event can accumulate hundreds of dead pods.
   * This reaper deletes Failed pods carrying the `app=mcp-server` label in
   * every namespace the platform deploys MCP servers into.
   */
  private startFailedPodReaper(): void {
    if (this.failedPodReapTimer) {
      clearInterval(this.failedPodReapTimer);
      this.failedPodReapTimer = undefined;
    }

    const intervalSeconds = config.orchestrator.failedPodReapIntervalSeconds;
    if (intervalSeconds <= 0) {
      logger.info("Failed MCP pod reaper is disabled");
      return;
    }

    const sweep = () => {
      this.reapFailedMcpPods().catch((err) => {
        logger.warn({ err }, "Failed to reap Failed/Evicted MCP pods");
      });
    };

    // Sweep once at startup to clear any backlog, then periodically.
    sweep();
    this.failedPodReapTimer = setInterval(sweep, intervalSeconds * 1000);
    // Don't keep the process alive just for the reaper
    this.failedPodReapTimer.unref?.();
  }

  private async reapFailedMcpPods(): Promise<void> {
    if (!this.k8sApi) return;

    const namespaces = uniqueStrings([
      this.namespace,
      ...config.orchestrator.kubernetes.environmentNamespaces,
    ]);

    for (const namespace of namespaces) {
      try {
        const pods = await this.k8sApi.listNamespacedPod({
          namespace,
          labelSelector: "app=mcp-server",
          fieldSelector: "status.phase=Failed",
        });

        let deletedCount = 0;
        for (const pod of pods.items) {
          const podName = pod.metadata?.name;
          if (!podName) continue;

          try {
            await this.k8sApi.deleteNamespacedPod({
              name: podName,
              namespace,
            });
            deletedCount++;
          } catch (err) {
            logger.debug(
              { err, podName, namespace },
              "Failed to delete Failed MCP pod (may already be gone)",
            );
          }
        }

        if (deletedCount > 0) {
          logger.info(
            { namespace, deletedCount },
            "Reaped Failed/Evicted MCP server pods",
          );
        }
      } catch (err) {
        logger.warn(
          { err, namespace },
          "Failed to list Failed MCP pods for reaping",
        );
      }
    }
  }

  // === Idle hibernation ===

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * Start the periodic idle-hibernation sweep. The timer runs whenever the
   * operator has not hard-disabled the feature — whether hibernation is
   * licensed and switched on for the organization is decided per TICK, since
   * an administrator can flip the toggle while the process is up.
   *
   * Half the idle window keeps the worst-case over-idle time at ~1.5× the
   * window, capped at 60 s so large windows still notice idleness promptly.
   * No immediate sweep: nothing can be past the idle window right at startup.
   */
  private startIdleHibernationSweeper(): void {
    if (this.idleHibernationSweepTimer) {
      clearInterval(this.idleHibernationSweepTimer);
      this.idleHibernationSweepTimer = undefined;
    }
    mcpActiveUseTracker.stop();
    // Demand protection must outlive local rollout skew: another replica can
    // still be sweeping even when this one has the feature disabled.
    mcpActiveUseTracker.start();

    if (!isIdleHibernationOffered()) {
      logger.info("MCP idle hibernation is disabled by configuration");
      return;
    }

    const windowSeconds = idleHibernationWindowSeconds();

    this.idleHibernationSweepTimer = setInterval(
      () => {
        // Skip the tick while the previous sweep (DB reads + K8s patch
        // fan-out) is still running.
        if (this.idleHibernationSweepInFlight) return;
        // Deadline as the self-heal catch-all: a sweep that never settles
        // would hold this guard and silently stop hibernation platform-wide
        // until a restart. Releasing the guard lets the next tick retry; the
        // abandoned sweep's patches stay CAS-guarded.
        this.idleHibernationSweepInFlight = withDeadline(
          this.sweepIdleDeployments(),
          SWEEP_DEADLINE_MS,
          () =>
            new Error(
              "the sweep did not settle within its deadline; releasing the in-flight guard",
            ),
        )
          .catch((err) => {
            logger.warn({ err }, "MCP idle-hibernation sweep failed");
          })
          .finally(() => {
            this.idleHibernationSweepInFlight = undefined;
          });
      },
      Math.min(windowSeconds / 2, 60) * 1000,
    );
    // Don't keep the process alive just for the sweeper
    this.idleHibernationSweepTimer.unref?.();
  }

  /**
   * One sweep of the idle-hibernation lifecycle. The manager owns the
   * deployment cache and the sibling bookkeeping; WHEN a group may sleep is
   * decided in the enterprise hibernation module.
   */
  private async sweepIdleDeployments(): Promise<void> {
    if (!this.isEnabled) return;
    await sweepIdleDeployments(this.hibernationHost);
  }
  // SPDX-SnippetEnd

  /**
   * Perform the actual hard reset for {@link hardResetDeployment}
   * (single-flighted per physical deployment by the caller).
   */
  private async runHardReset(params: {
    mcpServer: McpServer;
    deployment: K8sDeployment;
    leases: ClusterLeaseGuard[];
    physicalKey: string;
    resetServerIds: string[];
    getStatusMarker: () => string;
    setStatusMarker: (marker: string) => void;
  }): Promise<McpServerHardResetResult> {
    const {
      mcpServer,
      deployment,
      leases,
      physicalKey,
      resetServerIds,
      getStatusMarker,
      setStatusMarker,
    } = params;
    const hardResetLease = leases[0];
    const transitionLease = leases[1];
    if (!hardResetLease || !transitionLease) {
      throw new Error("Hard reset started without both lifecycle leases");
    }
    const assertLeases = async () => {
      for (const lease of leases) await lease.assertOwned();
    };
    const mcpServerId = mcpServer.id;
    const namespace = deployment.k8sNamespace;
    const deploymentName = deployment.k8sDeploymentName;
    const podSelectorServerId =
      await McpServerRuntimeManager.resolvePodSelectorServerId(mcpServer);

    logger.info(
      { mcpServerId, physicalKey },
      "Hard-resetting a stuck MCP server deployment",
    );

    await assertLeases();

    // Dropping the K8sDeployment objects takes their cached pod telemetry
    // (name, age, restart count) with them, and is what keeps the idle sweeper
    // off this deployment for the rest of the reset: the sweep only ever
    // considers deployments this map holds.
    for (const serverId of resetServerIds) {
      this.mcpServerIdToDeploymentMap.delete(serverId);
    }

    // Delete only the Deployment. Service, Secret and policies are declarative
    // and the recreate reconciles them in place; deleting them adds no recovery
    // value but creates extra split-brain mutations if a lease expires. The
    // Deployment delete itself is UID-preconditioned, so a stalled holder can
    // never delete a replacement created by a newer holder.
    await assertLeases();
    await transitionLease.runFencedMutation(() =>
      deployment.stopDeployment({ uidPrecondition: true }),
    );
    await assertLeases();
    const teardown = await this.awaitPodTermination({
      namespace,
      deploymentName,
      podSelectorServerId,
      mcpServerId,
      assertOwned: assertLeases,
      runFencedMutation: transitionLease.runFencedMutation,
    });
    await assertLeases();

    if (teardown.outcome !== "unverified") {
      const pendingMarker = getStatusMarker();
      const teardownMarker = markHardResetTeardownComplete(pendingMarker);
      try {
        const updatedIds = await writeHardResetStatuses({
          mcpServerIds: resetServerIds,
          status: "pending",
          error: teardownMarker,
          expectedMarker: pendingMarker,
          runFencedMutation: hardResetLease.runFencedMutation,
        });
        if (updatedIds.length !== new Set(resetServerIds).size) {
          throw new Error(
            "Could not advance every hard-reset status marker after teardown",
          );
        }
        setStatusMarker(teardownMarker);
      } catch (error) {
        // Recovery remains conservative without this phase: it will report an
        // interrupted reset as an error rather than mistake somebody else's
        // replacement Deployment for this reset's success. Keep rebuilding so
        // a transient status-store failure does not leave the workload absent.
        logger.warn(
          { err: error, mcpServerIds: resetServerIds },
          "Could not persist the hard-reset teardown-complete marker",
        );
      }
    }

    // Durable HTTP sessions and pooled MCP connections both address a pod that
    // no longer exists, and the demand watermarks describe a deployment that no
    // longer exists. The post-hibernate listener registry is this runtime's only
    // handle on mcp-client's connection pool (a callback registry avoids a
    // manager→mcp-client import cycle), and a reset invalidates those pools for
    // exactly the reason a hibernate does.
    for (const serverId of resetServerIds) {
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      mcpActiveUseTracker.remove(serverId);
      // SPDX-SnippetEnd
      try {
        await McpHttpSessionModel.deleteByMcpServerId(serverId);
      } catch (error) {
        logger.warn(
          { err: error, mcpServerId: serverId },
          "Failed to delete durable MCP HTTP sessions during a hard reset",
        );
      }
    }
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    await this.notifyHibernationListeners(resetServerIds);
    // SPDX-SnippetEnd
    await assertLeases();

    // A multitenant catalog runs ONE deployment for every install on it, so the
    // rebuild is catalog-level: per-install starts would race to create the
    // same Deployment and all but the first would get a 409.
    const shared =
      await McpServerRuntimeManager.isSharedMultitenantDeployment(mcpServerId);
    const catalogId = mcpServer.catalogId;
    const rebuild: McpServerHardResetResult["rebuild"] =
      teardown.outcome === "unverified"
        ? {
            outcome: "not-ready",
            reason: `the old deployment teardown could not be verified; rebuild was skipped to avoid serving old and new pods together (${teardown.reason})`,
          }
        : await this.rebuildAfterHardReset({
            mcpServer,
            shared,
            catalogId,
            transitionLease,
          });
    await assertLeases();

    const result: McpServerHardResetResult = {
      mcpServerId,
      physicalDeployment: physicalKey,
      resetServerIds,
      teardown,
      recreated:
        teardown.outcome === "unverified"
          ? false
          : shared && catalogId
            ? { target: "shared-catalog-deployment", catalogId }
            : { target: "install-deployment" },
      rebuild,
    };
    logger.info(result, "Hard reset of an MCP server deployment completed");
    return result;
  }

  /**
   * Recover hard-reset installation rows whose reporting process disappeared.
   * Exact operation markers make every repair compare-and-set safe: a stale
   * sweep cannot overwrite a newer install or reset result.
   */
  private async reconcileInterruptedHardResets(): Promise<void> {
    const rows = await McpServerModel.findPendingInstallationsByErrorPrefix(
      HARD_RESET_STATUS_MARKER_PREFIX,
    );
    const groups = new Map<
      string,
      {
        marker: NonNullable<ReturnType<typeof parseHardResetStatusMarker>>;
        ids: string[];
      }
    >();
    for (const row of rows) {
      const marker = parseHardResetStatusMarker(row.localInstallationError);
      if (!marker || !row.localInstallationError) continue;
      const group = groups.get(row.localInstallationError);
      if (group) group.ids.push(row.id);
      else groups.set(row.localInstallationError, { marker, ids: [row.id] });
    }

    await mapWithConcurrency(
      Array.from(groups.entries()),
      K8S_API_FANOUT_CONCURRENCY,
      async ([statusMarker, group]) => {
        try {
          await McpDeploymentLeaseModel.withLease(
            {
              scope: HARD_RESET_LEASE_SCOPE,
              key: group.marker.physicalDeployment,
            },
            async () => {
              const representativeId = group.ids[0];
              if (!representativeId) return;
              const deployment =
                await this.getOrLoadDeployment(representativeId);
              const ageMs = Date.now() - group.marker.startedAtMs;
              let finalStatus: "success" | "error" | undefined;
              let error: string | null = null;

              if (deployment) {
                const liveDeployment = await deployment.readLiveDeployment();
                const liveUid = liveDeployment?.metadata?.uid;
                const originalUid = group.marker.originalDeploymentUid;
                const legacyCreationTime =
                  liveDeployment?.metadata?.creationTimestamp?.getTime();
                const replacementObserved =
                  group.marker.phase === "teardown-complete" &&
                  !!liveDeployment &&
                  (originalUid === null ||
                    (typeof originalUid === "string" &&
                      typeof liveUid === "string" &&
                      liveUid !== originalUid) ||
                    (originalUid === undefined &&
                      legacyCreationTime !== undefined &&
                      legacyCreationTime >= group.marker.startedAtMs));

                await (
                  deployment as {
                    refreshState(options: {
                      skipWakeCompletion: boolean;
                    }): Promise<void>;
                  }
                ).refreshState({ skipWakeCompletion: true });
                const summary = deployment.statusSummary;
                let deploymentRecovered =
                  replacementObserved &&
                  (liveDeployment?.status?.availableReplicas ?? 0) > 0;
                // SPDX-SnippetBegin
                // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
                // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
                deploymentRecovered ||=
                  replacementObserved &&
                  liveDeployment?.metadata?.annotations?.[
                    MCP_HIBERNATED_ANNOTATION
                  ] === "true" &&
                  (liveDeployment?.spec?.replicas ?? 0) === 0;
                // SPDX-SnippetEnd
                if (deploymentRecovered) {
                  finalStatus = "success";
                } else if (summary.state === "failed") {
                  finalStatus = "error";
                  error =
                    summary.message || "Hard-reset deployment recovery failed";
                }
              }

              if (
                !finalStatus &&
                ageMs >= HARD_RESET_STATUS_RECOVERY_GRACE_MS
              ) {
                finalStatus = "error";
                error =
                  "Hard reset was interrupted and deployment recovery did not complete";
              }
              if (!finalStatus) return;

              await writeHardResetStatuses({
                mcpServerIds: group.ids,
                status: finalStatus,
                error,
                expectedMarker: statusMarker,
              });
            },
          );
        } catch (error) {
          if (error instanceof ClusterLeaseHeldError) return;
          logger.warn(
            {
              err: error,
              physicalDeployment: group.marker.physicalDeployment,
              mcpServerIds: group.ids,
            },
            "Failed to reconcile an interrupted MCP hard reset",
          );
        }
      },
    );
  }

  private startHardResetStatusReconciler(): void {
    if (this.hardResetStatusReconcileTimer) {
      clearInterval(this.hardResetStatusReconcileTimer);
    }
    const reconcile = () => {
      if (this.hardResetStatusReconcileInFlight) return;
      this.hardResetStatusReconcileInFlight =
        this.reconcileInterruptedHardResets()
          .catch((error) => {
            logger.warn(
              { err: error },
              "Failed to sweep interrupted MCP hard-reset statuses",
            );
          })
          .finally(() => {
            this.hardResetStatusReconcileInFlight = undefined;
          });
    };
    reconcile();
    this.hardResetStatusReconcileTimer = setInterval(
      reconcile,
      HARD_RESET_STATUS_RECONCILE_INTERVAL_MS,
    );
    this.hardResetStatusReconcileTimer.unref?.();
  }

  /**
   * Recreate the destroyed deployment and confirm it is actually serving.
   *
   * `freshImagePull` is the point of the escape hatch — a reset must never come
   * back on a node-cached image that may itself be what wedged the server. The
   * recreate re-stamps last-used, so the next sweep cannot hibernate what it
   * just rebuilt (the teardown cleared the old watermark).
   *
   * A rebuild that never comes up is reported, not thrown: the teardown already
   * happened, and an administrator recovering a wedged server needs to know
   * what it did — which pods were force-killed, which installs were swept up —
   * precisely in the case where the rebuild left them worse off.
   */
  private async rebuildAfterHardReset(params: {
    mcpServer: McpServer;
    shared: boolean;
    catalogId: string | null;
    transitionLease: ClusterLeaseGuard;
  }): Promise<McpServerHardResetResult["rebuild"]> {
    const { mcpServer, shared, catalogId, transitionLease } = params;
    try {
      if (shared && catalogId) {
        await this.reinstallSharedDeployment(catalogId, {
          freshImagePull: true,
          // The readiness confirmation below is this rebuild's only one: the
          // catalog path's own ready-wait would double what a reset budgets,
          // and it watches the representative install rather than the caller.
          awaitReady: false,
          transitionLease,
        });
      } else {
        await this.startServer(mcpServer, undefined, undefined, {
          freshImagePull: true,
          transitionLease,
        });
      }
      // Both recreate paths return once the Deployment OBJECT exists, which
      // says nothing about whether anything is serving behind it. Confirmed
      // against the CALLER's own view of the deployment, so a multitenant
      // rebuild is checked as the caller sees it rather than through whichever
      // install happened to represent the catalog.
      const rebuilt = await this.getOrLoadDeployment(mcpServer.id);
      if (!rebuilt) {
        return {
          outcome: "not-ready",
          reason: "the rebuilt deployment could not be resolved in the runtime",
        };
      }
      await rebuilt.waitForDeploymentReady(
        HARD_RESET_READY_ATTEMPTS,
        HARD_RESET_READY_INTERVAL_MS,
      );
      return { outcome: "ready" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error(
        { err: error, mcpServerId: mcpServer.id },
        "Rebuilt MCP server deployment did not come up after a hard reset",
      );
      return { outcome: "not-ready", reason };
    }
  }

  /**
   * Wait for the pods behind a just-deleted Deployment to actually disappear,
   * force-deleting the ones that outlive the grace window.
   *
   * A hard reset exists because the ordinary path is stuck, so it cannot assume
   * the cascade completes: a stuck finalizer or a container that ignores
   * SIGTERM keeps a pod — and its ports, volumes and Service endpoints — alive
   * indefinitely, and the rebuilt Deployment would come up alongside it.
   * `gracePeriodSeconds: 0` is the only escalation Kubernetes offers.
   */
  private async awaitPodTermination(params: {
    namespace: string;
    deploymentName: string;
    podSelectorServerId: string;
    mcpServerId: string;
    assertOwned: () => Promise<void>;
    runFencedMutation: <T>(fn: () => Promise<T>) => Promise<T>;
  }): Promise<McpServerHardResetResult["teardown"]> {
    const {
      namespace,
      deploymentName,
      podSelectorServerId,
      mcpServerId,
      assertOwned,
      runFencedMutation,
    } = params;

    let stragglers: Array<{ name: string; uid: string }>;
    try {
      stragglers = await this.awaitPodsGone({
        namespace,
        podSelectorServerId,
        assertOwned,
      });
    } catch (error) {
      // Never claim a clean teardown after a failed pod read. Rebuilding while
      // an old pod may still match the Service selector creates split-brain.
      logger.warn(
        { err: error, mcpServerId, namespace, deploymentName },
        "Could not confirm MCP server pod termination during a hard reset",
      );
      return {
        outcome: "unverified",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    if (stragglers.length === 0) {
      return { outcome: "terminated" };
    }

    logger.warn(
      {
        mcpServerId,
        namespace,
        deploymentName,
        pods: stragglers.map(({ name }) => name),
      },
      "MCP server pods outlived the hard-reset grace window; force-deleting them",
    );
    for (const { name: podName, uid } of stragglers) {
      try {
        if (!uid) {
          logger.warn(
            { podName, namespace },
            "Refusing to force-delete a pod without a UID precondition",
          );
          continue;
        }
        await runFencedMutation(async () => {
          await this.k8sApi?.deleteNamespacedPod({
            name: podName,
            namespace,
            gracePeriodSeconds: 0,
            body: { preconditions: { uid } },
          });
        });
      } catch (error) {
        // A pod that vanished between the list and the delete is the outcome
        // this call was asking for. Anything else — a 403, a 429, a 5xx —
        // means the pod may still be alive; the re-observation below is what
        // decides, so the failure is only logged here.
        if (isK8sNotFoundError(error)) {
          logger.debug(
            { err: error, podName, namespace },
            "A straggling MCP server pod vanished before its force-delete",
          );
        } else {
          logger.warn(
            { err: error, podName, namespace },
            "Force-delete of a straggling MCP server pod failed",
          );
        }
      }
    }

    // `gracePeriodSeconds: 0` is a request, not a fact — and some deletes may
    // have failed outright. Only an empty re-listing is evidence the teardown
    // is clean: a survivor here matches the rebuilt Deployment's reused
    // Service selector, and old and new pods would both take traffic while
    // the reset reports success.
    let remaining: Array<{ name: string; uid: string }>;
    try {
      remaining = await this.awaitPodsGone({
        namespace,
        podSelectorServerId,
        assertOwned,
      });
    } catch (error) {
      return {
        outcome: "unverified",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (remaining.length > 0) {
      return {
        outcome: "unverified",
        reason: `pods survived the force-delete: ${remaining
          .map(({ name }) => name)
          .join(", ")}`,
      };
    }
    return {
      outcome: "force-killed",
      pods: stragglers.map(({ name }) => name),
    };
  }

  /** Poll until no pods remain for the deployment; returns those still there. */
  private async awaitPodsGone(params: {
    namespace: string;
    podSelectorServerId: string;
    assertOwned: () => Promise<void>;
  }): Promise<Array<{ name: string; uid: string }>> {
    let remaining = await this.listPodsForDeployment(params);
    for (
      let attempt = 0;
      remaining.length > 0 && attempt < HARD_RESET_POD_GRACE_ATTEMPTS;
      attempt++
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, HARD_RESET_POD_POLL_INTERVAL_MS),
      );
      remaining = await this.listPodsForDeployment(params);
    }
    return remaining;
  }

  private async listPodsForDeployment(params: {
    namespace: string;
    podSelectorServerId: string;
    assertOwned: () => Promise<void>;
  }): Promise<Array<{ name: string; uid: string }>> {
    if (!this.k8sApi) return [];
    const { namespace, podSelectorServerId, assertOwned } = params;
    await assertOwned();
    const pods = await this.k8sApi.listNamespacedPod({
      namespace,
      // The pod selector of exactly one Deployment, and the same selector every
      // other pod lookup in this runtime uses. These names are handed to a
      // `gracePeriodSeconds: 0` delete, so a match must be an identity, never a
      // resemblance: two Deployments whose names share a prefix ("notion" and
      // "notion-eu") are different servers, and one's reset must not kill the
      // other's live pods.
      labelSelector: `app=mcp-server,mcp-server-id=${sanitizeLabelValue(
        podSelectorServerId,
      )}`,
    });
    await assertOwned();
    return pods.items
      .map((pod) => ({
        name: pod.metadata?.name ?? "",
        uid: pod.metadata?.uid ?? "",
      }))
      .filter(({ name }) => name.length > 0);
  }

  /**
   * The `mcp-server-id` label value stamped on a deployment's pods: the catalog
   * id for a multitenant catalog (one Deployment serves every install on it),
   * the install id otherwise — the identity K8sDeployment writes into the pod
   * template and selects on.
   */
  private static async resolvePodSelectorServerId(
    mcpServer: McpServer,
  ): Promise<string> {
    if (!mcpServer.catalogId) return mcpServer.id;
    const catalogItem = await InternalMcpCatalogModel.findById(
      mcpServer.catalogId,
    );
    return catalogItem?.multitenant ? mcpServer.catalogId : mcpServer.id;
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * Perform the actual wake for {@link ensureAwake} (single-flighted per
   * physical deployment by the caller).
   */
  private async wakeDeployment(
    mcpServerId: string,
    deployment: K8sDeployment,
    lease?: ClusterLeaseGuard,
  ): Promise<void> {
    await wakeDeployment({
      host: this.hibernationHost,
      mcpServerId,
      deployment,
      lease,
    });
  }
  // SPDX-SnippetEnd

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * Refuse demand for a deployment a hard reset currently owns.
   *
   * There is nothing to wake mid-reset: the Deployment is being deleted, so a
   * scale-up patch would either land on an object that is going away or fight
   * the rebuild that replaces it. Waiting for the reset instead is no kinder —
   * a teardown plus a fresh image pull runs for minutes, well past any tool
   * call's patience — so demand is told now, in the terms the demand lane
   * already understands: retryable, and not the caller's fault.
   */
  private assertNotHardResetting(deployment: K8sDeployment): void {
    const key = McpServerRuntimeManager.physicalDeploymentKey(deployment);
    if (!this.hardResetInFlightByPhysicalKey.has(key)) return;
    throw new McpServerHardResetInProgressError(
      deployment.statusSummary.serverName,
    );
  }
  // SPDX-SnippetEnd

  private async removeDeploymentWithTransitionLease(
    deployment: K8sDeployment,
  ): Promise<void> {
    await McpDeploymentLeaseModel.withLeaseWhenAvailable(
      {
        scope: MCP_DEPLOYMENT_TRANSITION_LEASE_SCOPE,
        key: McpServerRuntimeManager.physicalDeploymentKey(deployment),
        timeoutMs: MCP_DEPLOYMENT_TRANSITION_DEADLINE_MS,
      },
      (lease) =>
        deployment.removeDeployment({
          runFencedMutation: lease.runFencedMutation,
          uidPrecondition: true,
        }),
    );
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * The manager surface the hibernation lifecycle runs against. Built here so
   * every method behind it can stay private — the module needs the runtime's
   * bookkeeping, not its internals.
   */
  private get hibernationHost(): HibernationRuntimeHost {
    return {
      loadedDeployments: this.hibernatableDeployments,
      physicalDeploymentKey: (deployment) =>
        McpServerRuntimeManager.physicalDeploymentKey(deployment),
      resolveSiblingServerIds: (mcpServerId) =>
        this.resolveSiblingServerIds(mcpServerId),
      resolveSiblingServerIdsSafe: (mcpServerId) =>
        this.resolveSiblingServerIdsSafe(mcpServerId),
      setCachedStateForSiblings: (siblingIds, state) =>
        this.setCachedStateForSiblings(siblingIds, state),
      ensureAwake: (mcpServerId) => this.ensureAwake(mcpServerId),
      notifyHibernated: (mcpServerIds) =>
        this.notifyHibernationListeners(mcpServerIds),
      noteHibernatedByUs: (deployment) => {
        this.hibernatedByUsAtByPhysicalKey.set(
          McpServerRuntimeManager.physicalDeploymentKey(deployment),
          Date.now(),
        );
      },
      isReplicaCountOwnedElsewhere: (
        deployment,
        latestUsageAt,
        runFencedMutation,
      ) =>
        this.isReplicaCountOwnedElsewhere(
          deployment,
          latestUsageAt,
          runFencedMutation,
        ),
    };
  }

  /**
   * Whether another controller keeps restoring this deployment's replicas, and
   * count this observation towards that verdict.
   *
   * Called only for a deployment the sweeper already believes is running. If
   * we are the ones who put it to sleep and did not wake it again, it came
   * back on its own.
   */
  private async isReplicaCountOwnedElsewhere(
    deployment: K8sDeployment,
    latestUsageAt: Date,
    runFencedMutation: ClusterLeaseGuard["runFencedMutation"],
  ): Promise<boolean> {
    const key = McpServerRuntimeManager.physicalDeploymentKey(deployment);
    if (this.foreignReplicaOwners.has(key)) return true;

    // Serving out a cooldown from an earlier resume.
    const cooling = this.foreignResumeCooldownTicks.get(key) ?? 0;
    if (cooling > 0) {
      this.foreignResumeCooldownTicks.set(key, cooling - 1);
      return true;
    }

    const hibernatedAt = this.hibernatedByUsAtByPhysicalKey.get(key);
    if (hibernatedAt === undefined) return false;
    this.hibernatedByUsAtByPhysicalKey.delete(key);

    // Demand on another replica is committed before that replica wakes. This
    // timestamp therefore proves the resume was ours, even though this process
    // did not own the wake promise or update its local bookkeeping.
    if (latestUsageAt.getTime() >= hibernatedAt) {
      this.foreignResumeCountByPhysicalKey.delete(key);
      this.foreignResumeCooldownTicks.delete(key);
      return false;
    }

    const resumes = (this.foreignResumeCountByPhysicalKey.get(key) ?? 0) + 1;
    this.foreignResumeCountByPhysicalKey.set(key, resumes);
    if (resumes >= FOREIGN_RESUME_LIMIT) {
      const marked = await deployment.markForeignReplicaOwner({
        runFencedMutation,
      });
      if (!marked) return true;
      this.foreignReplicaOwners.add(key);
      logger.warn(
        {
          physicalDeployment: key,
          serverName: deployment.statusSummary.serverName,
        },
        "MCP deployment replica count is owned by another controller; disabling idle hibernation until explicit demand",
      );
      return true;
    }
    // Back off rather than disqualify. One resume is not proof that another
    // controller owns the replicas — a wake on a different replica looks
    // identical from here — so a permanent ban would switch hibernation off
    // for a deployment that is merely busy elsewhere. Doubling the wait
    // bounds the pod churn either way, and a deployment whose real owner
    // stops fighting is picked back up on the next attempt.
    this.foreignResumeCooldownTicks.set(
      key,
      2 ** Math.min(resumes, FOREIGN_RESUME_COOLDOWN_MAX_EXPONENT),
    );
    return true;
  }

  /**
   * The deployment cache as the idle sweeper is allowed to see it: anything a
   * hard reset currently owns is hidden, because hibernating a deployment
   * mid-reset would scale a Deployment the reset is in the middle of rebuilding.
   */
  private get hibernatableDeployments(): ReadonlyMap<string, K8sDeployment> {
    if (this.hardResetInFlightByPhysicalKey.size === 0) {
      return this.mcpServerIdToDeploymentMap;
    }
    const visible = new Map<string, K8sDeployment>();
    for (const [mcpServerId, deployment] of this.mcpServerIdToDeploymentMap) {
      const key = McpServerRuntimeManager.physicalDeploymentKey(deployment);
      if (this.hardResetInFlightByPhysicalKey.has(key)) continue;
      visible.set(mcpServerId, deployment);
    }
    return visible;
  }
  // SPDX-SnippetEnd

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * Fire every registered lifecycle listener (mcp-client's pooled connection
   * invalidation). A throwing listener must not abandon the rest.
   */
  private async notifyHibernationListeners(
    mcpServerIds: string[],
  ): Promise<void> {
    for (const listener of this.hibernationListeners) {
      try {
        await listener(mcpServerIds);
      } catch (error) {
        logger.warn(
          { err: error, mcpServerIds },
          "MCP deployment lifecycle listener failed",
        );
      }
    }
  }
  // SPDX-SnippetEnd

  /**
   * All non-deleted mcp_server rows sharing the given server's physical K8s
   * deployment: a multitenant catalog runs ONE deployment for every install
   * on the catalog (each install holding its own alias K8sDeployment object);
   * a single-tenant deployment belongs to exactly its own row.
   */
  private async resolveSiblingServerIds(
    mcpServerId: string,
  ): Promise<string[]> {
    const mcpServer = await McpServerModel.findById(mcpServerId);
    if (!mcpServer?.catalogId) return [mcpServerId];
    const catalogItem = await InternalMcpCatalogModel.findById(
      mcpServer.catalogId,
    );
    if (!catalogItem?.multitenant) return [mcpServerId];
    const siblingIds = (
      await McpServerModel.findByCatalogId(mcpServer.catalogId)
    ).map((sibling) => sibling.id);
    // findByCatalogId filters soft-deleted rows; keep the caller's id even if
    // its row is mid-delete so its own alias state is still covered.
    return siblingIds.includes(mcpServerId)
      ? siblingIds
      : [mcpServerId, ...siblingIds];
  }

  /**
   * {@link resolveSiblingServerIds} that degrades to just the caller's id on a
   * DB error — used where sibling resolution follows an already-performed K8s
   * transition and must not turn a completed wake into a rejection.
   */
  private async resolveSiblingServerIdsSafe(
    mcpServerId: string,
  ): Promise<string[]> {
    try {
      return await this.resolveSiblingServerIds(mcpServerId);
    } catch (error) {
      logger.warn(
        { err: error, mcpServerId },
        "Failed to resolve MCP deployment siblings; updating only the caller's state",
      );
      return [mcpServerId];
    }
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * Mirror a hibernation state transition onto EVERY loaded sibling alias.
   * K8sDeployment only transitions the object a lifecycle method was called
   * on, but multitenant siblings each hold a distinct object for the same
   * physical deployment — without this, a sibling's cached state would say
   * "running" for a pod we just scaled away.
   */
  private setCachedStateForSiblings(
    siblingIds: string[],
    state: McpDeploymentState,
  ): void {
    for (const siblingId of siblingIds) {
      this.mcpServerIdToDeploymentMap
        .get(siblingId)
        ?.syncStateFromSibling(state);
    }
  }
  // SPDX-SnippetEnd

  private static physicalDeploymentKey(deployment: K8sDeployment): string {
    return `${deployment.k8sNamespace}/${deployment.k8sDeploymentName}`;
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

  // === Deployment-state watch streams ===

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * Start ONLY the deployment-state watch streams — the entry point for the
   * dedicated worker process, which consumes cluster state but never
   * reconciles it. A worker wakes servers on demand and then trusts its
   * cached "running": without the watchers, a hibernation performed by a web
   * replica leaves that cache stale for the process lifetime, and every
   * later scheduled call takes ensureAwake's cached-running fast path
   * straight into a zero-replica Service. The full start() deliberately
   * stays web-only — its reconcile pass, idle sweeper, pod reaper and image
   * pre-puller must not run once per worker. Idempotent; a no-op when the
   * runtime is not configured.
   */
  startStateWatchersOnly(): void {
    if (!this.isEnabled || this.deploymentStateWatchersStarted) return;
    this.startDeploymentStateWatchers();
  }
  // SPDX-SnippetEnd

  /**
   * Open watch streams for every namespace the runtime currently deploys
   * into. Later namespaces (a server installed into a new environment) are
   * picked up via ensureWatchedNamespace from startServer, and lazy loads
   * register theirs in getOrLoadDeployment.
   */
  private startDeploymentStateWatchers(): void {
    if (!this.kubeConfig) return;
    this.deploymentStateWatchersStarted = true;
    this.deploymentStateWatchersStopped = false;

    const namespaces = new Set<string>([this.namespace]);
    for (const deployment of this.mcpServerIdToDeploymentMap.values()) {
      namespaces.add(deployment.k8sNamespace);
    }
    for (const namespace of namespaces) {
      this.watchNamespaceForStateChanges(namespace);
    }
  }

  private ensureWatchedNamespace(namespace: string): void {
    if (
      !this.deploymentStateWatchersStarted ||
      this.deploymentStateWatchersStopped ||
      this.watchedNamespaces.has(namespace)
    ) {
      return;
    }
    this.watchNamespaceForStateChanges(namespace);
  }

  private watchNamespaceForStateChanges(namespace: string): void {
    this.watchedNamespaces.add(namespace);
    for (const kind of ["pods", "deployments"] as const) {
      this.expectedWatchStreams.add(watchStreamKey(namespace, kind));
      void this.openWatchStream(namespace, kind);
    }
  }

  private async openWatchStream(
    namespace: string,
    kind: WatchStreamKind,
  ): Promise<void> {
    if (!this.kubeConfig || this.deploymentStateWatchersStopped) return;
    const key = watchStreamKey(namespace, kind);
    const path =
      kind === "pods"
        ? `/api/v1/namespaces/${namespace}/pods`
        : `/apis/apps/v1/namespaces/${namespace}/deployments`;
    try {
      const watch = new Watch(this.kubeConfig);
      const controller = await watch.watch(
        path,
        // Only objects this runtime creates — every MCP deployment and pod
        // carries app=mcp-server.
        { labelSelector: "app=mcp-server", allowWatchBookmarks: true },
        (phase) => {
          if (phase === "BOOKMARK") return;
          this.scheduleWatchTriggeredRefresh();
        },
        (err) => this.onWatchStreamClosed(namespace, kind, err),
      );
      if (this.deploymentStateWatchersStopped) {
        controller.abort();
        return;
      }
      this.watchStreamAborts.set(key, controller);
      this.liveWatchStreams.add(key);
      this.watchStreamFailureLogged.delete(key);
      // The stream may have (re)opened after missing events — resync once.
      this.scheduleWatchTriggeredRefresh();
    } catch (error) {
      this.onWatchStreamClosed(namespace, kind, error);
    }
  }

  private onWatchStreamClosed(
    namespace: string,
    kind: WatchStreamKind,
    error: unknown,
  ): void {
    const key = watchStreamKey(namespace, kind);
    this.liveWatchStreams.delete(key);
    this.watchStreamAborts.delete(key);
    if (this.deploymentStateWatchersStopped) return;

    // The API server routinely closes watch streams (timeouts, resource
    // version expiry) — that's a debug-level reopen, not a problem. Real
    // errors (missing `watch` RBAC, connectivity) get one warn per outage;
    // pollers fall back to their fast interval while the stream is down.
    if (error && !this.watchStreamFailureLogged.has(key)) {
      this.watchStreamFailureLogged.add(key);
      logger.warn(
        { err: error, namespace, kind },
        "MCP deployment-state watch stream failed; falling back to polling until it reopens",
      );
    } else {
      logger.debug(
        { namespace, kind },
        "MCP deployment-state watch stream closed; reopening",
      );
    }

    if (this.watchStreamRestartTimers.has(key)) return;
    const timer = setTimeout(
      () => {
        this.watchStreamRestartTimers.delete(key);
        void this.openWatchStream(namespace, kind);
      },
      WATCH_STREAM_RECONNECT_DELAY_MS +
        Math.floor(Math.random() * WATCH_STREAM_RECONNECT_JITTER_MS),
    );
    timer.unref?.();
    this.watchStreamRestartTimers.set(key, timer);
  }

  /**
   * Coalesce bursts of watch events (a rollout emits many per pod) into one
   * refreshAllStates() sweep, then notify listeners so fresh states are
   * pushed to websocket subscribers immediately.
   */
  private scheduleWatchTriggeredRefresh(): void {
    if (this.watchRefreshDebounceTimer) return;
    this.watchRefreshDebounceTimer = setTimeout(() => {
      this.watchRefreshDebounceTimer = undefined;
      void this.refreshAllStates({ ensureFreshAfterInFlight: true })
        .then(() => {
          for (const listener of this.stateRefreshListeners) {
            try {
              listener();
            } catch (error) {
              logger.error(
                { err: error },
                "Deployment-state refresh listener threw",
              );
            }
          }
        })
        .catch(() => {});
    }, WATCH_REFRESH_DEBOUNCE_MS);
    this.watchRefreshDebounceTimer.unref?.();
  }

  private stopDeploymentStateWatchers(): void {
    this.deploymentStateWatchersStopped = true;
    this.deploymentStateWatchersStarted = false;
    for (const timer of this.watchStreamRestartTimers.values()) {
      clearTimeout(timer);
    }
    this.watchStreamRestartTimers.clear();
    if (this.watchRefreshDebounceTimer) {
      clearTimeout(this.watchRefreshDebounceTimer);
      this.watchRefreshDebounceTimer = undefined;
    }
    for (const controller of this.watchStreamAborts.values()) {
      try {
        controller.abort();
      } catch {
        // stream already gone
      }
    }
    this.watchStreamAborts.clear();
    this.liveWatchStreams.clear();
    this.expectedWatchStreams.clear();
    this.watchedNamespaces.clear();
    this.watchStreamFailureLogged.clear();
  }

  private async namespacesForLocalCatalogs(
    localCatalogItems: CatalogItem[],
  ): Promise<string[]> {
    const namespaces = new Set<string>([this.namespace]);
    for (const catalog of localCatalogItems) {
      if (!catalog) continue;
      namespaces.add(await this.resolveNamespaceForCatalog(catalog));
    }
    return [...namespaces];
  }

  private async namespacesForInstalledLocalServers(
    installedServers: McpServer[],
    getCatalog: (
      catalogId: string | null | undefined,
    ) => Promise<CatalogItem | null>,
  ): Promise<string[]> {
    const namespaces = new Set<string>([this.namespace]);
    for (const server of installedServers) {
      const catalog = await getCatalog(server.catalogId);
      if (catalog?.serverType !== "local") continue;
      namespaces.add(await this.resolveNamespaceForCatalog(catalog));
    }
    return [...namespaces];
  }

  private async listMcpDeploymentsGroupedBySelectorId(
    namespaces: string[],
  ): Promise<Map<string, k8s.V1Deployment[]>> {
    if (!this.k8sAppsApi) {
      throw new Error("Kubernetes API client not initialized");
    }

    const deploymentsBySelectorId = new Map<string, k8s.V1Deployment[]>();
    for (const namespace of namespaces) {
      const deployments = await this.k8sAppsApi.listNamespacedDeployment({
        namespace,
        labelSelector: "app=mcp-server",
      });
      for (const deployment of deployments.items) {
        const selectorId = deployment.metadata?.labels?.["mcp-server-id"];
        if (!selectorId || !deployment.metadata?.name) continue;
        const group = deploymentsBySelectorId.get(selectorId) ?? [];
        group.push(deployment);
        deploymentsBySelectorId.set(selectorId, group);
      }
    }
    return deploymentsBySelectorId;
  }

  /**
   * Where the chart's enforcement probe left its verdict. Threading it through
   * here keeps the policies this runtime applies and the capabilities the UI
   * reports based on the same answer about the same cluster.
   */
  private networkPolicyProbeSource():
    | { coreApi: k8s.CoreV1Api; namespace: string }
    | undefined {
    return this.k8sApi
      ? { coreApi: this.k8sApi, namespace: this.namespace }
      : undefined;
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

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Demand that arrived while a hard reset owned the deployment it needs.
 *
 * A {@link McpServerWakeError} so the demand lane keeps classifying it as the
 * retryable, not-the-caller's-fault failure it is, but with its own wording:
 * nothing about this is hibernation, and telling an agent its server is waking
 * from idle would send whoever reads that message looking in the wrong place.
 */
class McpServerHardResetInProgressError extends McpServerWakeError {
  constructor(serverName: string) {
    super(serverName);
    this.name = "McpServerHardResetInProgressError";
    this.message = `MCP server ${serverName} is being rebuilt by a hard reset of its deployment and is not serving yet; retry shortly.`;
  }
}
// SPDX-SnippetEnd

/**
 * Max concurrent per-server operations when fanning out over the whole
 * install base (startup reconcile, periodic state refresh). Each operation
 * makes several K8s API calls; unbounded fan-out trips the API server's
 * Priority & Fairness throttling (429s) on large installs.
 */
const K8S_API_FANOUT_CONCURRENCY = 5;

/**
 * How long a hard reset lets a deleted Deployment's pods terminate on their own
 * before escalating to `gracePeriodSeconds: 0`. Sized just past Kubernetes'
 * 30 s default termination grace period, so an orderly shutdown is never
 * force-killed and a hung one is not waited on much longer than that.
 */
const HARD_RESET_POD_GRACE_ATTEMPTS = 35;
const HARD_RESET_POD_POLL_INTERVAL_MS = 1_000;
/** Lease scope serializing hard resets of one physical deployment across replicas. */
const HARD_RESET_LEASE_SCOPE = "mcp-hard-reset";
/** Bound pre-handle waiting to the same budget the route gives a running reset. */
const HARD_RESET_TRANSITION_ACQUIRE_TIMEOUT_MS = 20_000;

/**
 * How long a hard reset waits for its rebuilt deployment to actually serve
 * before reporting that it did not come up: 60 × 2 s = 2 minutes, the same
 * budget every other (re)deploy path allows, so a reset — which always pulls a
 * fresh image — is not the one action that gives up on a slow pull.
 *
 * It is the ONLY ready-wait a rebuild performs, including on a multitenant
 * catalog, whose recreate path is told to skip its own. So the worst case for
 * a whole reset is ~35 s of pod-termination grace plus these 2 minutes — far
 * longer than an HTTP request may be held open, which is why the route waits
 * only a bounded slice of it and reports an unfinished reset as unfinished.
 */
const HARD_RESET_READY_ATTEMPTS = 60;
const HARD_RESET_READY_INTERVAL_MS = 2_000;
/** Poll for durable markers left behind by a crashed reporting process. */
const HARD_RESET_STATUS_RECONCILE_INTERVAL_MS = 30_000;
/** Full reset budget plus room for restart-time image pulls and scheduling. */
const HARD_RESET_STATUS_RECOVERY_GRACE_MS = 5 * 60_000;

type WatchStreamKind = "pods" | "deployments";

function watchStreamKey(namespace: string, kind: WatchStreamKind): string {
  return `${namespace}|${kind}`;
}

/** Coalesce watch-event bursts (rollouts emit many events) into one sweep. */
const WATCH_REFRESH_DEBOUNCE_MS = 1_000;
/** Reopen delay after a watch stream closes (routine or error). */
const WATCH_STREAM_RECONNECT_DELAY_MS = 15_000;
const WATCH_STREAM_RECONNECT_JITTER_MS = 5_000;

export default new McpServerRuntimeManager();
