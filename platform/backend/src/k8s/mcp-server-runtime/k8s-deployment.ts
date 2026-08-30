import { PassThrough } from "node:stream";
import {
  type ImagePullSecretConfig,
  type LocalConfigSchema,
  MCP_ORCHESTRATOR_DEFAULTS,
  type McpDeploymentState,
  TimeInMs,
} from "@archestra/shared";
import type * as k8s from "@kubernetes/client-node";
import type { Attach, Exec } from "@kubernetes/client-node";
import { PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import type z from "zod";
import config from "@/config";
import { clusterDnsResolver } from "@/k8s/cluster-dns";
import {
  constructLegacyMcpDeploymentName,
  constructLegacyMultitenantMcpDeploymentName,
  ensureStringIsRfc1123Compliant,
  isK8sConflictError,
  isK8sNotFoundError,
  isTransientK8sApiError,
  sanitizeLabelValue,
  sanitizeMetadataLabels,
  withK8sApiRetry,
} from "@/k8s/shared";
import logger from "@/logging";
import { InternalMcpCatalogModel } from "@/models";
import type {
  EffectiveNetworkPolicy,
  InternalMcpCatalog,
  K8sNetworkPolicyCapabilities,
  McpServer,
} from "@/types";
import {
  applyDeploymentObservation,
  deriveOrdinaryDeploymentState,
  type OrdinaryDeploymentFacts,
} from "./hibernation-state-machine";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  assertActionTransition,
  deriveDeploymentState as deriveHibernationDeploymentState,
  MCP_FOREIGN_REPLICA_OWNER_ANNOTATION,
  MCP_HIBERNATED_ANNOTATION,
  MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION,
  // biome-ignore lint/style/noRestrictedImports: runtime-gated EE state machine import
} from "./hibernation-state-machine.ee";
// SPDX-SnippetEnd
import { getMcpImagePullPolicy } from "./image-pull-policy";
import {
  customYamlToDeployment,
  resolvePlaceholders,
} from "./k8s-yaml-generator";
import {
  buildManagedAwsApplicationNetworkPolicy,
  buildManagedCiliumNetworkPolicy,
  buildManagedGkeFqdnNetworkPolicy,
  buildManagedNetworkPolicy,
  buildUnrestrictedFloorAwsApplicationNetworkPolicy,
  buildUnrestrictedFloorPolicy,
  constructManagedNetworkPolicyName,
  isAwsApplicationNetworkPolicyProvider,
  shouldManageK8sNetworkPolicy,
  shouldUseAwsApplicationNetworkPolicy,
  shouldUseCiliumNetworkPolicy,
  shouldUseGkeFqdnNetworkPolicy,
} from "./network-policy";
import { resolveRuntimeOwnerReferences } from "./runtime-owner";
import type { K8sDeploymentStatusSummary } from "./schemas";

const {
  orchestrator: { mcpServerBaseImage },
} = config;

const MANAGED_NETWORK_POLICY_LABELS = sanitizeMetadataLabels({
  "app.kubernetes.io/managed-by": "archestra",
  "archestra.io/resource": "mcp-network-policy",
});

const MANAGED_NETWORK_POLICY_LABEL_SELECTOR = Object.entries(
  MANAGED_NETWORK_POLICY_LABELS,
)
  .map(([key, value]) => `${key}=${value}`)
  .join(",");

const CILIUM_NETWORK_POLICY_RESOURCE = {
  group: "cilium.io",
  version: "v2",
  plural: "ciliumnetworkpolicies",
  label: "CiliumNetworkPolicy",
} satisfies ManagedCustomPolicyResource;

const GKE_FQDN_NETWORK_POLICY_RESOURCE = {
  group: "networking.gke.io",
  version: "v1alpha1",
  plural: "fqdnnetworkpolicies",
  label: "GKE FQDNNetworkPolicy",
} satisfies ManagedCustomPolicyResource;

const AWS_APPLICATION_NETWORK_POLICY_RESOURCE = {
  group: "networking.k8s.aws",
  version: "v1alpha1",
  plural: "applicationnetworkpolicies",
  label: "AWS ApplicationNetworkPolicy",
} satisfies ManagedCustomPolicyResource;

// How long streamLogs will keep an open WS waiting for the pod to become
// Ready before giving up. 5 minutes covers a slow image pull on first install.
const POD_READY_WAIT_MS = 5 * TimeInMs.Minute;

/**
 * Default transport-level health contract for managed HTTP MCP servers.
 *
 * TCP probes deliberately avoid making protocol-version, authentication, or
 * session assumptions. The startup budget covers slow application bootstrap;
 * once it succeeds, readiness controls Service routing and the conservative
 * liveness cadence only restarts a server whose listening socket stays down.
 */
function buildHttpTcpProbes(
  httpPort: number,
): Pick<k8s.V1Container, "startupProbe" | "readinessProbe" | "livenessProbe"> {
  return {
    startupProbe: {
      tcpSocket: { port: httpPort },
      periodSeconds: 2,
      timeoutSeconds: 1,
      failureThreshold: 60,
    },
    readinessProbe: {
      tcpSocket: { port: httpPort },
      periodSeconds: 2,
      timeoutSeconds: 1,
      failureThreshold: 2,
      successThreshold: 1,
    },
    livenessProbe: {
      tcpSocket: { port: httpPort },
      periodSeconds: 30,
      timeoutSeconds: 1,
      failureThreshold: 3,
    },
  };
}

/** Kubernetes' direct serving signal, including the configured readiness probe. */
function isPodReady(pod: k8s.V1Pod): boolean {
  return (
    pod.status?.phase === "Running" &&
    pod.status.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    ) === true
  );
}

/**
 * Thrown when a user's MCP server deployment fails to come up (crashing
 * container, unschedulable pod, bad image/config). A condition of the user's
 * server or environment, not a bug of ours: error tracking drops it by name,
 * and routes surface it as an upstream failure.
 *
 * SPDX-SnippetBegin
 * SPDX-SnippetCopyrightText: 2026 Archestra Inc.
 * SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
 * @public — the runtime manager distinguishes it from a slow wake
 * SPDX-SnippetEnd
 */
export class McpServerDeploymentFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpServerDeploymentFailedError";
  }
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * The ready-wait ran out under capacity pressure — a full cluster or an
 * exhausted namespace quota, as told apart by {@link classifySchedulingFailure}.
 * Not a pod defect: an autoscaler adds nodes, a neighbour releases its quota,
 * so callers treat it as retryable rather than branding the deployment failed.
 *
 * A wait can hold both a capacity reason and an image-pull reason at once (a
 * rollout whose old pod is stuck pulling while its replacement finds no room),
 * so a known pull error rides along in the message. It stays out of
 * `schedulerMessage`, which callers quote as the scheduler's own wording.
 *
 * @public — the wake path maps it onto a capacity-flavored retryable error
 */
export class McpServerUnschedulableError extends Error {
  constructor(
    deploymentName: string,
    readonly schedulerMessage: string,
    lastImagePullError?: string | null,
  ) {
    super(
      `Deployment ${deploymentName} has a pod the cluster cannot schedule: ${schedulerMessage}${
        lastImagePullError
          ? ` (last image pull error: ${lastImagePullError})`
          : ""
      }`,
    );
    this.name = "McpServerUnschedulableError";
  }
}

/**
 * Outcome of a {@link K8sDeployment.hibernate} call. `hibernated: false`
 * carries why the scale-to-zero did not happen: already asleep (here or on
 * another replica), somebody else's zero-replica deployment, or a lost
 * compare-and-swap. A discriminated object rather than a boolean so future
 * outcomes extend it without touching every caller.
 *
 * @public — consumed by the idle-hibernation sweeper (hibernation.ee.ts)
 */
export type HibernateResult =
  | { hibernated: true }
  | {
      hibernated: false;
      reason: "already-hibernated" | "not-ours" | "conflict" | "waking";
    };

// SPDX-SnippetEnd
type LifecycleMutationOptions = {
  assertOwned?: () => Promise<void>;
  runFencedMutation?: <T>(fn: () => Promise<T>) => Promise<T>;
};

type RuntimeExtensionOptions = Record<string, unknown>;
type RefreshStateOptions = LifecycleMutationOptions & RuntimeExtensionOptions;

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
type HibernationRefreshStateOptions = LifecycleMutationOptions & {
  skipWakeCompletion?: boolean;
  throwOnError?: boolean;
};
type HibernationReadyOptions = {
  waitOutUnschedulablePods?: boolean;
};
// SPDX-SnippetEnd
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

/**
 * What a lifecycle write did. Only `applied` means the cluster now holds what
 * the decision intended; every other outcome means no transition happened and
 * the caller must not run the work that follows one.
 */
type TransitionWriteOutcome =
  /** Written, and the response still carries the change. */
  | { status: "applied"; applied: k8s.V1Deployment }
  /** The live object was not what the decision assumed. Nothing was written. */
  | { status: "shape-changed"; live: k8s.V1Deployment | null }
  /** Superseded by a newer transition, or lost the CAS repeatedly. No write. */
  | { status: "lost-race" }
  /** Written, but the stored object does not carry the change. */
  | { status: "not-persisted"; applied: k8s.V1Deployment }
  /**
   * Written, the response did not carry the change, and the cluster could not
   * be re-read: whether the change persisted is unknown. Callers must treat
   * this as NOT applied — missing information is never acceptance.
   */
  | { status: "unconfirmed" };

/**
 * How many times a lifecycle write re-reads and re-checks after a 409 before
 * giving up. Losing twice in a row means the object is genuinely contended;
 * the next sweep or the next demand re-decides from scratch, which is cheaper
 * and safer than spinning here.
 */
const TRANSITION_WRITE_MAX_ATTEMPTS = 3;

/**
 * Classify why the scheduler could not place a pod.
 *
 * `capacity` means the cluster is merely full: a node-scale-up or a freed /
 * raised ResourceQuota clears it without anyone touching the server, so a
 * wake may keep waiting. Everything else — an unmatchable nodeSelector or
 * affinity, an untolerated taint, an unbindable volume — describes a pod this
 * cluster can never place, and waiting on it would retry until the end of
 * time.
 *
 * Unrecognized wording is `terminal` deliberately: calling real capacity
 * pressure a defect only restores the pre-existing fail-fast behavior, while
 * calling a permanent condition capacity produces a wait that never ends.
 * A composite message counts as capacity if any clause is resource pressure —
 * those nodes are full, so more nodes would place the pod.
 *
 * @public — exported for direct testing
 */
export function classifySchedulingFailure(
  message: string,
): "capacity" | "terminal" {
  return CAPACITY_PRESSURE_PATTERNS.some((pattern) => pattern.test(message))
    ? "capacity"
    : "terminal";
}
// SPDX-SnippetEnd

// Container waiting reasons that won't resolve without user action (bad
// config, invalid image name, crashing server) — treat as terminal failures.
const TERMINAL_CONTAINER_WAITING_REASONS = [
  "CrashLoopBackOff",
  "ErrImageNeverPull",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
  "InvalidImageName",
];

// Image pull failures are usually transient (registry hiccup, network blip,
// rate limiting). The kubelet keeps retrying the pull on its own with
// exponential backoff, so the pod recovers without intervention once the
// pull succeeds — treat these as "still starting", not as terminal failures.
const TRANSIENT_IMAGE_PULL_WAITING_REASONS = [
  "ImagePullBackOff",
  "ErrImagePull",
];

interface ManagedCustomPolicyResource {
  group: string;
  version: string;
  plural: string;
  label: string;
}

/**
 * Result of processing container environment configuration.
 * Contains both environment variables and mounted secrets information.
 */
interface ContainerEnvResult {
  envVars: k8s.V1EnvVar[];
  mountedSecrets: Array<{ key: string }>;
}

/**
 * Shared cache for the archestra-platform pod spec.
 * Both nodeSelector and tolerations fetchers read from this cache,
 * so only one API call is made regardless of how many fields are extracted.
 */
let platformPodSpecCache: {
  fetched: boolean;
  spec: k8s.V1PodSpec | null;
} = { fetched: false, spec: null };

/**
 * Fetches and caches the archestra-platform pod spec.
 * Uses POD_NAME → HOSTNAME fallback → label selector lookup strategy.
 * Only makes one API call; subsequent calls return the cached spec.
 */
async function fetchPlatformPodSpec(
  k8sApi: k8s.CoreV1Api,
  namespace: string,
): Promise<k8s.V1PodSpec | null> {
  if (platformPodSpecCache.fetched) {
    return platformPodSpecCache.spec;
  }

  try {
    // Try to find the current pod by reading the POD_NAME environment variable
    // which is typically set via the Kubernetes downward API.
    // Only attempt this when running inside K8s cluster - otherwise HOSTNAME
    // will be the Docker container ID which won't exist as a K8s pod.
    const podName = config.orchestrator.kubernetes
      .loadKubeconfigFromCurrentCluster
      ? process.env.POD_NAME || process.env.HOSTNAME
      : process.env.POD_NAME;

    if (podName) {
      const pod = await k8sApi.readNamespacedPod({
        name: podName,
        namespace,
      });

      platformPodSpecCache = { fetched: true, spec: pod.spec ?? null };
      return platformPodSpecCache.spec;
    }

    // Fallback: Search for pods with app.kubernetes.io/name=archestra-platform label
    const pods = await k8sApi.listNamespacedPod({
      namespace,
      labelSelector: "app.kubernetes.io/name=archestra-platform",
    });

    const runningPod = pods.items.find(
      (pod) => pod.status?.phase === "Running",
    );

    platformPodSpecCache = {
      fetched: true,
      spec: runningPod?.spec ?? null,
    };
    return platformPodSpecCache.spec;
  } catch (error) {
    logger.warn(
      { err: error },
      "Failed to fetch archestra-platform pod spec, MCP servers will use default scheduling",
    );

    platformPodSpecCache = { fetched: true, spec: null };
    return null;
  }
}

function resetPlatformPodSpecCache(): void {
  platformPodSpecCache = { fetched: false, spec: null };
}

interface PlatformPodSpecFetcher<T> {
  fetch: (k8sApi: k8s.CoreV1Api, namespace: string) => Promise<T | null>;
  getCached: () => T | null;
  resetCache: () => void;
}

/**
 * Factory that creates a cached fetcher for a specific field from the archestra-platform pod spec.
 * All fetchers share the same underlying pod spec cache, so only one API call is made.
 */
function createPlatformPodSpecFetcher<T>(options: {
  extract: (spec: k8s.V1PodSpec) => T | undefined | null;
  label: string;
}): PlatformPodSpecFetcher<T> {
  let cachedValue: T | null = null;
  let extracted = false;

  return {
    async fetch(k8sApi, namespace) {
      if (extracted) {
        return cachedValue;
      }

      const spec = await fetchPlatformPodSpec(k8sApi, namespace);

      cachedValue = spec ? (options.extract(spec) ?? null) : null;
      extracted = true;

      if (cachedValue) {
        logger.info(
          { [options.label]: cachedValue },
          `Inherited ${options.label} from archestra-platform pod`,
        );
      } else {
        logger.debug(
          `Archestra-platform pod has no ${options.label} configured`,
        );
      }

      return cachedValue;
    },

    getCached() {
      return cachedValue;
    },

    resetCache() {
      cachedValue = null;
      extracted = false;
      resetPlatformPodSpecCache();
    },
  };
}

const nodeSelectorFetcher = createPlatformPodSpecFetcher<
  k8s.V1PodSpec["nodeSelector"]
>({
  extract: (spec) => spec.nodeSelector,
  label: "nodeSelector",
});

const tolerationsFetcher = createPlatformPodSpecFetcher<k8s.V1Toleration[]>({
  extract: (spec) => (spec.tolerations?.length ? spec.tolerations : null),
  label: "tolerations",
});

export const fetchPlatformPodNodeSelector = nodeSelectorFetcher.fetch;
/** @public — exported for testability */
export const getCachedPlatformNodeSelector = nodeSelectorFetcher.getCached;
/** @public — exported for testability */
export const resetPlatformNodeSelectorCache = nodeSelectorFetcher.resetCache;

export const fetchPlatformPodTolerations = tolerationsFetcher.fetch;
const getCachedPlatformTolerations = tolerationsFetcher.getCached;
/** @public — exported for testability */
export const resetPlatformTolerationsCache = tolerationsFetcher.resetCache;

interface K8sDeploymentOptions {
  mcpServer: McpServer;
  k8sApi: k8s.CoreV1Api;
  k8sAppsApi: k8s.AppsV1Api;
  k8sRbacApi?: k8s.RbacAuthorizationV1Api;
  k8sNetworkingApi?: k8s.NetworkingV1Api;
  k8sCustomObjectsApi?: k8s.CustomObjectsApi;
  k8sAttach: Attach;
  k8sLog: k8s.Log;
  namespace: string;
  catalogItem?: InternalMcpCatalog | null;
  userConfigValues?: Record<string, string>;
  environmentValues?: Record<string, string>;
  effectiveNetworkPolicy?: EffectiveNetworkPolicy | null;
  networkPolicyCapabilities?: K8sNetworkPolicyCapabilities | null;
  k8sExec: Exec;
}

/**
 * K8sDeployment manages a single MCP server running as a Kubernetes Deployment.
 */
export default class K8sDeployment {
  private static readonly MAX_K8S_LABEL_LENGTH = 63;
  private static readonly HTTP_SERVICE_SUFFIX = "-service";
  private mcpServer: McpServer;
  private k8sApi: k8s.CoreV1Api;
  private k8sAppsApi: k8s.AppsV1Api;
  private k8sRbacApi?: k8s.RbacAuthorizationV1Api;
  private k8sNetworkingApi?: k8s.NetworkingV1Api;
  private k8sCustomObjectsApi?: k8s.CustomObjectsApi;
  private k8sAttach: Attach;
  private k8sLog: k8s.Log;
  private k8sExec: Exec;
  private defaultNamespace: string;
  private deploymentName: string; // Used for deployment name
  private state: McpDeploymentState = "not_created";
  private errorMessage: string | null = null;
  // One-shot: the next generated spec pulls fresh (`Always`) even though the
  // steady-state policy is `IfNotPresent` — the refresh-image flow's
  // freshness contract. See image-pull-policy.ts.
  private freshImagePullRequested = false;
  /** Count of consecutive polls where a running deployment appeared unavailable.
   *  We only downgrade to "pending" after multiple misses to avoid flickering
   *  caused by transient K8s API lag. */
  private runningMissCount = 0;
  private static readonly RUNNING_MISS_THRESHOLD = 3;
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /** Bumped when a hibernation lifecycle transition starts. refreshState reads
   *  the cluster across several awaits, so without this a refresh that began
   *  before a hibernate/wake could land its now-stale reading on top of the
   *  transition's state — advertising "running" for a deployment that is in
   *  fact scaled to zero. */
  private stateGeneration = 0;
  // SPDX-SnippetEnd
  private cachedRestartCount = 0;
  private cachedPodCreationTime: Date | null = null;
  private cachedPodName: string | null = null;
  private catalogItem?: InternalMcpCatalog | null;
  private userConfigValues?: Record<string, string>;
  private environmentValues?: Record<string, string>;
  private effectiveNetworkPolicy?: EffectiveNetworkPolicy | null;
  private networkPolicyCapabilities?: K8sNetworkPolicyCapabilities | null;
  private runtimeOwnerReferences?: k8s.V1OwnerReference[];

  // Track assigned port for HTTP-based MCP servers
  assignedHttpPort?: number;
  // Track the HTTP endpoint URL for streamable-http servers
  httpEndpointUrl?: string;

  constructor(options: K8sDeploymentOptions) {
    this.mcpServer = options.mcpServer;
    this.k8sApi = options.k8sApi;
    this.k8sAppsApi = options.k8sAppsApi;
    this.k8sRbacApi = options.k8sRbacApi;
    this.k8sNetworkingApi = options.k8sNetworkingApi;
    this.k8sCustomObjectsApi = options.k8sCustomObjectsApi;
    this.k8sAttach = options.k8sAttach;
    this.k8sLog = options.k8sLog;
    this.k8sExec = options.k8sExec;
    this.defaultNamespace = options.namespace;
    this.catalogItem = options.catalogItem;
    this.userConfigValues = options.userConfigValues;
    this.environmentValues = options.environmentValues;
    this.effectiveNetworkPolicy = options.effectiveNetworkPolicy;
    this.networkPolicyCapabilities = options.networkPolicyCapabilities;
    this.deploymentName = K8sDeployment.constructDeploymentName(
      options.mcpServer,
      options.catalogItem,
    );
  }

  /**
   * Returns the effective namespace for this deployment.
   */
  private get namespace(): string {
    return this.defaultNamespace;
  }

  /**
   * Returns the Kubernetes deployment name for an MCP server.
   *
   * Deployment identity is FROZEN: the stored `deploymentName` (written once
   * at creation, or adopted from the live cluster by the startup adopt pass)
   * always wins, so a rename never re-derives — and never orphans — the
   * running deployment. The name-derived recompute is a transitional
   * fallback for rows not frozen yet (e.g. K8s runtime disabled, so the
   * adopt pass never ran).
   *
   * Multi-tenant catalogs share one deployment per catalog (frozen on the
   * catalog row so all caller mcp_server rows alias the same pod).
   * Single-tenant (default) gets one deployment per mcp_server row.
   */
  static constructDeploymentName(
    mcpServer: McpServer,
    catalogItem?: InternalMcpCatalog | null,
  ): string {
    if (catalogItem?.multitenant && mcpServer.catalogId) {
      return (
        catalogItem.deploymentName ??
        constructLegacyMultitenantMcpDeploymentName(
          mcpServer.catalogId,
          catalogItem.name,
        )
      );
    }
    if (mcpServer.deploymentName) {
      return mcpServer.deploymentName;
    }
    return constructLegacyMcpDeploymentName(mcpServer.name);
  }

  /**
   * Constructs the Kubernetes Secret name for an MCP server.
   *
   * Multi-tenant catalogs share a catalog-stable secret so all callers' pods
   * reference the same secret (env vars are catalog-level). Single-tenant
   * gets a per-mcpServer secret.
   */
  static constructK8sSecretName(
    mcpServerId: string,
    catalogItem?: InternalMcpCatalog | null,
    catalogId?: string | null,
  ): string {
    if (catalogItem?.multitenant && catalogId) {
      return `mcp-server-mt-${catalogId.slice(0, 8)}-secrets`;
    }
    return `mcp-server-${mcpServerId}-secrets`;
  }

  /**
   * Returns the K8s Secret name for this MCP server, taking multi-tenancy
   * into account using the cached catalogItem if available.
   */
  private getK8sSecretName(): string {
    return K8sDeployment.constructK8sSecretName(
      this.mcpServer.id,
      this.catalogItem,
      this.mcpServer.catalogId,
    );
  }

  /** Replace the policy snapshot immediately before a leased reconciliation. */
  setEffectiveNetworkPolicy(
    effectiveNetworkPolicy: EffectiveNetworkPolicy,
  ): void {
    this.effectiveNetworkPolicy = effectiveNetworkPolicy;
  }

  /**
   * Create, update, or remove the managed Kubernetes NetworkPolicy for this deployment.
   */
  async applyK8sNetworkPolicy(): Promise<void> {
    const policyName = this.getK8sNetworkPolicyName();

    if (!shouldManageK8sNetworkPolicy(this.effectiveNetworkPolicy)) {
      await this.applyUnrestrictedFloorNetworkPolicy(policyName);
      return;
    }

    const effectivePolicy = this.effectiveNetworkPolicy;
    if (!effectivePolicy) {
      return;
    }

    if (
      shouldUseCiliumNetworkPolicy({
        effectivePolicy,
        capabilities: this.networkPolicyCapabilities,
      })
    ) {
      await this.applyCiliumNetworkPolicy(policyName, effectivePolicy);
      await Promise.all([
        this.deleteKubernetesNetworkPolicy(policyName),
        this.deleteGkeFqdnNetworkPolicy(policyName),
        this.deleteAwsApplicationNetworkPolicy(policyName),
      ]);
      await this.cleanupStaleManagedNetworkPolicies({
        desiredPolicyName: policyName,
        desiredCustomPolicy: CILIUM_NETWORK_POLICY_RESOURCE,
      });
      return;
    }

    if (
      shouldUseGkeFqdnNetworkPolicy({
        effectivePolicy,
        capabilities: this.networkPolicyCapabilities,
      })
    ) {
      // GKE FQDNNetworkPolicy only handles domain rules, so keep a standard
      // NetworkPolicy alongside it for CIDR egress.
      await this.applyKubernetesNetworkPolicy(policyName, effectivePolicy);
      await this.applyGkeFqdnNetworkPolicy(policyName, effectivePolicy);
      await Promise.all([
        this.deleteCiliumNetworkPolicy(policyName),
        this.deleteAwsApplicationNetworkPolicy(policyName),
      ]);
      await this.cleanupStaleManagedNetworkPolicies({
        desiredPolicyName: policyName,
        keepKubernetesPolicy: true,
        desiredCustomPolicy: GKE_FQDN_NETWORK_POLICY_RESOURCE,
      });
      return;
    }

    if (
      shouldUseAwsApplicationNetworkPolicy({
        effectivePolicy,
        capabilities: this.networkPolicyCapabilities,
      })
    ) {
      await this.applyAwsApplicationNetworkPolicy(policyName, effectivePolicy);
      await Promise.all([
        this.deleteKubernetesNetworkPolicy(policyName),
        this.deleteCiliumNetworkPolicy(policyName),
        this.deleteGkeFqdnNetworkPolicy(policyName),
      ]);
      await this.cleanupStaleManagedNetworkPolicies({
        desiredPolicyName: policyName,
        desiredCustomPolicy: AWS_APPLICATION_NETWORK_POLICY_RESOURCE,
      });
      return;
    }

    await this.applyKubernetesNetworkPolicy(policyName, effectivePolicy);
    await Promise.all([
      this.deleteCiliumNetworkPolicy(policyName),
      this.deleteGkeFqdnNetworkPolicy(policyName),
      this.deleteAwsApplicationNetworkPolicy(policyName),
    ]);
    await this.cleanupStaleManagedNetworkPolicies({
      desiredPolicyName: policyName,
      keepKubernetesPolicy: true,
    });
  }

  private async applyKubernetesNetworkPolicy(
    policyName: string,
    effectivePolicy: EffectiveNetworkPolicy,
  ): Promise<void> {
    await this.upsertKubernetesNetworkPolicy(
      policyName,
      buildManagedNetworkPolicy({
        name: policyName,
        podSelectorLabels: this.getPodSelectorLabels(),
        effectivePolicy,
      }),
    );
  }

  /**
   * Apply the always-on SSRF floor for `unrestricted`/built-in pods: allow DNS +
   * public egress with private/link-local/metadata ranges blocked. Emitted as an
   * `ApplicationNetworkPolicy` on AWS VPC CNI (where a plain `NetworkPolicy` is
   * accepted but not enforced), otherwise a plain `NetworkPolicy`. Deletes the
   * non-selected policy kinds so relaxing from a restricted Cilium/GKE/AWS policy
   * removes the stale object.
   */
  private async applyUnrestrictedFloorNetworkPolicy(
    policyName: string,
  ): Promise<void> {
    const allowedCidrs =
      this.effectiveNetworkPolicy?.policy?.allowedCidrs ?? [];
    const labels = {
      app: "mcp-server",
      "app.kubernetes.io/managed-by": "archestra",
      "archestra.io/resource": "mcp-network-policy",
      "archestra.io/network-policy-source":
        this.effectiveNetworkPolicy?.source ?? "built_in",
    };

    // Both floor variants take the resolved resolver IP(s): the AWS ANP floor
    // depends on it entirely (it cannot express a selector peer), while the plain
    // NetworkPolicy floor uses a selector-based DNS rule and adds these only as a
    // supplementary allow for non-kube-dns resolvers (NodeLocal DNSCache, custom
    // DNS). Cached per client, so this lookup is cheap on the common path.
    const clusterDnsIps = await clusterDnsResolver.getClusterDnsIps(
      this.k8sApi,
    );

    if (isAwsApplicationNetworkPolicyProvider(this.networkPolicyCapabilities)) {
      if (clusterDnsIps.length === 0) {
        // Only the AWS ANP floor degrades here — it falls back to allowing :53 to
        // any IP. The plain floor still resolves via its selector-based rule.
        logger.warn(
          {
            mcpServerId: this.mcpServer.id,
            networkPolicyName: policyName,
            namespace: this.namespace,
          },
          "Cluster DNS service IP could not be resolved; unrestricted floor will allow DNS egress to any IP",
        );
      }

      await this.upsertManagedCustomPolicy({
        resource: AWS_APPLICATION_NETWORK_POLICY_RESOURCE,
        policyName,
        body: buildUnrestrictedFloorAwsApplicationNetworkPolicy({
          name: policyName,
          podSelectorLabels: this.getPodSelectorLabels(),
          labels,
          clusterDnsIps,
          allowedCidrs,
        }),
      });
      await Promise.all([
        this.deleteKubernetesNetworkPolicy(policyName),
        this.deleteCiliumNetworkPolicy(policyName),
        this.deleteGkeFqdnNetworkPolicy(policyName),
      ]);
      await this.cleanupStaleManagedNetworkPolicies({
        desiredPolicyName: policyName,
        desiredCustomPolicy: AWS_APPLICATION_NETWORK_POLICY_RESOURCE,
      });
      return;
    }

    await this.upsertKubernetesNetworkPolicy(
      policyName,
      buildUnrestrictedFloorPolicy({
        name: policyName,
        podSelectorLabels: this.getPodSelectorLabels(),
        labels,
        clusterDnsIps,
        allowedCidrs,
      }),
    );
    await Promise.all([
      this.deleteCiliumNetworkPolicy(policyName),
      this.deleteGkeFqdnNetworkPolicy(policyName),
      this.deleteAwsApplicationNetworkPolicy(policyName),
    ]);
    await this.cleanupStaleManagedNetworkPolicies({
      desiredPolicyName: policyName,
      keepKubernetesPolicy: true,
    });
  }

  private async upsertKubernetesNetworkPolicy(
    policyName: string,
    networkPolicy: k8s.V1NetworkPolicy,
  ): Promise<void> {
    const k8sNetworkingApi = this.requireK8sNetworkingApi();
    const ownedPolicy = await this.withRuntimeOwnerReference(networkPolicy);

    try {
      try {
        await k8sNetworkingApi.createNamespacedNetworkPolicy({
          namespace: this.namespace,
          body: ownedPolicy,
        });
        logger.info(
          {
            mcpServerId: this.mcpServer.id,
            networkPolicyName: policyName,
            namespace: this.namespace,
          },
          "Created K8s NetworkPolicy for MCP server",
        );
      } catch (createError: unknown) {
        if (!isK8sConflictError(createError)) {
          throw createError;
        }

        await k8sNetworkingApi.replaceNamespacedNetworkPolicy({
          name: policyName,
          namespace: this.namespace,
          body: ownedPolicy,
        });
        logger.info(
          {
            mcpServerId: this.mcpServer.id,
            networkPolicyName: policyName,
            namespace: this.namespace,
          },
          "Updated K8s NetworkPolicy for MCP server",
        );
      }
    } catch (error) {
      logger.error(
        {
          err: error,
          mcpServerId: this.mcpServer.id,
          networkPolicyName: policyName,
        },
        "Failed to create or update K8s NetworkPolicy",
      );
      throw error;
    }
  }

  private async applyCiliumNetworkPolicy(
    policyName: string,
    effectivePolicy: EffectiveNetworkPolicy,
  ): Promise<void> {
    await this.upsertManagedCustomPolicy({
      resource: CILIUM_NETWORK_POLICY_RESOURCE,
      policyName,
      body: buildManagedCiliumNetworkPolicy({
        name: policyName,
        podSelectorLabels: this.getPodSelectorLabels(),
        effectivePolicy,
      }),
    });
  }

  private async applyGkeFqdnNetworkPolicy(
    policyName: string,
    effectivePolicy: EffectiveNetworkPolicy,
  ): Promise<void> {
    await this.upsertManagedCustomPolicy({
      resource: GKE_FQDN_NETWORK_POLICY_RESOURCE,
      policyName,
      body: buildManagedGkeFqdnNetworkPolicy({
        name: policyName,
        podSelectorLabels: this.getPodSelectorLabels(),
        effectivePolicy,
      }),
    });
  }

  private async applyAwsApplicationNetworkPolicy(
    policyName: string,
    effectivePolicy: EffectiveNetworkPolicy,
  ): Promise<void> {
    const clusterDnsIps = await clusterDnsResolver.getClusterDnsIps(
      this.k8sApi,
    );
    if (clusterDnsIps.length === 0) {
      logger.warn(
        {
          mcpServerId: this.mcpServer.id,
          networkPolicyName: policyName,
          namespace: this.namespace,
        },
        "Cluster DNS service IP could not be resolved; ApplicationNetworkPolicy will allow DNS egress to any IP",
      );
    }

    await this.upsertManagedCustomPolicy({
      resource: AWS_APPLICATION_NETWORK_POLICY_RESOURCE,
      policyName,
      body: buildManagedAwsApplicationNetworkPolicy({
        name: policyName,
        podSelectorLabels: this.getPodSelectorLabels(),
        effectivePolicy,
        clusterDnsIps,
      }),
    });
  }

  /**
   * Create or update a managed custom policy object.
   *
   * Updates read the live object and PUT a full replace (carrying its
   * resourceVersion, required by CRDs, and any controller-owned finalizers)
   * rather than a JSON merge patch: merge patch recurses into nested objects and
   * cannot delete a key absent from the body, so a stale selector label from an
   * older release would survive and keep the policy from selecting its pod.
   */
  private async upsertManagedCustomPolicy(params: {
    resource: ManagedCustomPolicyResource;
    policyName: string;
    body: Record<string, unknown>;
  }): Promise<void> {
    const k8sCustomObjectsApi = this.requireK8sCustomObjectsApi();
    const { group, version, plural, label } = params.resource;
    const ownedBody = await this.withRuntimeOwnerReference(
      params.body as Record<string, unknown> & { metadata?: k8s.V1ObjectMeta },
    );

    try {
      try {
        await k8sCustomObjectsApi.createNamespacedCustomObject({
          group,
          version,
          namespace: this.namespace,
          plural,
          body: ownedBody,
        });
        logger.info(
          {
            mcpServerId: this.mcpServer.id,
            networkPolicyName: params.policyName,
            namespace: this.namespace,
          },
          `Created ${label} for MCP server`,
        );
      } catch (createError: unknown) {
        if (!isK8sConflictError(createError)) {
          throw createError;
        }

        // Full replace, not merge-patch: a JSON Merge Patch recurses into
        // podSelector.matchLabels and cannot delete a key absent from the body,
        // so a stale selector label (e.g. a pre-fix mcp-server-name) would survive
        // and keep the policy from selecting its pod. A blind PUT is rejected
        // without a resourceVersion, so read the live object and carry its
        // resourceVersion (and any controller-owned finalizers) into the body.
        // Retry the read-modify-write on a 409: the policy's own CRD controller
        // (AWS VPC CNI, Cilium operator) can bump resourceVersion by writing
        // finalizers/status between the GET and the PUT.
        for (let attempt = 1; ; attempt++) {
          const existing = await k8sCustomObjectsApi.getNamespacedCustomObject({
            group,
            version,
            namespace: this.namespace,
            plural,
            name: params.policyName,
          });
          try {
            await k8sCustomObjectsApi.replaceNamespacedCustomObject({
              group,
              version,
              namespace: this.namespace,
              plural,
              name: params.policyName,
              body: bodyWithPreservedMetadata(ownedBody, existing),
            });
            break;
          } catch (replaceError: unknown) {
            if (
              isK8sConflictError(replaceError) &&
              attempt < CUSTOM_POLICY_REPLACE_MAX_ATTEMPTS
            ) {
              continue;
            }
            throw replaceError;
          }
        }
        logger.info(
          {
            mcpServerId: this.mcpServer.id,
            networkPolicyName: params.policyName,
            namespace: this.namespace,
          },
          `Updated ${label} for MCP server`,
        );
      }
    } catch (error) {
      logger.error(
        {
          err: error,
          mcpServerId: this.mcpServer.id,
          networkPolicyName: params.policyName,
        },
        `Failed to create or update ${label}`,
      );
      throw error;
    }
  }

  private async getRuntimeOwnerReferences(): Promise<
    k8s.V1OwnerReference[] | undefined
  > {
    if (this.runtimeOwnerReferences) return this.runtimeOwnerReferences;
    try {
      const ownerReferences = await resolveRuntimeOwnerReferences(
        this.k8sRbacApi,
        this.namespace,
      );
      if (ownerReferences) this.runtimeOwnerReferences = ownerReferences;
      return ownerReferences;
    } catch (error) {
      logger.debug(
        { err: error, namespace: this.namespace },
        "Could not read the configured owner Role for MCP runtime resources",
      );
      return undefined;
    }
  }

  private async withRuntimeOwnerReference<
    T extends { metadata?: k8s.V1ObjectMeta },
  >(resource: T): Promise<T> {
    const ownerReferences = await this.getRuntimeOwnerReferences();
    if (!ownerReferences) return resource;
    const existing = resource.metadata?.ownerReferences ?? [];
    return {
      ...resource,
      metadata: {
        ...resource.metadata,
        ownerReferences: [
          ...existing,
          ...ownerReferences.filter(
            (owner) => !existing.some(({ uid }) => uid === owner.uid),
          ),
        ],
      },
    };
  }

  private async adoptRuntimeOwner(deployment: k8s.V1Deployment): Promise<void> {
    const ownerReferences = await this.getRuntimeOwnerReferences();
    if (!ownerReferences) return;
    const existing = deployment.metadata?.ownerReferences ?? [];
    const missing = ownerReferences.filter(
      (owner) => !existing.some(({ uid }) => uid === owner.uid),
    );
    if (missing.length === 0) return;
    try {
      await this.k8sAppsApi.patchNamespacedDeployment(
        {
          name: this.deploymentName,
          namespace: this.namespace,
          body: {
            metadata: {
              ...K8sDeployment.resourceVersionPrecondition(deployment),
              ownerReferences: [...existing, ...missing],
            },
          },
        },
        setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
      );
    } catch (error) {
      logger.warn(
        { err: error, deploymentName: this.deploymentName },
        "Could not attach the Helm runtime owner to an existing MCP deployment",
      );
    }
  }

  private requireK8sNetworkingApi(): k8s.NetworkingV1Api {
    if (!this.k8sNetworkingApi) {
      throw new Error(
        "Cannot apply network policy: K8s networking API not available",
      );
    }
    return this.k8sNetworkingApi;
  }

  private requireK8sCustomObjectsApi(): k8s.CustomObjectsApi {
    if (!this.k8sCustomObjectsApi) {
      throw new Error(
        "Cannot apply network policy: K8s custom objects API not available",
      );
    }
    return this.k8sCustomObjectsApi;
  }

  /**
   * Delete the managed Kubernetes NetworkPolicy for this deployment.
   */
  async deleteK8sNetworkPolicy(): Promise<void> {
    const policyName = this.getK8sNetworkPolicyName();
    await Promise.all([
      this.deleteKubernetesNetworkPolicy(policyName),
      this.deleteCiliumNetworkPolicy(policyName),
      this.deleteGkeFqdnNetworkPolicy(policyName),
      this.deleteAwsApplicationNetworkPolicy(policyName),
    ]);
    await this.cleanupStaleManagedNetworkPolicies({
      desiredPolicyName: policyName,
    });
  }

  private async deleteKubernetesNetworkPolicy(
    policyName: string,
  ): Promise<void> {
    if (
      typeof this.k8sNetworkingApi?.deleteNamespacedNetworkPolicy !== "function"
    ) {
      return;
    }

    try {
      await this.k8sNetworkingApi.deleteNamespacedNetworkPolicy({
        name: policyName,
        namespace: this.namespace,
      });

      logger.info(
        {
          mcpServerId: this.mcpServer.id,
          networkPolicyName: policyName,
          namespace: this.namespace,
        },
        "Deleted K8s NetworkPolicy for MCP server",
      );
    } catch (error: unknown) {
      if (isK8sNotFoundError(error)) {
        logger.debug(
          {
            mcpServerId: this.mcpServer.id,
            networkPolicyName: policyName,
          },
          "K8s NetworkPolicy not found (already deleted or never created)",
        );
        return;
      }

      logger.error(
        {
          err: error,
          mcpServerId: this.mcpServer.id,
          networkPolicyName: policyName,
        },
        "Failed to delete K8s NetworkPolicy",
      );
      throw error;
    }
  }

  private async deleteCiliumNetworkPolicy(policyName: string): Promise<void> {
    if (
      typeof this.k8sCustomObjectsApi?.deleteNamespacedCustomObject !==
      "function"
    ) {
      return;
    }

    try {
      await this.k8sCustomObjectsApi.deleteNamespacedCustomObject({
        group: "cilium.io",
        version: "v2",
        namespace: this.namespace,
        plural: "ciliumnetworkpolicies",
        name: policyName,
      });

      logger.info(
        {
          mcpServerId: this.mcpServer.id,
          networkPolicyName: policyName,
          namespace: this.namespace,
        },
        "Deleted CiliumNetworkPolicy for MCP server",
      );
    } catch (error: unknown) {
      if (isK8sNotFoundError(error)) {
        logger.debug(
          {
            mcpServerId: this.mcpServer.id,
            networkPolicyName: policyName,
          },
          "CiliumNetworkPolicy not found (already deleted or never created)",
        );
        return;
      }

      logger.error(
        {
          err: error,
          mcpServerId: this.mcpServer.id,
          networkPolicyName: policyName,
        },
        "Failed to delete CiliumNetworkPolicy",
      );
      throw error;
    }
  }

  private async deleteGkeFqdnNetworkPolicy(policyName: string): Promise<void> {
    if (
      typeof this.k8sCustomObjectsApi?.deleteNamespacedCustomObject !==
      "function"
    ) {
      return;
    }

    try {
      await this.k8sCustomObjectsApi.deleteNamespacedCustomObject({
        group: "networking.gke.io",
        version: "v1alpha1",
        namespace: this.namespace,
        plural: "fqdnnetworkpolicies",
        name: policyName,
      });

      logger.info(
        {
          mcpServerId: this.mcpServer.id,
          networkPolicyName: policyName,
          namespace: this.namespace,
        },
        "Deleted GKE FQDNNetworkPolicy for MCP server",
      );
    } catch (error: unknown) {
      if (isK8sNotFoundError(error)) {
        logger.debug(
          {
            mcpServerId: this.mcpServer.id,
            networkPolicyName: policyName,
          },
          "GKE FQDNNetworkPolicy not found (already deleted or never created)",
        );
        return;
      }

      logger.error(
        {
          err: error,
          mcpServerId: this.mcpServer.id,
          networkPolicyName: policyName,
        },
        "Failed to delete GKE FQDNNetworkPolicy",
      );
      throw error;
    }
  }

  private async deleteAwsApplicationNetworkPolicy(
    policyName: string,
  ): Promise<void> {
    if (
      typeof this.k8sCustomObjectsApi?.deleteNamespacedCustomObject !==
      "function"
    ) {
      return;
    }

    try {
      await this.k8sCustomObjectsApi.deleteNamespacedCustomObject({
        group: "networking.k8s.aws",
        version: "v1alpha1",
        namespace: this.namespace,
        plural: "applicationnetworkpolicies",
        name: policyName,
      });

      logger.info(
        {
          mcpServerId: this.mcpServer.id,
          networkPolicyName: policyName,
          namespace: this.namespace,
        },
        "Deleted AWS ApplicationNetworkPolicy for MCP server",
      );
    } catch (error: unknown) {
      if (isK8sNotFoundError(error)) {
        logger.debug(
          {
            mcpServerId: this.mcpServer.id,
            networkPolicyName: policyName,
          },
          "AWS ApplicationNetworkPolicy not found (already deleted or never created)",
        );
        return;
      }

      logger.error(
        {
          err: error,
          mcpServerId: this.mcpServer.id,
          networkPolicyName: policyName,
        },
        "Failed to delete AWS ApplicationNetworkPolicy",
      );
      throw error;
    }
  }

  private async cleanupStaleManagedNetworkPolicies(params: {
    desiredPolicyName: string;
    keepKubernetesPolicy?: boolean;
    desiredCustomPolicy?: ManagedCustomPolicyResource;
  }): Promise<void> {
    await Promise.all([
      this.cleanupStaleKubernetesNetworkPolicies(params),
      this.cleanupStaleCustomNetworkPolicies({
        desiredPolicyName: params.desiredPolicyName,
        resource: CILIUM_NETWORK_POLICY_RESOURCE,
        keepPolicy:
          params.desiredCustomPolicy?.plural ===
          CILIUM_NETWORK_POLICY_RESOURCE.plural,
      }),
      this.cleanupStaleCustomNetworkPolicies({
        desiredPolicyName: params.desiredPolicyName,
        resource: GKE_FQDN_NETWORK_POLICY_RESOURCE,
        keepPolicy:
          params.desiredCustomPolicy?.plural ===
          GKE_FQDN_NETWORK_POLICY_RESOURCE.plural,
      }),
      this.cleanupStaleCustomNetworkPolicies({
        desiredPolicyName: params.desiredPolicyName,
        resource: AWS_APPLICATION_NETWORK_POLICY_RESOURCE,
        keepPolicy:
          params.desiredCustomPolicy?.plural ===
          AWS_APPLICATION_NETWORK_POLICY_RESOURCE.plural,
      }),
    ]);
  }

  private async cleanupStaleKubernetesNetworkPolicies(params: {
    desiredPolicyName: string;
    keepKubernetesPolicy?: boolean;
  }): Promise<void> {
    if (
      typeof this.k8sNetworkingApi?.listNamespacedNetworkPolicy !== "function"
    ) {
      return;
    }

    const stalePolicies = await this.k8sNetworkingApi
      .listNamespacedNetworkPolicy({
        namespace: this.namespace,
        labelSelector: MANAGED_NETWORK_POLICY_LABEL_SELECTOR,
      })
      .then((response) =>
        response.items.filter((policy) =>
          this.shouldDeleteManagedPolicy({
            policyName: policy.metadata?.name,
            desiredPolicyName: params.desiredPolicyName,
            keepPolicy: params.keepKubernetesPolicy === true,
            metadataLabels: policy.metadata?.labels,
            spec: policy.spec,
          }),
        ),
      )
      .catch((error: unknown) => {
        if (isK8sNotFoundError(error)) return [];
        throw error;
      });

    await Promise.all(
      stalePolicies.map((policy) =>
        this.deleteKubernetesNetworkPolicy(policy.metadata?.name ?? ""),
      ),
    );
  }

  private async cleanupStaleCustomNetworkPolicies(params: {
    desiredPolicyName: string;
    resource: ManagedCustomPolicyResource;
    keepPolicy: boolean;
  }): Promise<void> {
    if (
      typeof this.k8sCustomObjectsApi?.listNamespacedCustomObject !== "function"
    ) {
      return;
    }

    const stalePolicies = await this.k8sCustomObjectsApi
      .listNamespacedCustomObject({
        group: params.resource.group,
        version: params.resource.version,
        namespace: this.namespace,
        plural: params.resource.plural,
        labelSelector: MANAGED_NETWORK_POLICY_LABEL_SELECTOR,
      })
      .then((response) =>
        listCustomObjectItems(response).filter((policy) =>
          this.shouldDeleteManagedPolicy({
            policyName: policy.metadata?.name,
            desiredPolicyName: params.desiredPolicyName,
            keepPolicy: params.keepPolicy,
            metadataLabels: policy.metadata?.labels,
            spec: policy.spec,
          }),
        ),
      )
      .catch((error: unknown) => {
        if (isK8sNotFoundError(error)) return [];
        throw error;
      });

    await Promise.all(
      stalePolicies.map((policy) =>
        this.deleteCustomNetworkPolicy({
          resource: params.resource,
          policyName: policy.metadata?.name ?? "",
        }),
      ),
    );
  }

  private async deleteCustomNetworkPolicy(params: {
    resource: ManagedCustomPolicyResource;
    policyName: string;
  }): Promise<void> {
    if (!params.policyName) return;

    try {
      await this.k8sCustomObjectsApi?.deleteNamespacedCustomObject({
        group: params.resource.group,
        version: params.resource.version,
        namespace: this.namespace,
        plural: params.resource.plural,
        name: params.policyName,
      });

      logger.info(
        {
          mcpServerId: this.mcpServer.id,
          networkPolicyName: params.policyName,
          namespace: this.namespace,
        },
        `Deleted stale ${params.resource.label} for MCP server`,
      );
    } catch (error: unknown) {
      if (isK8sNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }

  private shouldDeleteManagedPolicy(params: {
    policyName?: string;
    desiredPolicyName: string;
    keepPolicy: boolean;
    metadataLabels?: Record<string, string>;
    spec?: unknown;
  }): boolean {
    if (!params.policyName) return false;
    if (!hasManagedNetworkPolicyLabels(params.metadataLabels)) return false;
    if (!policyTargetsPodLabels(params.spec, this.getPodSelectorLabels())) {
      return false;
    }
    return !params.keepPolicy || params.policyName !== params.desiredPolicyName;
  }

  /**
   * Get catalog item for this MCP server.
   * Caches the result in this.catalogItem for subsequent calls.
   */
  async getCatalogItem(): Promise<InternalMcpCatalog | null> {
    if (this.catalogItem) {
      return this.catalogItem;
    }

    if (!this.mcpServer.catalogId) {
      return null;
    }

    const item = await InternalMcpCatalogModel.findById(
      this.mcpServer.catalogId,
    );

    this.catalogItem = item;
    return this.catalogItem;
  }

  /**
   * Create or update a Kubernetes Secret for environment variables marked as "secret" type
   */
  async createK8sSecret(secretData: Record<string, string>): Promise<void> {
    const k8sSecretName = this.getK8sSecretName();

    if (Object.keys(secretData).length === 0) {
      logger.debug(
        { mcpServerId: this.mcpServer.id },
        "No secret data provided, skipping K8s Secret creation",
      );
      return;
    }

    try {
      // Convert secret data to base64 (K8s requires base64 encoding for secret values)
      const data: Record<string, string> = {};
      for (const [key, value] of Object.entries(secretData)) {
        data[key] = Buffer.from(value).toString("base64");
      }

      const secret = await this.withRuntimeOwnerReference<k8s.V1Secret>({
        metadata: {
          name: k8sSecretName,
          labels: sanitizeMetadataLabels({
            app: "mcp-server",
            "mcp-server-id": this.mcpServer.id,
            "mcp-server-name": this.mcpServer.name,
          }),
        },
        type: "Opaque",
        data,
      });

      try {
        // Try to create the secret
        await this.k8sApi.createNamespacedSecret({
          namespace: this.namespace,
          body: secret,
        });

        logger.info(
          {
            mcpServerId: this.mcpServer.id,
            secretName: k8sSecretName,
            namespace: this.namespace,
          },
          "Created K8s Secret for MCP server",
        );
      } catch (createError: unknown) {
        // If secret already exists (409), update it instead
        const isConflict =
          createError &&
          typeof createError === "object" &&
          (("statusCode" in createError && createError.statusCode === 409) ||
            ("code" in createError && createError.code === 409));

        if (isConflict) {
          logger.info(
            {
              mcpServerId: this.mcpServer.id,
              secretName: k8sSecretName,
              namespace: this.namespace,
            },
            "K8s Secret already exists, updating it",
          );

          await this.k8sApi.replaceNamespacedSecret({
            name: k8sSecretName,
            namespace: this.namespace,
            body: secret,
          });

          logger.info(
            {
              mcpServerId: this.mcpServer.id,
              secretName: k8sSecretName,
              namespace: this.namespace,
            },
            "Updated existing K8s Secret for MCP server",
          );
        } else {
          // Re-throw other errors
          throw createError;
        }
      }
    } catch (error) {
      logger.error(
        {
          err: error,
          mcpServerId: this.mcpServer.id,
          secretName: k8sSecretName,
        },
        "Failed to create or update K8s Secret",
      );
      throw error;
    }
  }

  /**
   * Delete the Kubernetes Secret for this MCP server
   */
  async deleteK8sSecret(): Promise<void> {
    const k8sSecretName = this.getK8sSecretName();

    try {
      await this.k8sApi.deleteNamespacedSecret({
        name: k8sSecretName,
        namespace: this.namespace,
      });

      logger.info(
        {
          mcpServerId: this.mcpServer.id,
          secretName: k8sSecretName,
          namespace: this.namespace,
        },
        "Deleted K8s Secret for MCP server",
      );
    } catch (error: unknown) {
      // If secret doesn't exist (404), that's okay - it may have been deleted already or never created
      if (isK8sNotFoundError(error)) {
        logger.debug(
          {
            mcpServerId: this.mcpServer.id,
            secretName: k8sSecretName,
          },
          "K8s Secret not found (already deleted or never created)",
        );
        return;
      }

      logger.error(
        {
          err: error,
          mcpServerId: this.mcpServer.id,
          secretName: k8sSecretName,
        },
        "Failed to delete K8s Secret",
      );
      throw error;
    }
  }

  /**
   * Delete the Kubernetes Service for this MCP server (used by HTTP-based servers)
   */
  async deleteK8sService(): Promise<void> {
    const serviceName = this.constructHttpServiceName();

    try {
      await this.k8sApi.deleteNamespacedService({
        name: serviceName,
        namespace: this.namespace,
      });

      logger.info(
        {
          mcpServerId: this.mcpServer.id,
          serviceName,
          namespace: this.namespace,
        },
        "Deleted K8s Service for MCP server",
      );
    } catch (error: unknown) {
      // If service doesn't exist (404), that's okay - it may have been deleted already or never created
      if (isK8sNotFoundError(error)) {
        logger.debug(
          {
            mcpServerId: this.mcpServer.id,
            serviceName,
          },
          "K8s Service not found (already deleted or never created)",
        );
        return;
      }

      logger.error(
        {
          err: error,
          mcpServerId: this.mcpServer.id,
          serviceName,
        },
        "Failed to delete K8s Service",
      );
      throw error;
    }
  }

  /**
   * Create docker-registry Kubernetes Secrets from image pull secret credentials.
   * Extracts __regcred_password:<server>:<username> entries from secretData and matches them with
   * non-sensitive fields from localConfig.imagePullSecrets (credentials entries).
   *
   * @returns Array of created secret names to be used in pod spec imagePullSecrets
   */
  async createDockerRegistrySecrets(
    secretData: Record<string, string>,
    imagePullSecrets?: ImagePullSecretConfig[],
  ): Promise<string[]> {
    if (!imagePullSecrets) return [];

    const createdSecretNames: string[] = [];

    for (const entry of imagePullSecrets) {
      if (entry.source !== "credentials") continue;

      const passwordKey = `__regcred_password:${entry.server}:${entry.username}`;
      const password = secretData[passwordKey];
      if (!password) {
        logger.warn(
          {
            mcpServerId: this.mcpServer.id,
            server: entry.server,
            username: entry.username,
          },
          "Skipping regcred creation: password not found in secret data",
        );
        continue;
      }

      // Use sanitized server + username in secret name for kubectl traceability and uniqueness
      // K8s secret names must be DNS-1123 subdomain: max 253 chars, [a-z0-9.-], start/end alphanumeric
      const sanitizedServer = ensureStringIsRfc1123Compliant(
        entry.server,
      ).slice(0, 40);
      const sanitizedUsername = ensureStringIsRfc1123Compliant(
        entry.username,
      ).slice(0, 20);
      const secretName =
        `mcp-server-${this.mcpServer.id}-regcred-${sanitizedServer}-${sanitizedUsername}`
          .replace(/[^a-z0-9]+$/, "")
          .substring(0, 253);
      const auth = Buffer.from(`${entry.username}:${password}`).toString(
        "base64",
      );

      const dockerConfigJson = JSON.stringify({
        auths: {
          [entry.server]: {
            username: entry.username,
            password,
            email: entry.email || "",
            auth,
          },
        },
      });

      const k8sSecret = await this.withRuntimeOwnerReference<k8s.V1Secret>({
        metadata: {
          name: secretName,
          labels: sanitizeMetadataLabels({
            app: "mcp-server",
            "mcp-server-id": this.mcpServer.id,
            type: "regcred",
            ...(this.mcpServer.teamId
              ? { "team-id": this.mcpServer.teamId }
              : {}),
          }),
        },
        type: "kubernetes.io/dockerconfigjson",
        data: {
          ".dockerconfigjson": Buffer.from(dockerConfigJson).toString("base64"),
        },
      });

      try {
        try {
          await this.k8sApi.createNamespacedSecret({
            namespace: this.namespace,
            body: k8sSecret,
          });
        } catch (createError: unknown) {
          const isConflict =
            createError &&
            typeof createError === "object" &&
            (("statusCode" in createError && createError.statusCode === 409) ||
              ("code" in createError && createError.code === 409));

          if (isConflict) {
            await this.k8sApi.replaceNamespacedSecret({
              name: secretName,
              namespace: this.namespace,
              body: k8sSecret,
            });
          } else {
            throw createError;
          }
        }

        createdSecretNames.push(secretName);
        logger.info(
          {
            mcpServerId: this.mcpServer.id,
            secretName,
            server: entry.server,
          },
          "Created docker-registry K8s Secret for MCP server",
        );
      } catch (error) {
        logger.error(
          { err: error, mcpServerId: this.mcpServer.id, secretName },
          "Failed to create docker-registry K8s Secret",
        );
        throw error;
      }
    }

    return createdSecretNames;
  }

  /**
   * Delete docker-registry Kubernetes Secrets created for this MCP server.
   * Uses label selector to find and delete all regcred secrets.
   */
  async deleteDockerRegistrySecrets(): Promise<void> {
    try {
      const sanitizedId = sanitizeLabelValue(this.mcpServer.id);
      const labelSelector = `mcp-server-id=${sanitizedId},type=regcred`;

      const secrets = await this.k8sApi.listNamespacedSecret({
        namespace: this.namespace,
        labelSelector,
      });

      for (const secret of secrets.items) {
        if (secret.metadata?.name) {
          await this.k8sApi.deleteNamespacedSecret({
            name: secret.metadata.name,
            namespace: this.namespace,
          });
          logger.info(
            {
              mcpServerId: this.mcpServer.id,
              secretName: secret.metadata.name,
            },
            "Deleted docker-registry K8s Secret",
          );
        }
      }
    } catch (error: unknown) {
      if (isK8sNotFoundError(error)) {
        return;
      }
      logger.error(
        { err: error, mcpServerId: this.mcpServer.id },
        "Failed to delete docker-registry K8s Secrets",
      );
      throw error;
    }
  }

  /**
   * Collect all imagePullSecrets names for pod spec: existing secret names +
   * generated docker-registry secret names from credentials entries.
   */
  static collectImagePullSecretNames(
    imagePullSecrets: ImagePullSecretConfig[] | undefined,
    generatedRegcredNames: string[],
  ): Array<{ name: string }> {
    const names: Array<{ name: string }> = [];

    if (imagePullSecrets) {
      for (const entry of imagePullSecrets) {
        if (entry.source === "existing") {
          names.push({ name: entry.name });
        }
      }
    }

    for (const name of generatedRegcredNames) {
      names.push({ name });
    }

    return names;
  }

  /**
   * Returns the system-managed labels that must always be present on deployments.
   * These labels are used for identification and cannot be overridden by user configuration.
   */
  private getSystemLabels(): Record<string, string> {
    return sanitizeMetadataLabels({
      app: "mcp-server",
      "mcp-server-id": this.getPodSelectorServerId(),
      "mcp-server-name": this.mcpServer.name,
    });
  }

  /**
   * Labels the per-pod NetworkPolicy (and Service) selector keys on: `app` plus
   * the catalog-stable `mcp-server-id` (see getPodSelectorServerId). It excludes
   * `mcp-server-name`: for a multitenant catalog the shared pod is labeled with
   * one install's name while the policy may be reconciled by another install, so
   * an AND-semantics selector keyed on the name would match zero pods — the pod
   * then falls through to the namespace deny-all baseline and gets no egress
   * (DNS included). `mcp-server-id` alone uniquely identifies the server.
   */
  private getPodSelectorLabels(): Record<string, string> {
    return sanitizeMetadataLabels({
      app: "mcp-server",
      "mcp-server-id": this.getPodSelectorServerId(),
    });
  }

  /**
   * The identity stamped into the `mcp-server-id` pod label + selector (and the
   * matching Service selector / pod lookups).
   *
   * Multitenant catalogs share ONE catalog-named Deployment + Service across
   * every install (see {@link constructDeploymentName}, which keys the name on
   * `catalogId` for multitenant). Keying the *selector* on the per-install
   * `mcpServer.id` lets whichever install reconciles the shared resource last
   * overwrite it, so the Deployment's pods and the Service's selector can end up
   * bound to different installs — the Service then selects zero pods, has no
   * Endpoints, and every connect/read fails ("Resource read failed").
   *
   * Use the catalog-stable id for multitenant so every install reconciles to the
   * exact same selector. Single-tenant servers keep their per-install id (their
   * Deployment/Service are not shared, so the name and selector are per-install).
   * This uses the same condition as `constructDeploymentName`, so the selector is
   * catalog-stable exactly when the resource is catalog-shared.
   */
  private getPodSelectorServerId(): string {
    if (this.catalogItem?.multitenant && this.mcpServer.catalogId) {
      return this.mcpServer.catalogId;
    }
    return this.mcpServer.id;
  }

  /**
   * Generate the deployment specification for this MCP server
   *
   * @param dockerImage - The Docker image to use for the container
   * @param localConfig - The local configuration for the MCP server
   * @param needsHttp - Whether the deployment's pod needs HTTP port exposure
   * @param httpPort - The HTTP port to expose (if needsHttp is true)
   * @param nodeSelector - Optional nodeSelector to apply to the pod spec (e.g., inherited from platform pod)
   * @param tolerations - Optional tolerations to apply to the pod spec (e.g., inherited from platform pod)
   * @returns The Kubernetes deployment specification
   */
  /**
   * Make the next {@link generateDeploymentSpec} emit `imagePullPolicy:
   * Always` so its rollout pulls the current image — the refresh-image flow's
   * freshness contract under the `IfNotPresent` steady state. One-shot.
   */
  requestFreshImagePull(): void {
    this.freshImagePullRequested = true;
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * Best-effort read of what a wake would ask of the container registry: the
   * image the sleeping deployment will run and the pull policy that decides
   * whether a node-cached copy is allowed to satisfy it.
   *
   * Deliberately says nothing about which nodes hold that image — that lives
   * in `node.status.images`, a cluster-scoped read the platform's namespaced
   * Role does not grant, so it would be a 403 on every real install. Never
   * throws — callers log, they don't gate.
   */
  async assessWakeImageCache(): Promise<{
    image: string;
    pullPolicy: string;
  } | null> {
    try {
      const live = await this.readLiveDeployment();
      const container = live?.spec?.template?.spec?.containers?.[0];
      if (!container?.image) return null;
      return {
        image: container.image,
        pullPolicy: container.imagePullPolicy ?? "IfNotPresent",
      };
    } catch {
      return null;
    }
  }
  // SPDX-SnippetEnd

  private consumeFreshImagePullRequest(): boolean {
    const requested = this.freshImagePullRequested;
    this.freshImagePullRequested = false;
    return requested;
  }

  generateDeploymentSpec(
    dockerImage: string,
    localConfig: z.infer<typeof LocalConfigSchema>,
    needsHttp: boolean,
    httpPort: number,
    nodeSelector?: k8s.V1PodSpec["nodeSelector"] | null,
    tolerations?: k8s.V1Toleration[] | null,
    resolvedImagePullSecretNames?: Array<{ name: string }>,
  ): k8s.V1Deployment {
    // Check if YAML override is provided
    if (this.catalogItem?.deploymentSpecYaml) {
      const yamlDeployment = this.generateDeploymentFromYaml(
        this.catalogItem.deploymentSpecYaml,
        dockerImage,
        localConfig,
        needsHttp,
        httpPort,
        nodeSelector,
        tolerations,
        resolvedImagePullSecretNames,
      );
      if (yamlDeployment) {
        logger.info(
          { mcpServerId: this.mcpServer.id },
          "generated deploymentSpecYaml",
        );
        return yamlDeployment;
      }
      // If YAML parsing failed, fall through to default generation
      logger.warn(
        { mcpServerId: this.mcpServer.id },
        "Failed to parse deploymentSpecYaml, falling back to default generation",
      );
    }

    const labels = this.getSystemLabels();

    // Get environment variables and mounted secrets
    const { envVars, mountedSecrets } = this.createContainerEnvFromConfig();
    const k8sSecretName = this.getK8sSecretName();

    // Build volume mounts for mounted secrets (read-only files at /secrets/<key>)
    const volumeMounts: k8s.V1VolumeMount[] = mountedSecrets.map(({ key }) => ({
      name: "mounted-secrets",
      mountPath: `/secrets/${key}`,
      subPath: key,
      readOnly: true,
    }));

    // Build volumes for secrets mounted as files (single volume with all secret keys)
    const volumes: k8s.V1Volume[] =
      mountedSecrets.length > 0
        ? [
            {
              name: "mounted-secrets",
              secret: {
                secretName: k8sSecretName,
                items: mountedSecrets.map(({ key }) => ({ key, path: key })),
              },
            },
          ]
        : [];

    const podSpec: k8s.V1PodSpec = {
      // Fast shutdown for stateless MCP servers (default is 30s)
      terminationGracePeriodSeconds: 5,
      // Disable automatic Service env var injection to keep MCP pod environments minimal.
      enableServiceLinks: false,
      // Use dedicated service account if specified (value used directly from catalog)
      ...(localConfig.serviceAccount
        ? {
            serviceAccountName: localConfig.serviceAccount,
          }
        : {}),
      // Apply nodeSelector if provided (e.g., inherited from archestra-platform pod)
      ...(nodeSelector && Object.keys(nodeSelector).length > 0
        ? { nodeSelector }
        : {}),
      // Apply tolerations if provided (e.g., inherited from archestra-platform pod)
      ...(tolerations?.length ? { tolerations } : {}),
      // Apply imagePullSecrets for pulling from private registries
      ...(resolvedImagePullSecretNames?.length
        ? { imagePullSecrets: resolvedImagePullSecretNames }
        : {}),
      // Add volumes for secrets mounted as files
      ...(volumes.length > 0 ? { volumes } : {}),
      containers: [
        {
          name: "mcp-server",
          image: dockerImage,
          imagePullPolicy: getMcpImagePullPolicy(dockerImage, {
            forceFreshPull: this.consumeFreshImagePullRequest(),
          }),
          env: envVars,
          // Inject all keys from existing K8s Secrets/ConfigMaps as env vars
          ...(localConfig.envFrom?.length
            ? {
                envFrom: localConfig.envFrom.map((ref) => ({
                  ...(ref.type === "secret"
                    ? { secretRef: { name: ref.name } }
                    : { configMapRef: { name: ref.name } }),
                  ...(ref.prefix ? { prefix: ref.prefix } : {}),
                })),
              }
            : {}),
          ...(localConfig.command
            ? {
                command: [localConfig.command],
              }
            : {}),
          args: (localConfig.arguments || []).map((arg) => {
            // Interpolate ${user_config.xxx} placeholders with actual values
            // Use environmentValues first (for internal catalog), fallback to userConfigValues (for external catalog)
            if (this.environmentValues || this.userConfigValues) {
              return arg.replace(
                /\$\{user_config\.([^}]+)\}/g,
                (match, configKey) => {
                  return (
                    this.environmentValues?.[configKey] ||
                    this.userConfigValues?.[configKey] ||
                    match
                  );
                },
              );
            }
            return arg;
          }),
          // For stdio-based MCP servers, we use stdin/stdout
          // For HTTP-based MCP servers, expose port instead
          ...(needsHttp
            ? {
                ports: [
                  {
                    containerPort: httpPort,
                    protocol: "TCP",
                  },
                ],
                ...buildHttpTcpProbes(httpPort),
              }
            : {
                stdin: true,
                tty: false,
              }),
          // Add volume mounts for mounted secrets
          ...(volumeMounts.length > 0 ? { volumeMounts } : {}),
          // Set resource requests/limits for the container (with defaults).
          // Ephemeral-storage governance keeps the scheduler disk-aware and
          // prevents DiskPressure eviction cascades on over-packed nodes.
          resources: {
            requests: {
              memory: config.orchestrator.mcpServerResources.requests.memory,
              cpu: config.orchestrator.mcpServerResources.requests.cpu,
              "ephemeral-storage":
                config.orchestrator.mcpServerResources.requests
                  .ephemeralStorage,
            },
            limits: {
              memory: config.orchestrator.mcpServerResources.limits.memory,
              "ephemeral-storage":
                config.orchestrator.mcpServerResources.limits.ephemeralStorage,
            },
          },
        },
      ],
      restartPolicy: "Always",
    };

    // Build pod template metadata
    const podTemplateMetadata: k8s.V1ObjectMeta = {
      labels,
    };

    return {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: this.deploymentName, // Use the same naming convention for the deployment
        labels,
      },
      spec: {
        replicas: MCP_ORCHESTRATOR_DEFAULTS.replicas,
        // Selector keys on `app` + stable `mcp-server-id` only. Selectors are
        // immutable, so the mutable `mcp-server-name` label must not be part
        // of pod identity (it would block any in-place update after a
        // rename). Deployment metadata and pod-template labels keep the full
        // set — a selector may match a subset of the pod labels. Existing
        // deployments with the old 3-label selector are left as-is (reconcile
        // compares only `mcp-server-id`) and converge on natural recreate.
        selector: {
          matchLabels: this.getPodSelectorLabels(),
        },
        template: {
          metadata: podTemplateMetadata,
          spec: podSpec,
        },
      },
    };
  }

  /**
   * Generate deployment spec from user-provided YAML with placeholders resolved.
   *
   * @param yamlString - The YAML string with placeholders
   * @param dockerImage - The Docker image to use
   * @param localConfig - The local configuration
   * @param needsHttp - Whether HTTP port is needed
   * @param httpPort - The HTTP port
   * @param nodeSelector - Optional nodeSelector
   * @param tolerations - Optional tolerations
   * @returns The K8s deployment or null if parsing failed
   */
  private generateDeploymentFromYaml(
    yamlString: string,
    dockerImage: string,
    localConfig: z.infer<typeof LocalConfigSchema>,
    needsHttp: boolean,
    httpPort: number,
    nodeSelector?: k8s.V1PodSpec["nodeSelector"] | null,
    tolerations?: k8s.V1Toleration[] | null,
    resolvedImagePullSecretNames?: Array<{ name: string }>,
  ): k8s.V1Deployment | null {
    const k8sSecretName = this.getK8sSecretName();

    // Build env values map for placeholder resolution
    // Note: Values may be booleans/numbers at runtime despite type annotations, so we convert to string
    const envValues: Record<string, string> = {};
    if (this.catalogItem?.localConfig?.environment) {
      for (const envDef of this.catalogItem.localConfig.environment) {
        // Skip secret types - they use secretKeyRef, not direct values
        if (envDef.type === "secret") {
          continue;
        }

        let value: string | undefined;
        if (envDef.promptOnInstallation) {
          const rawValue = this.environmentValues?.[envDef.key];
          value = rawValue != null ? String(rawValue) : undefined;
        } else {
          value = envDef.value != null ? String(envDef.value) : undefined;
          // Interpolate ${user_config.xxx} placeholders
          if (value && (this.environmentValues || this.userConfigValues)) {
            value = value.replace(
              /\$\{user_config\.([^}]+)\}/g,
              (match, configKey) => {
                const configValue =
                  this.environmentValues?.[configKey] ??
                  this.userConfigValues?.[configKey];
                return configValue != null ? String(configValue) : match;
              },
            );
          }
        }

        if (value) {
          envValues[envDef.key] = value;
        }
      }
    }

    // Resolve placeholders in the YAML
    const resolvedYaml = resolvePlaceholders(
      yamlString,
      {
        deploymentName: this.deploymentName,
        serverId: this.mcpServer.id,
        serverName: this.mcpServer.name,
        namespace: this.namespace,
        dockerImage,
        secretName: k8sSecretName,
        command: localConfig.command,
        arguments: localConfig.arguments,
        serviceAccount: localConfig.serviceAccount,
      },
      envValues,
    );

    // System-managed labels that must always be present (catalog-stable selector
    // id for multitenant — see getPodSelectorServerId).
    const labels = this.getSystemLabels();

    // Parse YAML and merge with system values
    const deployment = customYamlToDeployment(resolvedYaml, {
      deploymentName: this.deploymentName,
      serverId: this.mcpServer.id,
      serverName: this.mcpServer.name,
      labels,
      selectorLabels: this.getPodSelectorLabels(),
    });

    if (!deployment) {
      return null;
    }

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // Lifecycle annotations are ownership tokens, not user configuration. A
    // custom manifest must never make an operator-authored zero-replica
    // Deployment look hibernated by Archestra or choose an arbitrary wake
    // replica count.
    if (deployment.metadata?.annotations) {
      delete deployment.metadata.annotations[
        MCP_FOREIGN_REPLICA_OWNER_ANNOTATION
      ];
      delete deployment.metadata.annotations[MCP_HIBERNATED_ANNOTATION];
      delete deployment.metadata.annotations[
        MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION
      ];
    }
    if (deployment.spec?.template?.metadata?.annotations) {
      delete deployment.spec.template.metadata.annotations[
        MCP_FOREIGN_REPLICA_OWNER_ANNOTATION
      ];
      delete deployment.spec.template.metadata.annotations[
        MCP_HIBERNATED_ANNOTATION
      ];
      delete deployment.spec.template.metadata.annotations[
        MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION
      ];
    }
    // SPDX-SnippetEnd

    // Apply additional system-managed settings that may not be in YAML
    // 1. Apply nodeSelector if provided
    if (
      nodeSelector &&
      Object.keys(nodeSelector).length > 0 &&
      deployment.spec?.template?.spec
    ) {
      deployment.spec.template.spec.nodeSelector = {
        ...(deployment.spec.template.spec.nodeSelector || {}),
        ...nodeSelector,
      };
    }

    // 2. Apply inherited tolerations if the YAML doesn't define its own
    if (
      tolerations?.length &&
      deployment.spec?.template?.spec &&
      !deployment.spec.template.spec.tolerations?.length
    ) {
      deployment.spec.template.spec.tolerations = tolerations;
    }

    // 3. Apply imagePullSecrets if provided (resolved names: existing + generated regcred)
    if (
      resolvedImagePullSecretNames?.length &&
      deployment.spec?.template?.spec
    ) {
      const existingSecrets =
        deployment.spec.template.spec.imagePullSecrets || [];
      const existingNames = new Set(existingSecrets.map((s) => s.name));
      const newSecrets = resolvedImagePullSecretNames.filter(
        (s) => !existingNames.has(s.name),
      );
      deployment.spec.template.spec.imagePullSecrets = [
        ...existingSecrets,
        ...newSecrets,
      ];
    }

    // 4. Get environment variables and mounted secrets for system-managed env vars
    const { envVars, mountedSecrets } = this.createContainerEnvFromConfig();

    // 5. Apply volume mounts for mounted secrets
    if (mountedSecrets.length > 0 && deployment.spec?.template?.spec) {
      const newVolume: k8s.V1Volume = {
        name: "mounted-secrets",
        secret: {
          secretName: k8sSecretName,
          items: mountedSecrets.map(({ key }) => ({ key, path: key })),
        },
      };

      // Filter out any existing "mounted-secrets" volume to avoid duplicates
      const existingVolumes = (
        deployment.spec.template.spec.volumes || []
      ).filter((v) => v.name !== "mounted-secrets");

      deployment.spec.template.spec.volumes = [...existingVolumes, newVolume];

      // Add volume mounts to container
      if (deployment.spec.template.spec.containers?.[0]) {
        const container = deployment.spec.template.spec.containers[0];
        const newVolumeMounts: k8s.V1VolumeMount[] = mountedSecrets.map(
          ({ key }) => ({
            name: "mounted-secrets",
            mountPath: `/secrets/${key}`,
            subPath: key,
            readOnly: true,
          }),
        );

        // Filter out existing mounts at paths we're about to add to avoid duplicates
        const newMountPaths = new Set(newVolumeMounts.map((m) => m.mountPath));
        const existingMounts = (container.volumeMounts || []).filter(
          (m) => !newMountPaths.has(m.mountPath),
        );

        container.volumeMounts = [...existingMounts, ...newVolumeMounts];
      }
    }

    // 6. Merge environment variables (YAML env vars + system env vars)
    // Also filter out archestra-managed secretKeyRef entries for keys that don't have values
    if (deployment.spec?.template?.spec?.containers?.[0]) {
      const container = deployment.spec.template.spec.containers[0];

      // Build a set of valid secret keys (secrets that have values and will be in K8s Secret)
      const validSecretKeys = new Set<string>();
      for (const e of envVars) {
        const secretKey = e.valueFrom?.secretKeyRef?.key;
        if (secretKey) {
          validSecretKeys.add(secretKey);
        }
      }

      // Filter YAML env vars to remove archestra-managed secretKeyRef entries for keys without values.
      // Only filter entries that reference the archestra-managed K8s Secret — preserve user-added
      // secretKeyRef entries that reference other secrets (e.g., ExternalSecrets, manually created secrets).
      // This prevents "couldn't find key X in Secret" errors when archestra-managed secrets are optional/empty.
      if (container.env) {
        container.env = container.env.filter((envVar) => {
          // Keep all non-secretKeyRef env vars
          if (!envVar.valueFrom?.secretKeyRef) {
            return true;
          }
          // Keep secretKeyRef entries that reference a different secret (user-managed)
          if (envVar.valueFrom.secretKeyRef.name !== k8sSecretName) {
            return true;
          }
          // Only keep archestra-managed secretKeyRef if the key will be in the K8s Secret
          const secretKey = envVar.valueFrom.secretKeyRef.key;
          return secretKey && validSecretKeys.has(secretKey);
        });
      }

      // Add system env vars that are not already defined in YAML
      const existingEnvNames = new Set(
        (container.env || []).map((e) => e.name),
      );
      for (const envVar of envVars) {
        if (!existingEnvNames.has(envVar.name)) {
          container.env = [...(container.env || []), envVar];
        }
      }
    }

    // 6b. Apply envFrom (existing K8s Secrets/ConfigMaps) if not already in YAML
    if (
      localConfig.envFrom?.length &&
      deployment.spec?.template?.spec?.containers?.[0]
    ) {
      const container = deployment.spec.template.spec.containers[0];
      const existingEnvFrom = container.envFrom || [];
      const existingKeys = new Set(
        existingEnvFrom.map((e) =>
          e.secretRef?.name
            ? `secret:${e.secretRef.name}`
            : `configMap:${e.configMapRef?.name ?? ""}`,
        ),
      );
      const newEnvFrom = localConfig.envFrom
        .filter((ref) => !existingKeys.has(`${ref.type}:${ref.name}`))
        .map((ref) => ({
          ...(ref.type === "secret"
            ? { secretRef: { name: ref.name } }
            : { configMapRef: { name: ref.name } }),
          ...(ref.prefix ? { prefix: ref.prefix } : {}),
        }));
      container.envFrom = [...existingEnvFrom, ...newEnvFrom];
    }

    // 7. Ensure command and args from localConfig are applied
    if (deployment.spec?.template?.spec?.containers?.[0]) {
      const container = deployment.spec.template.spec.containers[0];

      if (localConfig.command && !container.command) {
        container.command = [localConfig.command];
      }

      if (localConfig.arguments && localConfig.arguments.length > 0) {
        // Process arguments with placeholder replacement
        const processedArgs = localConfig.arguments.map((arg) => {
          if (this.environmentValues || this.userConfigValues) {
            return arg.replace(
              /\$\{user_config\.([^}]+)\}/g,
              (match, configKey) => {
                return (
                  this.environmentValues?.[configKey] ||
                  this.userConfigValues?.[configKey] ||
                  match
                );
              },
            );
          }
          return arg;
        });

        if (!container.args || container.args.length === 0) {
          container.args = processedArgs;
        }
      }
    }

    // 8. Set transport-specific container settings (stdin/tty for stdio, ports for HTTP)
    if (deployment.spec?.template?.spec?.containers?.[0]) {
      const container = deployment.spec.template.spec.containers[0];

      if (needsHttp) {
        // HTTP transport: expose port if not already defined
        if (!container.ports || container.ports.length === 0) {
          container.ports = [
            {
              containerPort: httpPort,
              protocol: "TCP",
            },
          ];
        }
        // Custom YAML may tune any probe explicitly. Fill only missing probes
        // so every managed HTTP workload gets the transport-level defaults
        // without overriding an operator's health contract.
        const defaultProbes = buildHttpTcpProbes(httpPort);
        container.startupProbe ??= defaultProbes.startupProbe;
        container.readinessProbe ??= defaultProbes.readinessProbe;
        container.livenessProbe ??= defaultProbes.livenessProbe;
      } else {
        // Stdio transport: enable stdin for JSON-RPC communication
        if (container.stdin === undefined) {
          container.stdin = true;
        }
        if (container.tty === undefined) {
          container.tty = false;
        }
      }
    }

    // 9. imagePullPolicy: an explicit YAML value wins, like every other field
    // in this merge — advanced YAML exists so an operator can pin a pod spec we
    // would not generate, and which registry round-trips a pod makes is theirs
    // to decide. The system only fills the field in when the YAML leaves it
    // unset, which is also what keeps the `Never` guard on bare local images.
    // The one exception is a refresh-image request: that is an explicit admin
    // action asking for the current image right now, and on a YAML frozen at
    // `IfNotPresent` it is the only route to one. It applies to that single
    // rollout, then the author's value governs again. On a bare local image
    // that rollout writes `Never` rather than `Always`, because there is no
    // registry to fetch a fresher image from; the request is still consumed so
    // it cannot leak into a later rollout.
    if (deployment.spec?.template?.spec?.containers?.[0]) {
      const container = deployment.spec.template.spec.containers[0];
      const forceFreshPull = this.consumeFreshImagePullRequest();
      if (forceFreshPull || !container.imagePullPolicy) {
        container.imagePullPolicy = getMcpImagePullPolicy(
          container.image || dockerImage,
          { forceFreshPull },
        );
      }
    }

    logger.info(
      { mcpServerId: this.mcpServer.id },
      "Generated deployment spec from YAML override",
    );

    return deployment;
  }

  /**
   * Rewrite localhost URLs to host.docker.internal for Docker Desktop Kubernetes.
   * This allows deployment pods to access services running on the host machine.
   *
   * Note: This assumes Docker Desktop. Other local K8s environments may need different
   * hostnames (e.g., host.minikube.internal for Minikube, or host-gateway for kind).
   */
  private rewriteLocalhostUrl(value: string): string {
    try {
      const url = new URL(value);
      const isHttp = url.protocol === "http:" || url.protocol === "https:";
      if (!isHttp) {
        return value;
      }
      if (
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "::1"
      ) {
        url.hostname = "host.docker.internal";
        logger.info(
          {
            mcpServerId: this.mcpServer.id,
            originalUrl: value,
            rewrittenUrl: url.toString(),
          },
          "Rewrote localhost URL to host.docker.internal for K8s pod",
        );
        return url.toString();
      }
    } catch {
      // Not a valid URL, return as-is
    }
    return value;
  }

  /**
   * Create environment variables for the container
   *
   * This method processes environment variables from the local config and ensures
   * that values are properly formatted. It strips surrounding quotes (both single
   * and double) from values, as they are often used as delimiters in the UI but
   * should not be part of the actual environment variable value.
   *
   * Additionally, it merges environment values passed from the frontend (for secrets
   * and user-provided values) with the catalog's plain text environment variables.
   *
   * For environment variables marked as "secret" type in the catalog, this method
   * will use valueFrom.secretKeyRef to reference the Kubernetes Secret instead of
   * including the value directly in the pod spec.
   *
   * For secrets marked with "mounted: true", they will be skipped from env vars
   * and instead returned in mountedSecrets array for volume mounting.
   *
   * For Docker Desktop Kubernetes environments, localhost URLs are automatically
   * rewritten to host.docker.internal to allow pods to access services on the host.
   */
  createContainerEnvFromConfig(): ContainerEnvResult {
    const env: k8s.V1EnvVar[] = [];
    const envMap = new Map<string, string>();
    const secretEnvVars = new Set<string>();
    const mountedSecretKeys = new Set<string>();

    // Process all environment variables from catalog
    if (this.catalogItem?.localConfig?.environment) {
      for (const envDef of this.catalogItem.localConfig.environment) {
        // Track secret-type env vars
        if (envDef.type === "secret") {
          secretEnvVars.add(envDef.key);
          // Track mounted secrets (only applicable to secret type)
          if (envDef.mounted) {
            mountedSecretKeys.add(envDef.key);
          }
        }

        // Add env var value to envMap based on prompting behavior
        // Note: Values may be booleans/numbers at runtime despite type annotations, so we convert to string
        let value: string | undefined;
        if (envDef.promptOnInstallation) {
          // Value supplied via the install request (install-time input) —
          // read from environmentValues.
          const rawValue = this.environmentValues?.[envDef.key];
          value = rawValue != null ? String(rawValue) : undefined;
        } else {
          // Static value from catalog - get from envDef.value
          value = envDef.value != null ? String(envDef.value) : undefined;

          // Interpolate ${user_config.xxx} placeholders with actual values
          // Use environmentValues first (for internal catalog), fallback to userConfigValues (for external catalog)
          if (value && (this.environmentValues || this.userConfigValues)) {
            value = value.replace(
              /\$\{user_config\.([^}]+)\}/g,
              (match, configKey) => {
                const configValue =
                  this.environmentValues?.[configKey] ??
                  this.userConfigValues?.[configKey];
                return configValue != null ? String(configValue) : match;
              },
            );
          }
        }
        // Add to envMap if value exists, OR if it's a secret-type (needs secretKeyRef even without value)
        // Secret-type vars will reference K8s Secret via secretKeyRef, plain_text vars use value directly
        if (value || envDef.type === "secret") {
          envMap.set(envDef.key, value || "");
        }
      }
    } else if (this.environmentValues) {
      // Fallback: If no catalog item but environmentValues provided,
      // process them directly (backward compatibility for tests and direct usage)
      Object.entries(this.environmentValues).forEach(([key, value]) => {
        envMap.set(key, value != null ? String(value) : "");
      });
    }

    // Add user config values as environment variables
    if (this.userConfigValues) {
      Object.entries(this.userConfigValues).forEach(([key, value]) => {
        // Convert to uppercase with underscores for environment variable convention
        const envKey = key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
        envMap.set(envKey, value != null ? String(value) : "");
      });
    }

    // Track mounted secrets for volume mounting
    const mountedSecrets: Array<{ key: string }> = [];

    // Convert map to k8s env vars, using conditional logic for secrets
    envMap.forEach((value, key) => {
      // If this is a mounted secret, skip env var injection - will be volume mounted
      if (mountedSecretKeys.has(key)) {
        if (value && value.trim() !== "") {
          mountedSecrets.push({ key });
        }
        return;
      }

      // If this env var is marked as "secret" type, use valueFrom.secretKeyRef
      if (secretEnvVars.has(key)) {
        // Skip secret-type env vars with empty values (no K8s Secret will be created)
        if (!value || value.trim() === "") {
          return;
        }
        const k8sSecretName = this.getK8sSecretName();
        env.push({
          name: key,
          valueFrom: {
            secretKeyRef: {
              name: k8sSecretName,
              key: key,
            },
          },
        });
      } else {
        // For plain text env vars, use value directly
        let processedValue = String(value);

        // Strip surrounding quotes (both single and double)
        // Users may enter values like: API_KEY='my value' or API_KEY="my value"
        // We want to extract the actual value without the quotes
        // Only strip if the value has length > 1 to avoid stripping single quote chars
        if (
          processedValue.length > 1 &&
          ((processedValue.startsWith("'") && processedValue.endsWith("'")) ||
            (processedValue.startsWith('"') && processedValue.endsWith('"')))
        ) {
          processedValue = processedValue.slice(1, -1);
        }

        // Rewrite localhost URLs to host.docker.internal for Docker Desktop K8s
        // Only when backend is running on host machine (connecting to K8s from outside)
        // When backend runs inside cluster, pods shouldn't access host services
        if (!config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster) {
          processedValue = this.rewriteLocalhostUrl(processedValue);
        }

        env.push({
          name: key,
          value: processedValue,
        });
      }
    });

    return { envVars: env, mountedSecrets };
  }

  /**
   * Resolve the HTTP endpoint URL for streamable-http servers.
   * Called by the manager after lazy-loading a deployment on a different replica.
   */
  async resolveHttpEndpoint(): Promise<void> {
    await this.ensureHttpServerConfigured();
  }

  /**
   * Ensure HTTP server configuration (Service and URL) is set up
   */
  private async ensureHttpServerConfigured(): Promise<void> {
    const needsHttp = await this.needsHttpPort();
    if (!needsHttp) {
      return;
    }

    const catalogItem = await this.getCatalogItem();
    const httpPort = catalogItem?.localConfig?.httpPort || 8080;
    const httpPath = catalogItem?.localConfig?.httpPath || "/mcp";
    const configuredNodePort = catalogItem?.localConfig?.nodePort;

    // Ensure Service exists (pass fixed nodePort if configured)
    await this.createServiceForHttpServer(httpPort, configuredNodePort);

    // Resolve HTTP Endpoint URL
    let baseUrl: string;
    if (config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster) {
      // In-cluster: use service DNS name
      const serviceName = this.constructHttpServiceName();
      baseUrl = `http://${serviceName}.${this.namespace}.svc.${config.orchestrator.kubernetes.clusterDomain}:${httpPort}`;
    } else if (configuredNodePort) {
      // Local dev with fixed nodePort: use it directly (no need to read from service)
      baseUrl = `http://${config.orchestrator.kubernetes.k8sNodeHost || "localhost"}:${configuredNodePort}`;
    } else {
      // Local dev: get NodePort from service
      const serviceName = this.constructHttpServiceName();
      try {
        const service = await this.k8sApi.readNamespacedService({
          name: serviceName,
          namespace: this.namespace,
        });

        const nodePort = service.spec?.ports?.[0]?.nodePort;
        if (!nodePort) {
          throw new Error(`Service ${serviceName} has no NodePort assigned`);
        }

        baseUrl = `http://${config.orchestrator.kubernetes.k8sNodeHost || "localhost"}:${nodePort}`;
      } catch (error) {
        logger.error(
          { err: error },
          `Could not resolve NodePort for service ${serviceName}`,
        );
        return;
      }
    }

    // Set the endpoint URL
    this.httpEndpointUrl = `${baseUrl}${httpPath}`;

    logger.info(
      `HTTP endpoint URL for ${this.deploymentName}: ${this.httpEndpointUrl}`,
    );
  }

  /**
   * Create or start the deployment for this MCP server
   */
  async startOrCreateDeployment(
    resolvedImagePullSecretNames?: Array<{ name: string }>,
    lifecycle?: LifecycleMutationOptions,
  ): Promise<void> {
    const mutate = lifecycle?.runFencedMutation ?? (async (fn) => fn());
    try {
      await lifecycle?.assertOwned?.();
      // Load the catalog item up front so every path below derives the pod
      // selector from the correct id — the drift check and the reconcile branches'
      // policy apply both key on catalogItem.multitenant (getPodSelectorServerId),
      // and would otherwise select a multitenant pod's per-install id and leave it
      // under the deny-all baseline. getCatalogItem caches, so later calls reuse it.
      await this.getCatalogItem();

      /**
       * MIGRATION STEP:
       * Check if there's a bare pod with the same name.
       * If it exists and is not controlled by a ReplicaSet, delete it.
       */
      try {
        const existingPod = await this.k8sApi.readNamespacedPod({
          name: this.deploymentName,
          namespace: this.namespace,
        });

        // Check if it's a bare pod (no owner references or owner is not a ReplicaSet)
        const isBarePod =
          !existingPod.metadata?.ownerReferences ||
          existingPod.metadata.ownerReferences.length === 0 ||
          !existingPod.metadata.ownerReferences.some(
            (ref) => ref.kind === "ReplicaSet",
          );

        if (isBarePod) {
          logger.info(
            `Found legacy bare pod ${this.deploymentName}, deleting for migration to Deployment`,
          );
          const uid = existingPod.metadata?.uid;
          if (!uid) {
            throw new Error(
              `Refusing to delete legacy pod ${this.deploymentName} without a UID precondition`,
            );
          }
          await lifecycle?.assertOwned?.();
          await mutate(() =>
            this.k8sApi.deleteNamespacedPod({
              name: this.deploymentName,
              namespace: this.namespace,
              body: { preconditions: { uid } },
            }),
          );
        }
      } catch (error: unknown) {
        // Ignore 404, propagate others
        if (!isK8sNotFoundError(error)) {
          logger.warn(
            { err: error },
            `Error checking for legacy pod ${this.deploymentName}`,
          );
        }
      }

      // Check if deployment already exists. Retried on 429/5xx: at startup
      // every install reconciles at once, and an API server throttling that
      // burst (API Priority & Fairness) must not make an existing healthy
      // deployment look broken.
      try {
        const existingDeployment = await withK8sApiRetry(
          () =>
            this.k8sAppsApi.readNamespacedDeployment({
              name: this.deploymentName,
              namespace: this.namespace,
            }),
          { label: `readNamespacedDeployment ${this.deploymentName}` },
        );
        await lifecycle?.assertOwned?.();
        await this.adoptRuntimeOwner(existingDeployment);

        // SELF-HEAL: a Deployment created before the catalog-stable selector fix
        // (#6340) still labels its pods with the per-install `mcpServer.id`, while
        // the shared Service's selector is now reconciled to the catalog-stable id
        // (getPodSelectorServerId). For multitenant catalogs those differ, so the
        // Service selects zero pods, has no Endpoints, and every connect/read fails
        // with ECONNREFUSED ("fetch failed"). A Deployment's `spec.selector` is
        // immutable, so the only way to realign the pod labels is delete+recreate.
        const existingSelectorId =
          existingDeployment.spec?.selector?.matchLabels?.["mcp-server-id"];
        const desiredSelectorId = this.getSystemLabels()["mcp-server-id"];
        if (existingSelectorId && existingSelectorId !== desiredSelectorId) {
          logger.warn(
            {
              deploymentName: this.deploymentName,
              existingSelectorId,
              desiredSelectorId,
            },
            `Deployment ${this.deploymentName} has a stale mcp-server-id selector; ` +
              "recreating it so its pod labels match the Service selector",
          );
          await lifecycle?.assertOwned?.();
          await mutate(() =>
            this.stopDeployment({
              uidPrecondition: existingDeployment.metadata?.uid ?? true,
            }),
          );
          await this.waitForDeploymentAbsent();
          // Recreate from scratch with the correct catalog-stable pod labels.
          return this.startOrCreateDeployment(
            resolvedImagePullSecretNames,
            lifecycle,
          );
        }

        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        // ADOPTION: a deployment we hibernated (scaled to 0 with our
        // annotation) is intact and intentionally idle. Adopt it as
        // "hibernated" — don't treat it as a pending start, don't recreate
        // it, and don't scale it up; the idle-hibernation manager wakes it on
        // demand. The egress policy and HTTP Service are still reconciled so
        // a later wake only needs to scale up (the pod starts confined).
        if (
          existingDeployment.spec?.replicas === 0 &&
          K8sDeployment.hasHibernationAnnotation(existingDeployment)
        ) {
          await lifecycle?.assertOwned?.();
          await mutate(() => this.applyK8sNetworkPolicy());
          await lifecycle?.assertOwned?.();
          await mutate(() => this.ensureHttpServerConfigured());
          // Cluster fact, recorded before either branch below: this is a
          // deployment we are holding asleep. Recording it first is also what
          // makes the beginWake below a legal `hibernated → waking` move
          // rather than an action out of a never-confirmed state.
          if (this.observeState("hibernated")) {
            this.errorMessage = null;
          }
          if (
            config.orchestrator.mcpIdleHibernation.betaEnabled &&
            !config.orchestrator.mcpIdleHibernation.hardDisabled
          ) {
            logger.info(
              `Deployment ${this.deploymentName} is hibernated — adopted without scaling up`,
            );
            return;
          }
          // The operator's kill switch (…MCP_IDLE_HIBERNATION_SECONDS=0) is
          // set, or the beta flag that offers the feature is off. Leaving the
          // deployment asleep would strand it: no sweeper runs, so only a
          // tool call would ever wake it. Deployment-level off means "always
          // on", so scale it back up here and let the periodic refresh
          // complete the wake once it reports available replicas.
          // (An org toggle that is merely OFF is deliberately NOT enough to
          // force a wake: nothing new gets hibernated, and ensureAwake still
          // wakes what is asleep on the next call that needs it.)
          await this.beginWake({
            runFencedMutation: lifecycle?.runFencedMutation,
          });
          logger.info(
            `Deployment ${this.deploymentName} was hibernated but idle hibernation is disabled — scaling it back up`,
          );
          return;
        }
        // SPDX-SnippetEnd

        if (existingDeployment.status?.availableReplicas) {
          this.observeState("running");

          // For running deployments, we need to find the pod to assign HTTP port
          const pod = await this.findPodForDeployment();
          if (pod) {
            await this.assignHttpPortIfNeeded(pod);
          }

          // Reconcile the egress policy before HTTP config, so a slow or failing
          // Service setup can't skip (re)applying the pod's policy.
          await lifecycle?.assertOwned?.();
          await mutate(() => this.applyK8sNetworkPolicy());
          await lifecycle?.assertOwned?.();
          await mutate(() => this.ensureHttpServerConfigured());

          logger.info(`Deployment ${this.deploymentName} is already running`);
          return;
        }

        // Deployment exists but is not ready — check if pods are in a failure state
        logger.info(
          `Deployment ${this.deploymentName} exists but is not yet ready`,
        );

        // Check pod container statuses for failure states (e.g. CrashLoopBackOff)
        const failureCheck = await this.checkPodContainerStatusesForFailure();
        if (failureCheck.hasFailed && !failureCheck.isTransientImagePull) {
          if (this.observeState("failed")) {
            this.errorMessage = failureCheck.message;
          }
          logger.warn(
            `Deployment ${this.deploymentName} is in a failure state: ${failureCheck.message}`,
          );
        } else {
          let adopted: McpDeploymentState = "pending";
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          // A deployment scaled back up but still carrying the hibernation
          // annotation is mid-wake (the annotation only drops once it is
          // verifiably up), so adopt it as "waking" rather than as a cold
          // start. Otherwise the ordinary state remains "pending" — including
          // image pull errors, which the kubelet retries on its own.
          if (K8sDeployment.hasHibernationAnnotation(existingDeployment)) {
            adopted = "waking";
          }
          // SPDX-SnippetEnd
          if (this.observeState(adopted)) {
            this.errorMessage = failureCheck.isTransientImagePull
              ? failureCheck.message
              : null;
          }
          if (failureCheck.isTransientImagePull) {
            logger.info(
              `Deployment ${this.deploymentName} is waiting on an image pull (kubelet will retry): ${failureCheck.message}`,
            );
          }
        }

        // Reconcile the egress policy before HTTP config, so a slow or failing
        // Service setup can't leave an already-created (still not-ready) pod under
        // the deny-all baseline alone.
        await lifecycle?.assertOwned?.();
        await mutate(() => this.applyK8sNetworkPolicy());
        // Even if pending/failed, ensure HTTP configuration (Service + URL) is set up
        await lifecycle?.assertOwned?.();
        await mutate(() => this.ensureHttpServerConfigured());
        return;
      } catch (error: unknown) {
        // Deployment doesn't exist, we'll create it below
        if (!isK8sNotFoundError(error)) {
          throw error;
        }
        // 404 means deployment doesn't exist
      }

      // Get catalog item to get local config
      const catalogItem = await this.getCatalogItem();

      if (!catalogItem?.localConfig) {
        throw new Error(
          `Local config not found for MCP server ${this.mcpServer.name}`,
        );
      }

      // Create new deployment
      logger.info(
        `Creating deployment ${this.deploymentName} for MCP server ${this.mcpServer.name}`,
      );

      this.observeState("pending");

      // Use custom Docker image if provided
      const dockerImage =
        catalogItem.localConfig.dockerImage || mcpServerBaseImage;
      logger.info(`Using Docker image: ${dockerImage}`);

      // Check if HTTP port is needed
      const needsHttp = await this.needsHttpPort();
      const httpPort = catalogItem.localConfig.httpPort || 8080;

      // Normalize localConfig to ensure fields have defaults
      const normalizedLocalConfig = {
        ...catalogItem.localConfig,
        environment: catalogItem.localConfig.environment?.map((env) => ({
          ...env,
          required: env.required ?? false,
          description: env.description ?? "",
        })),
      };

      // Get the cached nodeSelector and tolerations from the platform pod (if available)
      // This allows MCP servers to inherit the same scheduling constraints
      const platformNodeSelector = getCachedPlatformNodeSelector();
      const platformTolerations = getCachedPlatformTolerations();

      // Create the pod's egress policy before the pod itself, so the pod is
      // confined the instant it starts. A pod that starts before its policy lands
      // is selected only by the namespace deny-all baseline — no DNS, no egress —
      // long enough to fail startup name resolution/connectivity and crashloop.
      // The policy selects the pod by label, so creating it first is inert until
      // the pod appears, then takes effect immediately.
      await lifecycle?.assertOwned?.();
      await mutate(() => this.applyK8sNetworkPolicy());

      try {
        const deploymentSpec = await this.withRuntimeOwnerReference(
          this.generateDeploymentSpec(
            dockerImage,
            normalizedLocalConfig,
            needsHttp,
            httpPort,
            platformNodeSelector,
            platformTolerations,
            resolvedImagePullSecretNames,
          ),
        );
        await lifecycle?.assertOwned?.();
        await mutate(() =>
          this.k8sAppsApi.createNamespacedDeployment({
            namespace: this.namespace,
            body: deploymentSpec,
          }),
        );
        logger.info(`Deployment ${this.deploymentName} created`);
      } catch (createError) {
        // A concurrent reconcile (e.g. another orchestrator replica that also saw
        // the deployment absent) may have created it between our 404 read and this
        // call. Re-enter the reconcile so the now-existing deployment is re-read and
        // validated — a matching one reconciles normally, a stale per-install
        // selector is self-healed via delete+recreate — rather than assuming the
        // concurrently-created workload is correct and leaving its Service without
        // endpoints.
        if (!isK8sConflictError(createError)) {
          throw createError;
        }
        logger.info(
          `Deployment ${this.deploymentName} was created concurrently; re-reconciling`,
        );
        return this.startOrCreateDeployment(
          resolvedImagePullSecretNames,
          lifecycle,
        );
      }

      // Ensure HTTP configuration is set up
      await lifecycle?.assertOwned?.();
      await mutate(() => this.ensureHttpServerConfigured());

      // Note: assignedHttpPort is set asynchronously in findPodForDeployment during status checks
      // State is "pending" until waitForDeploymentReady confirms the deployment has available replicas
      this.observeState("pending");
      logger.info(`Deployment ${this.deploymentName} initiated`);
    } catch (error: unknown) {
      // A throttled/unavailable API server (429/5xx) says nothing about the
      // workload — an already-running pod is most likely still healthy. Stay
      // "pending" so the periodic status refresh re-reads the real state,
      // instead of latching a terminal "failed" that sticks until a manual
      // restart.
      this.observeState(isTransientK8sApiError(error) ? "pending" : "failed");
      this.errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(
        { err: error },
        `Failed to start deployment ${this.deploymentName}:`,
      );
      throw error;
    }
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * Hibernate this deployment: scale it to 0 replicas and mark it with the
   * hibernation annotation in a single merge patch, so the two can never be
   * observed out of sync. Uses a plain deployment patch, NOT the
   * `deployments/scale` subresource — RBAC only grants patch on deployments.
   * K8s errors propagate to the caller (the idle-hibernation manager).
   *
   * The result says whether THIS call put the deployment to sleep, and if
   * not, why. `hibernated: false` means the scale-to-zero never happened —
   * and the caller must not run the teardown that follows a real hibernate
   * (dropping pooled connections for a pod that is still serving would fail
   * live calls).
   */
  async hibernate(
    options?: LifecycleMutationOptions,
  ): Promise<HibernateResult> {
    const generation = ++this.stateGeneration;

    // What we scaled down FROM, remembered so a failed hibernate can put it
    // back. Read off the same object the write was built from.
    let priorReplicas = 1;

    let outcome: TransitionWriteOutcome;
    try {
      outcome = await this.transitionWrite({
        generation,
        label: "hibernate",
        maxAttempts: 1,
        // Only ever sleep a deployment that is awake and unclaimed. This
        // rejects both the mid-wake shape and somebody else's zero, however
        // the object got there between the decision and this write.
        expect: (live) =>
          (live.spec?.replicas ?? 0) >= 1 &&
          !K8sDeployment.hasHibernationAnnotation(live),
        body: (live) => {
          priorReplicas = Math.max(live.spec?.replicas ?? 0, 1);
          return {
            metadata: {
              annotations: {
                [MCP_HIBERNATED_ANNOTATION]: "true",
                [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]:
                  String(priorReplicas),
              },
            },
            spec: { replicas: 0 },
          };
        },
        // An admission webhook that strips unknown annotations while honouring
        // the spec would leave this deployment at zero replicas with no
        // ownership marker — indistinguishable from an operator's own zero,
        // which nothing is allowed to wake. Refuse to call that a hibernate.
        survived: (applied) =>
          (applied.spec?.replicas ?? 0) === 0 &&
          K8sDeployment.hasHibernationAnnotation(applied) &&
          Number.parseInt(
            applied.metadata?.annotations?.[
              MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION
            ] ?? "",
            10,
          ) === priorReplicas,
        runFencedMutation: options?.runFencedMutation,
      });
    } catch (error) {
      // The patch may or may not have committed (e.g. a timeout after the
      // apply landed) — best-effort converge the cached state with whatever
      // the cluster actually holds instead of guessing.
      await this.refreshState().catch((refreshError) => {
        logger.warn(
          { err: refreshError },
          `Failed to refresh state for ${this.deploymentName} after a hibernate patch error`,
        );
      });
      throw error;
    }

    if (outcome.status !== "applied") {
      if (
        outcome.status === "not-persisted" ||
        outcome.status === "unconfirmed"
      ) {
        // not-persisted: the scale-to-zero landed but the marker did not, so
        // right now this deployment is an orphan: at zero replicas with
        // nothing claiming it, which I1 forbids anything from ever waking.
        // unconfirmed: the response did not carry the marker and the cluster
        // could not be re-read — the same orphan may exist, unwitnessed.
        // Detecting either is not enough — put the replicas back.
        //
        // The restore is a shape-checked write like every other, NOT a blind
        // one. `expect` matches only the orphan we just made, so if the write
        // actually did persist — or an operator or a controller has since
        // taken the object over — we leave it alone rather than fighting
        // them; losing is logged and accepted.
        this.errorMessage =
          outcome.status === "not-persisted"
            ? "Hibernation could not mark this deployment as Archestra-owned; the cluster removed the annotation."
            : "Hibernation could not be confirmed against the cluster; the deployment may be scaled to zero without its ownership marker.";
        const restored = await this.transitionWrite({
          generation,
          label: "hibernate-abort",
          expect: (live) =>
            (live.spec?.replicas ?? 0) === 0 &&
            !K8sDeployment.hasHibernationAnnotation(live),
          body: () => ({ spec: { replicas: priorReplicas } }),
          survived: (applied) => (applied.spec?.replicas ?? 0) >= 1,
          runFencedMutation: options?.runFencedMutation,
          maxAttempts: 1,
        }).catch(() => null);
        if (restored?.status !== "applied") {
          logger.error(
            { deploymentName: this.deploymentName },
            "Could not undo a hibernate whose ownership marker was stripped; the deployment is left scaled to zero",
          );
        }
        await this.refreshState().catch(() => {});
        return { hibernated: false, reason: "conflict" };
      }
      if (outcome.status === "lost-race") {
        return { hibernated: false, reason: "conflict" };
      }

      // Refused because the object was not what the decision assumed. The
      // fresh read that refused it is the best evidence available, so classify
      // from that rather than reading again.
      const live = outcome.live;
      if (!live) return { hibernated: false, reason: "conflict" };
      const replicas = live.spec?.replicas ?? 0;
      const ours = K8sDeployment.hasHibernationAnnotation(live);

      if (replicas === 0 && ours) {
        // Already asleep — here or on another replica. A legal no-op, and the
        // cached state must converge on it: this is a positive observation of
        // cluster truth, not doubt.
        if (this.observeState("hibernated")) {
          this.errorMessage = null;
          this.runningMissCount = 0;
          this.clearCachedPodTelemetry();
        }
        return { hibernated: false, reason: "already-hibernated" };
      }
      if (replicas === 0) {
        // Somebody else's zero. Never claimed, never woken (I1).
        logger.debug(
          { deploymentName: this.deploymentName },
          "Skipping MCP hibernate: the deployment is already at 0 replicas without our annotation",
        );
        return { hibernated: false, reason: "not-ours" };
      }
      if (ours) {
        // Our marker with replicas up is a wake in progress. Scaling it down
        // would kill the pod that wake just started and would license the
        // teardown that follows a real hibernate.
        logger.debug(
          { deploymentName: this.deploymentName },
          "Skipping MCP hibernate: the deployment is waking (our annotation, replicas up)",
        );
        return { hibernated: false, reason: "waking" };
      }
      return { hibernated: false, reason: "conflict" };
    }
    if (
      this.transitionAction("hibernated", "scaled to 0 replicas for idleness")
    ) {
      this.errorMessage = null;
      this.runningMissCount = 0;
    }
    // The pod is gone — statusSummary must not keep reporting its name, age,
    // or restart count as if it still existed. Unconditional: the scale-to-0
    // patch committed whatever the cached state was allowed to become.
    this.clearCachedPodTelemetry();
    logger.info(`Deployment ${this.deploymentName} hibernated (scaled to 0)`);
    return { hibernated: true };
  }

  /**
   * Begin waking a hibernated deployment: scale it back to its recorded
   * pre-hibernation replica count (default 1). The hibernation annotations
   * deliberately stay until readiness — replicas >= 1 with the annotation
   * still present means "waking". The manager waits via
   * waitForDeploymentReady, then calls {@link completeWake}.
   */
  async beginWake(options?: LifecycleMutationOptions): Promise<void> {
    const generation = ++this.stateGeneration;

    let replicas = 1;
    const outcome = await this.transitionWrite({
      generation,
      label: "beginWake",
      // Only ever scale up a deployment that is still OURS and still ASLEEP.
      // The old code re-read on a 409 and checked exactly this — but only on
      // the retry path, so when the compare-and-swap SUCCEEDED the check never
      // ran and a stale wake silently resized a healthy multi-replica
      // deployment down to the `?? 1` fallback. Atomicity was never the
      // missing guarantee here; validity was.
      expect: (live) =>
        (live.spec?.replicas ?? 0) === 0 &&
        K8sDeployment.hasHibernationAnnotation(live),
      body: (live) => {
        replicas = K8sDeployment.recordedPreHibernationReplicas(live);
        return { spec: { replicas } };
      },
      // The annotations deliberately stay until readiness, so the only claim
      // this write makes is the replica count.
      survived: (applied) => (applied.spec?.replicas ?? 0) >= 1,
      runFencedMutation: options?.runFencedMutation,
    });

    if (outcome.status !== "applied") {
      // Another replica is already waking it, an operator took it over, or the
      // attempt was superseded. Scaling it a second time would fight them:
      // converge on cluster truth and let the caller's readiness wait ride
      // along with the wake already in progress.
      await this.refreshStateAfterLostWakeRace();
      return;
    }

    this.transitionAction("waking", `scaled to ${replicas} to wake`);
    logger.info(
      `Deployment ${this.deploymentName} waking (scaled to ${replicas})`,
    );
  }

  /**
   * Finish waking: remove both hibernation annotations (a merge-patch null
   * deletes the key) once the manager has confirmed the deployment is ready.
   *
   * Returns the state this deployment actually converged to: "running" when
   * the annotations were dropped, or whatever cluster truth the refresh
   * derived after the write lost its CAS — an operator re-zeroing the
   * still-annotated object between readiness and this call is the ordinary
   * way that happens. Callers must treat anything but "running" as a wake
   * that did NOT complete.
   */
  async completeWake(
    options?: LifecycleMutationOptions,
  ): Promise<McpDeploymentState> {
    const generation = ++this.stateGeneration;

    // This write used to go out unconditionally, justified as "deleting two
    // annotation keys is idempotent and commutes with every other write". The
    // keys do commute as merge OPERATIONS; they do not commute as STATE. The
    // marker is an ownership token whose meaning is bound to spec.replicas, so
    // deleting half of that pair is only idempotent while the other half has
    // not moved. Land this on top of a concurrent hibernate and the result is
    // `replicas: 0` with no marker — indistinguishable from a Deployment an
    // operator zeroed deliberately, which I1 forbids anyone from waking. That
    // server is then dead until a human intervenes, and the caller was told
    // its wake succeeded.
    const outcome = await this.transitionWrite({
      generation,
      label: "completeWake",
      // Only finish a wake that is still ours and still scaled up.
      expect: (live) =>
        K8sDeployment.hasHibernationAnnotation(live) &&
        (live.spec?.replicas ?? 0) >= 1 &&
        (live.status?.availableReplicas ?? 0) >= 1 &&
        (live.status?.readyReplicas ?? 0) >= 1,
      body: () => ({
        metadata: {
          annotations: {
            [MCP_HIBERNATED_ANNOTATION]: null,
            [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: null,
          },
        },
      }),
      survived: (applied) =>
        !K8sDeployment.hasHibernationAnnotation(applied) &&
        (applied.status?.availableReplicas ?? 0) >= 1 &&
        (applied.status?.readyReplicas ?? 0) >= 1,
      runFencedMutation: options?.runFencedMutation,
      // Abandon rather than force. Giving up leaves `marker + replicas >= 1`,
      // which deriveDeploymentState already calls a finish-wake and the
      // periodic refresh already repairs — and which the sweeper is documented
      // never to touch. Retrying towards a deployment that has since been
      // re-slept is one edit away from re-creating the orphan above.
      maxAttempts: 1,
    });

    if (outcome.status !== "applied") {
      // Converge on whatever the cluster actually holds instead of asserting a
      // transition that did not happen — and report THAT, so the caller
      // decides from the observation rather than assuming success.
      await this.refreshStateAfterLostWakeRace();
      return this.state;
    }

    this.transitionAction("running", "wake confirmed and annotations dropped");
    logger.info(`Deployment ${this.deploymentName} woke up`);
    return this.state;
  }

  /** Persist that another controller owns this Deployment's replica count. */
  async markForeignReplicaOwner(
    options?: LifecycleMutationOptions,
  ): Promise<boolean> {
    const generation = ++this.stateGeneration;
    const outcome = await this.transitionWrite({
      generation,
      label: "markForeignReplicaOwner",
      expect: (live) => (live.spec?.replicas ?? 0) >= 1,
      body: () => ({
        metadata: {
          annotations: { [MCP_FOREIGN_REPLICA_OWNER_ANNOTATION]: "true" },
        },
      }),
      survived: (applied) =>
        K8sDeployment.hasForeignReplicaOwnerAnnotation(applied),
      runFencedMutation: options?.runFencedMutation,
    });
    return outcome.status === "applied";
  }

  /** Explicit demand gives managed hibernation another chance. */
  async clearForeignReplicaOwner(): Promise<void> {
    const live = await this.readLiveDeployment();
    if (!live || !K8sDeployment.hasForeignReplicaOwnerAnnotation(live)) return;
    const generation = ++this.stateGeneration;
    await this.transitionWrite({
      generation,
      label: "clearForeignReplicaOwner",
      expect: (current) =>
        K8sDeployment.hasForeignReplicaOwnerAnnotation(current),
      body: () => ({
        metadata: {
          annotations: { [MCP_FOREIGN_REPLICA_OWNER_ANNOTATION]: null },
        },
      }),
      survived: (applied) =>
        !K8sDeployment.hasForeignReplicaOwnerAnnotation(applied),
    });
  }

  /**
   * Read this deployment's live K8s object, or null when it doesn't exist.
   * Demand-lane guards in the runtime manager use it to decide from cluster
   * truth where the cached state can't be trusted (cache-cold wakes, the
   * pre-hibernation external-scale check).
   */
  async readLiveDeployment(): Promise<k8s.V1Deployment | null> {
    try {
      return await this.k8sAppsApi.readNamespacedDeployment({
        name: this.deploymentName,
        namespace: this.namespace,
      });
    } catch (error: unknown) {
      if (isK8sNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Mirror a hibernation state transition performed on a sibling alias onto
   * this object's cached state. Exists solely for the runtime manager to keep
   * the multitenant sibling aliases of one physical deployment consistent
   * (K8sDeployment only transitions the object a lifecycle method was called
   * on) — no other callers.
   */
  syncStateFromSibling(state: McpDeploymentState): void {
    this.observeState(state);
  }

  /**
   * Whether a Deployment carries the idle-hibernation annotation we set in
   * {@link hibernate} (removed again by {@link completeWake}). Public so the
   * runtime manager can classify deployments it read directly.
   */
  static hasHibernationAnnotation(deployment: k8s.V1Deployment): boolean {
    return (
      deployment.metadata?.annotations?.[MCP_HIBERNATED_ANNOTATION] === "true"
    );
  }

  static hasForeignReplicaOwnerAnnotation(
    deployment: k8s.V1Deployment,
  ): boolean {
    return (
      deployment.metadata?.annotations?.[
        MCP_FOREIGN_REPLICA_OWNER_ANNOTATION
      ] === "true"
    );
  }
  // SPDX-SnippetEnd

  /** Assign cluster truth without constraining the observed transition. */
  private observeState(observedState: McpDeploymentState): boolean {
    this.state = applyDeploymentObservation({
      cachedState: this.state,
      observedState,
    });
    return true;
  }

  /** Add a resourceVersion precondition when the live object has one. */
  private static resourceVersionPrecondition(
    deployment: k8s.V1Deployment | null,
  ): { resourceVersion?: string } {
    const resourceVersion = deployment?.metadata?.resourceVersion;
    return resourceVersion ? { resourceVersion } : {};
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /** Validate and apply a hibernation action. */
  private transitionAction(next: McpDeploymentState, reason: string): boolean {
    if (
      !assertActionTransition({
        from: this.state,
        to: next,
        reason,
        deploymentName: this.deploymentName,
      })
    ) {
      return false;
    }
    this.state = next;
    return true;
  }

  /** The replica count {@link hibernate} recorded, clamped to a usable ≥ 1. */
  private static recordedPreHibernationReplicas(
    deployment: k8s.V1Deployment | null,
  ): number {
    const recorded = Number.parseInt(
      deployment?.metadata?.annotations?.[
        MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION
      ] ?? "",
      10,
    );
    return Number.isFinite(recorded) ? Math.max(recorded, 1) : 1;
  }

  /**
   * The one way this class writes a lifecycle transition.
   *
   * A `resourceVersion` precondition proves ATOMICITY — nothing changed
   * between my read and my write. It does not prove VALIDITY — that the object
   * still means what the decision that reached this line assumed. Those are
   * different claims, and conflating them is what produced the worst defects
   * this file has had: a hibernate that scaled down a deployment mid-wake with
   * the CAS passing, and a wake that resized a healthy deployment to 1 with the
   * CAS passing. Every lifecycle write therefore states its own precondition:
   *
   *  - `expect` is the shape the DECISION was about, re-checked against a fresh
   *    read. This is the barrier. `deriveDeploymentState` is already a total
   *    function over cluster facts; `expect` makes mutation one too.
   *  - `survived` is the post-condition, checked against the RESPONSE. The
   *    patch we sent is not necessarily the object that got stored: an
   *    admission webhook can strip an annotation while honouring the spec, and
   *    trusting the write leaves a deployment scaled to zero with no ownership
   *    marker — an orphan nothing can ever wake.
   *  - `generation` closes the abandoned-attempt hole. Callers are released at
   *    a deadline while the work keeps running, so an attempt that lost its
   *    caller must not still land a patch on top of a newer transition.
   *
   * Abandoning is always safe here and forcing never is: every shape this can
   * leave behind is one `deriveDeploymentState` already names and the periodic
   * refresh already repairs. That is why a 409 re-reads and re-checks rather
   * than retrying blind, and why exhausting the attempts gives up.
   */
  private async transitionWrite(params: {
    generation: number;
    label: string;
    expect: (live: k8s.V1Deployment) => boolean;
    body: (live: k8s.V1Deployment) => object;
    survived: (applied: k8s.V1Deployment) => boolean;
    runFencedMutation?: LifecycleMutationOptions["runFencedMutation"];
    /**
     * How many times a 409 is re-read and re-checked. Waking retries, because
     * a wake that gives up leaves a caller with no server. Hibernating passes
     * 1: a contended object is doubt, a missed hibernation costs one idle
     * window, and a wrong one kills a pod that is serving.
     */
    maxAttempts?: number;
  }): Promise<TransitionWriteOutcome> {
    if (params.runFencedMutation) {
      const { runFencedMutation, ...unfencedParams } = params;
      return runFencedMutation(() => this.transitionWrite(unfencedParams));
    }
    const { generation, label, expect, body, survived } = params;
    const maxAttempts = params.maxAttempts ?? TRANSITION_WRITE_MAX_ATTEMPTS;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (this.stateGeneration !== generation) {
        logger.debug(
          { deploymentName: this.deploymentName, label },
          "Abandoning an MCP lifecycle write: another transition superseded it",
        );
        return { status: "lost-race" };
      }

      const live = await this.readLiveDeployment();

      // Re-check AFTER the read, not only before it. The read is the long
      // await in this loop, so it is the window a superseding transition
      // actually lands in — checking only on the way in leaves the very hole
      // the generation counter exists to close.
      if (this.stateGeneration !== generation) {
        logger.debug(
          { deploymentName: this.deploymentName, label },
          "Abandoning an MCP lifecycle write: a transition landed while it was reading",
        );
        return { status: "lost-race" };
      }

      // No object to check against is not permission to write blind.
      if (!live || !expect(live)) {
        logger.debug(
          { deploymentName: this.deploymentName, label },
          "Abandoning an MCP lifecycle write: the deployment is no longer the shape the decision assumed",
        );
        return { status: "shape-changed", live };
      }

      // The precondition is merged UNDER the caller's metadata, never over it,
      // so a body can add annotations without dropping the CAS that guards it.
      const patch = body(live) as {
        metadata?: Record<string, unknown>;
        [key: string]: unknown;
      };
      const metadata = {
        ...K8sDeployment.resourceVersionPrecondition(live),
        ...(patch.metadata ?? {}),
      };
      // Send no `metadata` key at all rather than an empty one: a merge patch
      // should say only what it changes.
      const patchBody =
        Object.keys(metadata).length > 0
          ? { ...patch, metadata }
          : { ...patch };

      let applied: k8s.V1Deployment;
      try {
        applied = await this.k8sAppsApi.patchNamespacedDeployment(
          {
            name: this.deploymentName,
            namespace: this.namespace,
            body: patchBody,
          },
          setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
        );
      } catch (error) {
        if (isK8sConflictError(error)) continue;
        // A timeout or dropped response can mean the API server committed the
        // patch but the client never received its body. Settle that ambiguity
        // from cluster truth before reporting failure; every survived shape is
        // an idempotent lifecycle outcome even if another replica produced it.
        const confirmed = await this.readLiveDeployment().catch(() => null);
        if (confirmed && survived(confirmed)) {
          logger.warn(
            { err: error, deploymentName: this.deploymentName, label },
            "MCP lifecycle write returned an error but its outcome was confirmed in the cluster",
          );
          return { status: "applied", applied: confirmed };
        }
        throw error;
      }

      if (!survived(applied)) {
        // The response did not show the change, and only the cluster can
        // settle whether it persisted — confirm with a read. A confirmation
        // that cannot be read (or finds the object gone) is NOT acceptance:
        // reporting `applied` on missing information is how a hibernate whose
        // marker was stripped gets recorded as success, leaving an
        // unannotated zero-replica Deployment that nothing may ever wake.
        const confirmed = await this.readLiveDeployment().catch(() => null);
        if (!confirmed) return { status: "unconfirmed" };
        if (!survived(confirmed)) {
          logger.error(
            { deploymentName: this.deploymentName, label },
            "An MCP lifecycle write did not survive the cluster's admission chain",
          );
          return { status: "not-persisted", applied: confirmed };
        }
        return { status: "applied", applied: confirmed };
      }
      return { status: "applied", applied };
    }

    logger.debug(
      { deploymentName: this.deploymentName, label },
      "Abandoning an MCP lifecycle write: lost the compare-and-swap repeatedly",
    );
    return { status: "lost-race" };
  }

  /**
   * The scale-up half of a wake. Patches replicas only — the hibernation
   * annotations deliberately stay until readiness — under the read object's
   * resourceVersion, so a concurrent write is surfaced as a 409 rather than
   * silently overwriting it.
   */
  private async patchWakeReplicas(
    replicas: number,
    liveDeployment: k8s.V1Deployment | null,
  ): Promise<void> {
    const precondition =
      K8sDeployment.resourceVersionPrecondition(liveDeployment);
    await this.k8sAppsApi.patchNamespacedDeployment(
      {
        name: this.deploymentName,
        namespace: this.namespace,
        body: {
          ...(precondition.resourceVersion ? { metadata: precondition } : {}),
          spec: { replicas },
        },
      },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
  }

  /** Converge on cluster truth after a wake lost its compare-and-swap race. */
  private async refreshStateAfterLostWakeRace(): Promise<void> {
    await this.refreshState({ skipWakeCompletion: true }).catch((error) => {
      logger.warn(
        { err: error },
        `Failed to refresh state for ${this.deploymentName} after losing a wake race`,
      );
    });
  }
  // SPDX-SnippetEnd

  /**
   * Forget the pod this deployment used to run. Called wherever the pod is
   * known to be gone, so statusSummary stops reporting a dead pod's name, age
   * and restart count as if it still existed.
   */
  private clearCachedPodTelemetry(): void {
    this.cachedPodName = null;
    this.cachedPodCreationTime = null;
    this.cachedRestartCount = 0;
  }

  /**
   * Helper to find the running pod for this deployment
   */
  private async findPodForDeployment(): Promise<k8s.V1Pod | undefined> {
    try {
      const sanitizedId = sanitizeLabelValue(this.getPodSelectorServerId());
      const pods = await this.k8sApi.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: `mcp-server-id=${sanitizedId}`,
      });
      const running = pods.items.find((pod) => pod.status?.phase === "Running");
      if (running) {
        return running;
      }

      // Multi-tenant fallback: the shared deployment's pod was labeled with
      // the first caller's id, so other callers' label search returns no
      // pods. Match by deployment name prefix instead, scoped to pods this
      // runtime created (every one carries app=mcp-server) so we never list
      // the whole namespace.
      const allPods = await this.k8sApi.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: "app=mcp-server",
      });
      return allPods.items.find(
        (pod) =>
          pod.status?.phase === "Running" &&
          (pod.metadata?.name ?? "").startsWith(`${this.deploymentName}-`),
      );
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to list pods for ${this.deploymentName}`,
      );
      return undefined;
    }
  }

  /**
   * Check if a running pod exists for this deployment
   */
  async hasRunningPod(): Promise<boolean> {
    const pod = await this.findPodForDeployment();
    return !!pod;
  }

  /**
   * Helper to find any pod for this deployment (not just running).
   *
   * Throws on a failed lookup rather than reporting "no pod": callers draw
   * conclusions from an absent pod (clearing telemetry, declaring a deployment
   * pod-less), and a 429 from the API server is not evidence of either.
   */
  private async findAnyPodForDeployment(): Promise<k8s.V1Pod | undefined> {
    const sanitizedId = sanitizeLabelValue(this.getPodSelectorServerId());
    const pods = await this.k8sApi.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `mcp-server-id=${sanitizedId}`,
    });
    if (pods.items.length > 0) {
      return pods.items[0];
    }

    // Multi-tenant catalogs share one deployment across many mcp_server
    // rows; the deployment's pod label was baked in at create time using
    // the first caller's mcp_server.id, so subsequent callers won't match
    // by label. Fall back to matching pods by deployment name prefix,
    // scoped to pods this runtime created (every one carries
    // app=mcp-server) so we never list the whole namespace.
    const allPods = await this.k8sApi.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: "app=mcp-server",
    });
    return allPods.items.find((pod) =>
      (pod.metadata?.name ?? "").startsWith(`${this.deploymentName}-`),
    );
  }

  /**
   * Get Kubernetes events related to the deployment and its pods
   */
  async getDeploymentEvents(): Promise<string> {
    try {
      const sanitizedId = sanitizeLabelValue(this.mcpServer.id);

      // Get events from the namespace, filtering to those related to our deployment or pods
      const events = await this.k8sApi.listNamespacedEvent({
        namespace: this.namespace,
      });

      // Filter events related to our deployment or pods
      const relevantEvents = events.items.filter((event) => {
        const involvedName = event.involvedObject?.name || "";
        // Match deployment name or pods with our label
        return (
          involvedName.startsWith(this.deploymentName) ||
          involvedName.includes(sanitizedId)
        );
      });

      if (relevantEvents.length === 0) {
        return "No events found for this deployment";
      }

      // Sort by last timestamp (most recent first)
      relevantEvents.sort((a, b) => {
        const aTime =
          a.lastTimestamp || a.eventTime || a.metadata?.creationTimestamp;
        const bTime =
          b.lastTimestamp || b.eventTime || b.metadata?.creationTimestamp;
        if (!aTime || !bTime) return 0;
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      });

      // Format events for display
      const formattedEvents = relevantEvents.map((event) => {
        const timestamp =
          event.lastTimestamp ||
          event.eventTime ||
          event.metadata?.creationTimestamp;
        const timeStr = timestamp
          ? new Date(timestamp).toISOString()
          : "unknown";
        const type = event.type || "Normal";
        const reason = event.reason || "Unknown";
        const message = event.message || "";
        const obj = event.involvedObject?.name || "unknown";
        const count = event.count || 1;

        return `[${timeStr}] ${type} ${reason} (${obj}${count > 1 ? ` x${count}` : ""}): ${message}`;
      });

      return formattedEvents.join("\n");
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to get events for deployment ${this.deploymentName}`,
      );
      return "Failed to retrieve deployment events";
    }
  }

  /**
   * Check K8s events for deployment failure indicators.
   * Returns failure info if critical errors are found.
   */
  private async checkEventsForFailure(): Promise<{
    hasFailure: boolean;
    message: string | null;
  }> {
    try {
      const events = await this.k8sApi.listNamespacedEvent({
        namespace: this.namespace,
      });

      const sanitizedId = sanitizeLabelValue(this.mcpServer.id);

      // Filter recent events (last 2 minutes) related to our deployment
      const twoMinutesAgo = Date.now() - TimeInMs.Minute * 2;
      const relevantEvents = events.items.filter((event) => {
        const involvedName = event.involvedObject?.name || "";
        const eventTime =
          event.lastTimestamp ||
          event.eventTime ||
          event.metadata?.creationTimestamp;
        const eventTimestamp = eventTime ? new Date(eventTime).getTime() : 0;

        return (
          eventTimestamp > twoMinutesAgo &&
          (involvedName.startsWith(this.deploymentName) ||
            involvedName.includes(sanitizedId))
        );
      });

      // Known failure patterns in events
      const failurePatterns = [
        {
          pattern: /error looking up service account/i,
          reason: "Invalid ServiceAccount",
        },
        {
          pattern: /serviceaccount.*not found/i,
          reason: "ServiceAccount not found",
        },
        {
          pattern: /forbidden.*serviceaccount/i,
          reason: "ServiceAccount forbidden",
        },
        { pattern: /exceeded quota/i, reason: "Resource quota exceeded" },
        {
          pattern: /Unable to attach or mount volumes/i,
          reason: "Volume mount failed",
        },
        {
          pattern: /FailedScheduling.*node\(s\)/i,
          reason: "No matching nodes",
        },
      ];

      for (const event of relevantEvents) {
        if (event.type === "Warning" && event.message) {
          for (const { pattern, reason } of failurePatterns) {
            if (pattern.test(event.message)) {
              return {
                hasFailure: true,
                message: `${reason}: ${event.message}`,
              };
            }
          }
        }
      }

      return { hasFailure: false, message: null };
    } catch (error) {
      logger.warn({ err: error }, "Failed to check events for failure");
      return { hasFailure: false, message: null };
    }
  }

  /**
   * Check all pods for container failure states (e.g. CrashLoopBackOff, ImagePullBackOff).
   * Used on startup and during state refresh to detect deployments stuck in a
   * failure state. Image pull failures are reported separately
   * (`isTransientImagePull`) because the kubelet retries pulls on its own and
   * the pod recovers once the pull succeeds.
   */
  private async checkPodContainerStatusesForFailure(): Promise<{
    hasFailed: boolean;
    isTransientImagePull: boolean;
    message: string;
  }> {
    let transientImagePullMessage: string | null = null;

    try {
      const sanitizedId = sanitizeLabelValue(this.getPodSelectorServerId());
      const pods = await this.k8sApi.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: `mcp-server-id=${sanitizedId}`,
      });

      for (const pod of pods.items) {
        for (const cs of pod.status?.containerStatuses ?? []) {
          const reason = cs.state?.waiting?.reason;
          if (!reason) {
            continue;
          }
          const message =
            cs.state?.waiting?.message || `Container in ${reason} state`;
          if (TERMINAL_CONTAINER_WAITING_REASONS.includes(reason)) {
            return { hasFailed: true, isTransientImagePull: false, message };
          }
          if (TRANSIENT_IMAGE_PULL_WAITING_REASONS.includes(reason)) {
            transientImagePullMessage = message;
          }
        }
      }
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to check pod statuses for ${this.deploymentName}`,
      );
    }

    if (transientImagePullMessage) {
      return {
        hasFailed: true,
        isTransientImagePull: true,
        message: transientImagePullMessage,
      };
    }

    return { hasFailed: false, isTransientImagePull: false, message: "" };
  }

  private checkPodConditionsForFailure(pod: k8s.V1Pod): {
    hasFailure: boolean;
    message: string | null;
  } {
    const conditions = pod.status?.conditions || [];

    for (const condition of conditions) {
      // Check for scheduling failures
      if (
        condition.type === "PodScheduled" &&
        condition.status === "False" &&
        condition.message
      ) {
        return {
          hasFailure: true,
          message: `Pod scheduling failed: ${condition.message}`,
        };
      }
    }

    return { hasFailure: false, message: null };
  }

  /**
   * Get pod status information for display
   */
  private getPodStatusInfo(pod: k8s.V1Pod): string {
    const phase = pod.status?.phase || "Unknown";
    const conditions = pod.status?.conditions || [];
    const containerStatuses = pod.status?.containerStatuses || [];

    const lines: string[] = [];
    lines.push(`Pod Phase: ${phase}`);

    // Add container statuses
    for (const containerStatus of containerStatuses) {
      const name = containerStatus.name;
      const ready = containerStatus.ready ? "Ready" : "Not Ready";
      const restartCount = containerStatus.restartCount || 0;

      let stateInfo = "";
      if (containerStatus.state?.waiting) {
        stateInfo = `Waiting: ${containerStatus.state.waiting.reason || "Unknown"}`;
        if (containerStatus.state.waiting.message) {
          stateInfo += ` - ${containerStatus.state.waiting.message}`;
        }
      } else if (containerStatus.state?.running) {
        stateInfo = "Running";
      } else if (containerStatus.state?.terminated) {
        stateInfo = `Terminated: ${containerStatus.state.terminated.reason || "Unknown"}`;
      }

      lines.push(
        `Container '${name}': ${ready}, Restarts: ${restartCount}, State: ${stateInfo}`,
      );
    }

    // Add relevant conditions
    for (const condition of conditions) {
      if (condition.status === "False" && condition.message) {
        lines.push(`Condition ${condition.type}: ${condition.message}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Check if this MCP server needs an HTTP port
   */
  private async needsHttpPort(): Promise<boolean> {
    const catalogItem = await this.getCatalogItem();
    if (!catalogItem?.localConfig) {
      return false;
    }
    // Default to stdio if transportType is not specified
    const transportType = catalogItem.localConfig.transportType || "stdio";
    return transportType === "streamable-http";
  }

  /**
   * Create a K8s Service for HTTP-based MCP servers
   */
  private async createServiceForHttpServer(
    httpPort: number,
    nodePort?: number,
  ): Promise<void> {
    const serviceName = this.constructHttpServiceName();

    // System-managed identity labels shared by the service metadata and its
    // pod selector. The service NAME is derived from the (stable) deployment
    // name, but the selector targets `mcp-server-id`. For multitenant catalogs
    // the Deployment + Service are shared across installs, so this uses the
    // catalog-stable id (getPodSelectorServerId) — every install reconciles to
    // the same selector, matching the Deployment's pod labels. It still changes
    // on a genuine identity change, so an existing Service is reconciled here
    // (not skipped): otherwise it kept selecting a stale id, matched zero pods,
    // had no endpoints, and every connect/read failed ("Resource read failed").
    const identityLabels = sanitizeMetadataLabels({
      app: "mcp-server",
      "mcp-server-id": this.getPodSelectorServerId(),
    });

    try {
      // If the service already exists, reconcile its selector + labels to the
      // current mcp-server-id (see note above) rather than leaving it stale.
      try {
        await this.k8sApi.readNamespacedService({
          name: serviceName,
          namespace: this.namespace,
        });
        await this.k8sApi.patchNamespacedService(
          {
            name: serviceName,
            namespace: this.namespace,
            body: {
              metadata: {
                labels: identityLabels,
                ownerReferences: await this.getRuntimeOwnerReferences(),
              },
              spec: { selector: identityLabels },
            },
          },
          setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
        );
        logger.info(
          { mcpServerId: this.mcpServer.id, serviceName },
          `Service ${serviceName} already exists — reconciled selector to current mcp-server-id`,
        );
        return;
      } catch (error: unknown) {
        // Service doesn't exist, we'll create it below
        if (!isK8sNotFoundError(error)) {
          throw error;
        }
      }

      // Create the service
      // Use NodePort for local dev, ClusterIP for production
      const serviceType = config.orchestrator.kubernetes
        .loadKubeconfigFromCurrentCluster
        ? "ClusterIP"
        : "NodePort";

      const serviceSpec = await this.withRuntimeOwnerReference<k8s.V1Service>({
        metadata: {
          name: serviceName,
          labels: identityLabels,
        },
        spec: {
          selector: identityLabels,
          ports: [
            {
              protocol: "TCP",
              port: httpPort,
              targetPort: httpPort as unknown as k8s.IntOrString,
              // Use fixed nodePort if configured (local dev only, ignored for ClusterIP)
              ...(nodePort && serviceType === "NodePort" ? { nodePort } : {}),
            },
          ],
          type: serviceType,
        },
      });

      await this.k8sApi.createNamespacedService({
        namespace: this.namespace,
        body: serviceSpec,
      });

      logger.info(
        `Created service ${serviceName} for deployment ${this.deploymentName}`,
      );
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to create service for deployment ${this.deploymentName}:`,
      );
      throw error;
    }
  }

  private constructHttpServiceName(): string {
    const maxBaseLength =
      K8sDeployment.MAX_K8S_LABEL_LENGTH -
      K8sDeployment.HTTP_SERVICE_SUFFIX.length;

    const base = this.deploymentName
      .replace(/\./g, "-")
      .slice(0, maxBaseLength)
      .replace(/^[^a-z0-9]+/, "")
      .replace(/[^a-z0-9]+$/g, "");

    const normalizedBase = base.length > 0 ? base : "mcp-server";
    return `${normalizedBase}${K8sDeployment.HTTP_SERVICE_SUFFIX}`;
  }

  private getK8sNetworkPolicyName(): string {
    return constructManagedNetworkPolicyName(this.deploymentName);
  }

  /**
   * Assign HTTP port from the pod/service
   */
  private async assignHttpPortIfNeeded(pod: k8s.V1Pod): Promise<void> {
    const needsHttp = await this.needsHttpPort();
    if (needsHttp && pod.status?.podIP) {
      const catalogItem = await this.getCatalogItem();
      const httpPort = catalogItem?.localConfig?.httpPort || 8080;
      // Use the container port directly with pod IP
      this.assignedHttpPort = httpPort;
      logger.info(
        `Assigned HTTP port ${this.assignedHttpPort} for deployment ${this.deploymentName}`,
      );
    }
  }

  /**
   * Wait for deployment to be in ready state
   */
  async waitForDeploymentReady(
    maxAttempts = 60,
    intervalMs = 2000,
    options?: RuntimeExtensionOptions,
  ): Promise<void> {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const hibernationOptions = options as HibernationReadyOptions | undefined;
    const waitOutCapacityPressure =
      hibernationOptions?.waitOutUnschedulablePods === true;
    // SPDX-SnippetEnd
    let lastImagePullError: string | null = null;
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // Holds the capacity wording only while it is still the live reason this
    // wait has not finished: an attempt that sees the pod on a node clears it,
    // so the error thrown at the end names whatever actually ended the wait.
    let lastCapacityPressureMessage: string | null = null;
    // SPDX-SnippetEnd

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const sanitizedId = sanitizeLabelValue(this.getPodSelectorServerId());
        const pods = await this.k8sApi.listNamespacedPod({
          namespace: this.namespace,
          labelSelector: `mcp-server-id=${sanitizedId}`,
        });

        // Pod Ready is the kubelet-owned result of the readiness probe. Waiting
        // on it directly avoids treating a merely Running container as able to
        // serve while keeping wake completion intentionally simple.
        const readyPod = pods.items.find(isPodReady);
        if (readyPod) {
          await this.assignHttpPortIfNeeded(readyPod);
          if (this.observeState("running")) {
            this.errorMessage = null;
          }
          return;
        }

        // Check for failure events (every 5th iteration to reduce API calls)
        // Start checking after first 10 seconds (iteration 5)
        if (i >= 5 && i % 5 === 0) {
          const eventCheck = await this.checkEventsForFailure();
          if (eventCheck.hasFailure) {
            const eventMessage = eventCheck.message || "Deployment failed";
            let failForEvent = true;
            // SPDX-SnippetBegin
            // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
            // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
            if (
              waitOutCapacityPressure &&
              classifySchedulingFailure(eventMessage) === "capacity"
            ) {
              // Capacity pressure reaches a wake as a Warning event too — an
              // exhausted namespace ResourceQuota is reported against the
              // ReplicaSet, before any pod exists to carry a condition.
              lastCapacityPressureMessage = eventMessage;
              this.errorMessage = eventMessage;
              failForEvent = false;
            }
            // SPDX-SnippetEnd
            if (failForEvent) {
              this.observeState("failed");
              this.errorMessage = eventMessage;
              throw new McpServerDeploymentFailedError(
                `Deployment ${this.deploymentName} failed: ${eventCheck.message}`,
              );
            }
          }
        }

        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        let unschedulableThisAttempt: string | null = null;
        let sawScheduledPod = false;
        // SPDX-SnippetEnd

        for (const pod of pods.items) {
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          if (isPodScheduled(pod)) {
            sawScheduledPod = true;
          }
          // SPDX-SnippetEnd

          // Check pending pods without containerStatuses for condition failures
          if (
            pod.status?.phase === "Pending" &&
            (!pod.status?.containerStatuses ||
              pod.status.containerStatuses.length === 0)
          ) {
            const conditionCheck = this.checkPodConditionsForFailure(pod);
            if (conditionCheck.hasFailure) {
              const conditionMessage =
                conditionCheck.message || "Pod scheduling failed";
              let failForCondition = true;
              // SPDX-SnippetBegin
              // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
              // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
              if (
                waitOutCapacityPressure &&
                classifySchedulingFailure(conditionMessage) === "capacity"
              ) {
                // A wake rides out scheduling pressure: a full cluster is the
                // condition a cluster autoscaler exists to clear (nodes take
                // 1–4 minutes to provision), so failing fast would brand a
                // full-but-healthy cluster as a deployment defect. Keep
                // waiting within the budget; the final error carries what the
                // scheduler said. Anything the classifier does not recognize
                // as capacity falls through and still fails fast — nothing
                // outside capacity pressure resolves itself.
                unschedulableThisAttempt = conditionMessage;
                this.errorMessage = conditionMessage;
                failForCondition = false;
              }
              // SPDX-SnippetEnd
              if (failForCondition) {
                // Check how long pod has been pending
                const creationTime = pod.metadata?.creationTimestamp;
                const pendingDuration = creationTime
                  ? Date.now() - new Date(creationTime).getTime()
                  : 0;

                // If pending for > 20 seconds with a condition failure, fail fast
                if (pendingDuration > TimeInMs.Second * 20) {
                  this.observeState("failed");
                  this.errorMessage =
                    conditionCheck.message || "Pod scheduling failed";
                  throw new McpServerDeploymentFailedError(
                    `Deployment ${this.deploymentName} failed: ${conditionCheck.message}`,
                  );
                }
              }
            }
          }

          // Check for failure states in container statuses
          if (pod.status?.containerStatuses) {
            for (const containerStatus of pod.status.containerStatuses) {
              const waitingReason = containerStatus.state?.waiting?.reason;
              if (waitingReason) {
                const message =
                  containerStatus.state?.waiting?.message ||
                  `Container in ${waitingReason} state`;

                if (
                  TERMINAL_CONTAINER_WAITING_REASONS.includes(waitingReason)
                ) {
                  this.observeState("failed");
                  this.errorMessage = message;
                  throw new McpServerDeploymentFailedError(
                    `Deployment ${this.deploymentName} failed: ${waitingReason} - ${message}`,
                  );
                }

                // Image pull errors are retried by the kubelet itself with
                // exponential backoff — keep waiting instead of failing fast,
                // but surface the error so status polling can display it.
                if (
                  TRANSIENT_IMAGE_PULL_WAITING_REASONS.includes(waitingReason)
                ) {
                  lastImagePullError = `${waitingReason} - ${message}`;
                  this.errorMessage = message;
                }
              }
            }
          }
        }

        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        if (unschedulableThisAttempt) {
          lastCapacityPressureMessage = unschedulableThisAttempt;
        } else if (sawScheduledPod) {
          // The pod got a node, so whatever is holding the wait up now is not
          // capacity — drop the wording so it cannot shadow the real cause.
          lastCapacityPressureMessage = null;
        }
        // SPDX-SnippetEnd
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          (error.message.includes("failed to start") ||
            error.message.includes("failed:"))
        ) {
          throw error;
        }
        // Continue waiting for other errors (e.g., network issues)
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    if (lastCapacityPressureMessage) {
      throw new McpServerUnschedulableError(
        this.deploymentName,
        lastCapacityPressureMessage,
        lastImagePullError,
      );
    }
    // SPDX-SnippetEnd
    throw new Error(
      `Deployment ${this.deploymentName} did not become ready after ${maxAttempts} attempts${
        lastImagePullError
          ? ` (last image pull error: ${lastImagePullError})`
          : ""
      }`,
    );
  }

  /**
   * Poll until the Deployment is fully gone (404). Used before recreating a
   * Deployment whose immutable selector drifted — creating the replacement while
   * the old object is still terminating would 409 ("already exists"). Bounded so
   * a stuck finalizer can't hang the reconcile forever.
   */
  private async waitForDeploymentAbsent(
    maxAttempts = 30,
    intervalMs = 1000,
  ): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this.k8sAppsApi.readNamespacedDeployment({
          name: this.deploymentName,
          namespace: this.namespace,
        });
      } catch (error: unknown) {
        if (isK8sNotFoundError(error)) {
          return;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `Deployment ${this.deploymentName} was not deleted after ${maxAttempts} attempts`,
    );
  }

  /**
   * Stop the deployment (fire-and-forget - K8s handles cleanup in background)
   */
  async stopDeployment(options?: {
    assertOwned?: () => Promise<void>;
    uidPrecondition?: boolean | string;
  }): Promise<void> {
    try {
      logger.info(`Stopping deployment ${this.deploymentName}`);
      let uid: string | undefined;
      if (options?.uidPrecondition) {
        await options.assertOwned?.();
        uid =
          typeof options.uidPrecondition === "string"
            ? options.uidPrecondition
            : (
                await this.k8sAppsApi.readNamespacedDeployment({
                  name: this.deploymentName,
                  namespace: this.namespace,
                })
              ).metadata?.uid;
        if (!uid) {
          throw new Error(
            `Deployment ${this.deploymentName} has no UID; refusing an unfenced delete`,
          );
        }
        // A holder that stalled during the read must prove ownership again
        // before issuing the delete. UID preconditions then protect a newer
        // replacement if ownership expires while the request is in flight.
        await options.assertOwned?.();
      }
      await this.k8sAppsApi.deleteNamespacedDeployment({
        name: this.deploymentName,
        namespace: this.namespace,
        ...(uid ? { body: { preconditions: { uid } } } : {}),
      });
      logger.info(`Deployment ${this.deploymentName} deletion initiated`);
      this.observeState("not_created");
    } catch (error: unknown) {
      // If deployment doesn't exist (404), that's okay - it may have been deleted already
      if (isK8sNotFoundError(error)) {
        logger.info(`Deployment ${this.deploymentName} already deleted`);
        this.observeState("not_created");
        return;
      }
      logger.error(
        { err: error },
        `Failed to stop deployment ${this.deploymentName}:`,
      );
      throw error;
    }
  }

  /**
   * Remove the deployment completely (including associated Service and Secret)
   */
  async removeDeployment(options?: {
    runFencedMutation?: <T>(fn: () => Promise<T>) => Promise<T>;
    uidPrecondition?: boolean;
  }): Promise<void> {
    const mutate = options?.runFencedMutation ?? (async (fn) => fn());
    await mutate(() =>
      this.stopDeployment({ uidPrecondition: options?.uidPrecondition }),
    );
    await mutate(() => this.deleteK8sService());
    await mutate(() => this.deleteK8sSecret());
    await mutate(() => this.deleteDockerRegistrySecrets());
    await mutate(() => this.deleteK8sNetworkPolicy());
  }

  /**
   * Get recent logs from the pod
   */
  async getRecentLogs(lines: number = 100): Promise<string> {
    try {
      const pod = await this.findPodForDeployment();
      if (!pod || !pod.metadata?.name) {
        return "Pod not found or not running";
      }

      const logs = await this.k8sApi.readNamespacedPodLog({
        name: pod.metadata.name,
        namespace: this.namespace,
        tailLines: lines,
      });

      return logs || "";
    } catch (error: unknown) {
      logger.error(
        { err: error },
        `Failed to get logs for deployment ${this.deploymentName}:`,
      );

      // If pod doesn't exist (404), return a helpful message
      if (isK8sNotFoundError(error)) {
        return "Pod not found";
      }
      throw error;
    }
  }

  /**
   * Stream logs from the pod with follow enabled.
   * If no running pod is found, write a K8s events snapshot and then keep
   * the stream open, polling for the pod to become Ready and switching to
   * real container logs once it does. This way clients that opened the logs
   * view during the brief Pending/ContainerCreating window after install
   * don't need to refresh — the stream upgrades itself.
   * @param responseStream - The stream to write logs to
   * @param lines - Number of initial lines to fetch
   * @param abortSignal - Optional abort signal to cancel the stream
   */
  async streamLogs(
    responseStream: NodeJS.WritableStream,
    lines: number = 100,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    try {
      // Try to find any pod (including non-running) to check container status
      const anyPod = await this.findAnyPodForDeployment();
      if (!anyPod || !anyPod.metadata?.name) {
        // No pod yet — show events, then wait for one to appear and become Ready
        await this.writeEventsSnapshot(responseStream);
        await this.pollAndStreamLogsWhenReady(
          responseStream,
          lines,
          abortSignal,
        );
        return;
      }

      // Check if the container is in a waiting state (e.g. CrashLoopBackOff)
      const containerStatus = anyPod.status?.containerStatuses?.find(
        (cs) => cs.name === "mcp-server",
      );
      const isContainerWaiting = !!containerStatus?.state?.waiting;
      const waitingReason = containerStatus?.state?.waiting?.reason;
      const hasRestarted = (containerStatus?.restartCount ?? 0) > 0;

      // If container is waiting (CrashLoopBackOff, etc.), show previous logs or events
      if (isContainerWaiting) {
        if (hasRestarted) {
          // Container has restarted — try to get logs from the previous crashed container
          logger.info(
            {
              pod: anyPod.metadata.name,
              reason: waitingReason,
              restartCount: containerStatus?.restartCount,
            },
            "Container is in waiting state, fetching previous container logs",
          );

          try {
            const logStream = new PassThrough();
            let hasLogData = false;

            const waitingMessage = containerStatus?.state?.waiting?.message;
            let header = `=== Container is in ${waitingReason || "Waiting"} state (${containerStatus?.restartCount} restarts) ===\n`;
            if (waitingMessage) {
              header += `=== Error: ${waitingMessage} ===\n`;
            }
            header += `=== Showing logs from the last crashed container ===\n\n`;
            responseStream.write(header);

            logStream.on("data", (chunk) => {
              hasLogData = true;
              if (
                !("destroyed" in responseStream) ||
                !responseStream.destroyed
              ) {
                responseStream.write(chunk);
              }
            });
            logStream.on("error", (error) => {
              logger.error(
                { err: error },
                `Log stream error for pod ${anyPod.metadata?.name} (previous):`,
              );
            });
            logStream.on("end", async () => {
              if (!hasLogData) {
                // No previous logs — append events as fallback
                try {
                  const events = await this.getDeploymentEvents();
                  const podInfo = this.getPodStatusInfo(anyPod);
                  responseStream.write("--- Pod Status ---\n");
                  responseStream.write(podInfo);
                  responseStream.write("\n\n--- Kubernetes Events ---\n");
                  responseStream.write(events);
                  responseStream.write("\n");
                } catch {
                  responseStream.write("(No logs from previous container)\n\n");
                }
              }
              // Keep the stream open and wait for the container to become
              // Ready again (e.g. CrashLoopBackOff recovers), then upgrade
              // to live log streaming.
              await this.pollAndStreamLogsWhenReady(
                responseStream,
                lines,
                abortSignal,
              );
            });

            await this.k8sLog.log(
              this.namespace,
              anyPod.metadata.name,
              "mcp-server",
              logStream,
              {
                follow: false,
                tailLines: lines,
                pretty: false,
                timestamps: false,
                previous: true,
              },
            );
            return;
          } catch (error) {
            logger.warn(
              { err: error },
              "Failed to get previous container logs, falling back to events",
            );
          }
        }

        // Container never started or previous logs unavailable — show events,
        // then wait for it to recover and upgrade to real logs.
        await this.writeEventsSnapshot(responseStream);
        await this.pollAndStreamLogsWhenReady(
          responseStream,
          lines,
          abortSignal,
        );
        return;
      }

      // For non-waiting containers, check if pod is actually running
      const pod = anyPod.status?.phase === "Running" ? anyPod : undefined;
      if (!pod || !pod.metadata?.name) {
        // Pod is e.g. Pending right after install — show what we know now,
        // then keep the stream open and switch to real logs once it's Ready.
        await this.writeEventsSnapshot(responseStream);
        await this.pollAndStreamLogsWhenReady(
          responseStream,
          lines,
          abortSignal,
        );
        return;
      }

      await this.streamRunningPodLogs(pod, responseStream, lines, abortSignal);
    } catch (error: unknown) {
      logger.error(
        { err: error },
        `Failed to stream logs for deployment ${this.deploymentName}:`,
      );

      if (!("destroyed" in responseStream) || !responseStream.destroyed) {
        if (
          "destroy" in responseStream &&
          typeof responseStream.destroy === "function"
        ) {
          responseStream.destroy(error as Error);
        }
      }

      throw error;
    }
  }

  /**
   * Pipe live container logs from a Running pod into responseStream and wire
   * up abort/cleanup. Does not end the stream on error paths it doesn't own.
   */
  private async streamRunningPodLogs(
    pod: k8s.V1Pod,
    responseStream: NodeJS.WritableStream,
    lines: number,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (!pod.metadata?.name) return;
    const podName = pod.metadata.name;

    const logStream = new PassThrough();
    let aborted = false;

    logStream.on("data", (chunk) => {
      if (!("destroyed" in responseStream) || !responseStream.destroyed) {
        responseStream.write(chunk);
      }
    });

    logStream.on("error", (error) => {
      logger.error({ err: error }, `Log stream error for pod ${podName}:`);
      if (!("destroyed" in responseStream) || !responseStream.destroyed) {
        if (
          "destroy" in responseStream &&
          typeof responseStream.destroy === "function"
        ) {
          responseStream.destroy(error);
        }
      }
    });

    // When the log stream ends and the client did NOT abort, the pod was
    // deleted under us (reinstall, crash, eviction). Don't close the WS —
    // wait for a new pod to come up and switch over, the same way we do
    // when streamLogs is first opened against a Pending pod.
    logStream.on("end", () => {
      if (aborted) {
        if (!("destroyed" in responseStream) || !responseStream.destroyed) {
          responseStream.end();
        }
        return;
      }
      if (!("destroyed" in responseStream) || !responseStream.destroyed) {
        responseStream.write(
          `\n--- Pod ${podName} log stream ended; waiting for replacement pod ---\n`,
        );
        void this.pollAndStreamLogsWhenReady(
          responseStream,
          lines,
          abortSignal,
        );
      }
    });

    responseStream.on("error", (error) => {
      logger.error({ err: error }, `Response stream error for pod ${podName}:`);
      if (logStream.destroy) {
        logStream.destroy();
      }
    });

    const req = await this.k8sLog.log(
      this.namespace,
      podName,
      "mcp-server",
      logStream,
      {
        follow: true,
        tailLines: lines,
        pretty: false,
        timestamps: false,
      },
    );

    let abortHandler: (() => void) | null = null;
    if (abortSignal) {
      abortHandler = () => {
        aborted = true;
        if (req) req.abort();
        logStream.destroy();
        if (!("destroyed" in responseStream) || !responseStream.destroyed) {
          responseStream.end();
        }
      };

      if (abortSignal.aborted) {
        abortHandler();
        return;
      }

      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    responseStream.on("close", () => {
      aborted = true;
      if (req) req.abort();
      if (logStream.destroy) logStream.destroy();
      if (abortSignal && abortHandler) {
        abortSignal.removeEventListener("abort", abortHandler);
      }
    });
  }

  /**
   * Write a one-shot snapshot of pod status + K8s events to the stream
   * WITHOUT ending it. Used by streamLogs to show useful info while we
   * wait for the pod to become Ready.
   */
  private async writeEventsSnapshot(
    responseStream: NodeJS.WritableStream,
  ): Promise<void> {
    try {
      const anyPod = await this.findAnyPodForDeployment();

      let output = "=== MCP Server Status ===\n\n";
      if (anyPod) {
        output += "--- Pod Status ---\n";
        output += this.getPodStatusInfo(anyPod);
        output += "\n\n";
      } else {
        output += "No pod found for this deployment.\n\n";
      }

      output += "--- Kubernetes Events ---\n";
      output += await this.getDeploymentEvents();
      output += "\n";

      if (!("destroyed" in responseStream) || !responseStream.destroyed) {
        responseStream.write(output);
      }
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to write events snapshot for ${this.deploymentName}`,
      );
      if (!("destroyed" in responseStream) || !responseStream.destroyed) {
        responseStream.write(
          `Error fetching deployment status: ${error instanceof Error ? error.message : "Unknown error"}\n`,
        );
      }
    }
  }

  /**
   * Poll for the mcp-server container to enter Ready+Running state, then
   * upgrade the open stream to live container logs. Bounded so a stuck
   * pod can't keep a WebSocket alive forever — the client can re-subscribe.
   */
  private async pollAndStreamLogsWhenReady(
    responseStream: NodeJS.WritableStream,
    lines: number,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const pollIntervalMs = 2000;
    const maxAttempts = Math.ceil(POD_READY_WAIT_MS / pollIntervalMs);

    const isStreamClosed = () =>
      "destroyed" in responseStream && responseStream.destroyed;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (abortSignal?.aborted || isStreamClosed()) return;

      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(t);
          resolve();
        };
        // Remove the abort listener on the normal timeout path — otherwise
        // one listener per iteration accumulates on the long-lived signal.
        const t = setTimeout(() => {
          abortSignal?.removeEventListener("abort", onAbort);
          resolve();
        }, pollIntervalMs);
        abortSignal?.addEventListener("abort", onAbort, { once: true });
      });

      if (abortSignal?.aborted || isStreamClosed()) return;

      let pod: k8s.V1Pod | undefined;
      try {
        pod = await this.findAnyPodForDeployment();
      } catch (error) {
        logger.warn(
          { err: error, deployment: this.deploymentName },
          "Failed to poll pod while waiting for Ready",
        );
        continue;
      }

      const containerStatus = pod?.status?.containerStatuses?.find(
        (cs) => cs.name === "mcp-server",
      );
      const isReadyAndRunning =
        pod?.status?.phase === "Running" &&
        !!containerStatus?.ready &&
        !!containerStatus.state?.running;

      if (!isReadyAndRunning || !pod?.metadata?.name) continue;

      if (!("destroyed" in responseStream) || !responseStream.destroyed) {
        responseStream.write(
          `\n--- Pod ${pod.metadata.name} is now Running, switching to live logs ---\n\n`,
        );
      }
      await this.streamRunningPodLogs(pod, responseStream, lines, abortSignal);
      return;
    }

    if (!("destroyed" in responseStream) || !responseStream.destroyed) {
      responseStream.write(
        `\n--- Pod did not become Ready within ${Math.round(POD_READY_WAIT_MS / 1000)}s; reopen logs to retry ---\n`,
      );
      responseStream.end();
    }
  }

  /**
   * Re-evaluate the deployment state from the actual K8s pod status.
   * Called periodically by the status polling to detect state changes
   * (e.g. a running pod entering CrashLoopBackOff).
   */
  async refreshState(options?: RefreshStateOptions): Promise<void> {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // Everything below is derived from cluster reads taken across several
    // awaits. A hibernate or wake starting in the meantime makes all of it
    // stale, so each read is followed by a generation check that abandons this
    // refresh rather than overwriting the transition's state.
    const hibernationOptions = options as
      | HibernationRefreshStateOptions
      | undefined;
    const generation = this.stateGeneration;
    // SPDX-SnippetEnd

    try {
      // Update pod metadata (restarts, age) from the latest pod. Best-effort:
      // a failed lookup is not evidence the pod is gone, so it leaves the
      // cached values alone and the state evaluation below still runs.
      try {
        const anyPod = await this.findAnyPodForDeployment();
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        if (this.stateGeneration !== generation) return;
        // SPDX-SnippetEnd
        if (anyPod) {
          const cs = anyPod.status?.containerStatuses?.find(
            (c) => c.name === "mcp-server",
          );
          this.cachedRestartCount = cs?.restartCount ?? 0;
          this.cachedPodCreationTime = anyPod.metadata?.creationTimestamp
            ? new Date(anyPod.metadata.creationTimestamp)
            : null;
          this.cachedPodName = anyPod.metadata?.name ?? null;
        } else {
          // No pod at all — statusSummary must not keep reporting the last
          // pod's name, age, or restart count as if it still existed.
          this.clearCachedPodTelemetry();
        }
      } catch (error) {
        logger.warn(
          { err: error },
          `Failed to refresh pod telemetry for ${this.deploymentName}`,
        );
      }

      // "failed" is re-evaluated too: it can be a false positive — e.g. a
      // transient API-server error (429/5xx) latched during a reconcile while
      // the pod kept running fine, or a crashloop that has since recovered.
      // A deployment that is verifiably available flips (back) to "running";
      // one that is genuinely broken re-derives the same failed state below.
      let canRefresh =
        this.state === "not_created" ||
        this.state === "pending" ||
        this.state === "running" ||
        this.state === "failed";
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (this.state === "hibernated" || this.state === "waking") {
        canRefresh = true;
      }
      // SPDX-SnippetEnd
      if (!canRefresh) return;

      // Check if deployment has available replicas
      let deployment: k8s.V1Deployment;
      try {
        deployment = await this.k8sAppsApi.readNamespacedDeployment({
          name: this.deploymentName,
          namespace: this.namespace,
        });
      } catch (error) {
        if (!isK8sNotFoundError(error)) throw error;
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        if (this.stateGeneration !== generation) return;
        // SPDX-SnippetEnd
        // The Deployment itself is gone — deleted out-of-band (kubectl, a
        // namespace cleanup, another controller). That is a definitive read,
        // not a flake: converge to not_created instead of advertising a
        // running/hibernated deployment that no longer exists, which nothing
        // else would ever correct.
        const decision = deriveOrdinaryDeploymentState(
          {
            exists: false,
            availableReplicas: 0,
            podFailure: null,
          },
          this.state,
        );
        if (decision.kind === "state" && this.observeState(decision.state)) {
          this.errorMessage = null;
          this.runningMissCount = 0;
          this.clearCachedPodTelemetry();
        }
        return;
      }
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (this.stateGeneration !== generation) return;
      // SPDX-SnippetEnd

      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (K8sDeployment.hasHibernationAnnotation(deployment)) {
        const availableReplicas = deployment.status?.availableReplicas ?? 0;
        const desiredReplicas = deployment.spec?.replicas ?? 0;
        let podFailure: OrdinaryDeploymentFacts["podFailure"] = null;
        let failureMessage: string | null = null;
        if (availableReplicas === 0 && desiredReplicas >= 1) {
          const failureCheck = await this.checkPodContainerStatusesForFailure();
          if (this.stateGeneration !== generation) return;
          if (failureCheck.hasFailed) {
            podFailure = {
              failed: true,
              transient: failureCheck.isTransientImagePull,
            };
            failureMessage = failureCheck.message;
          }
        }

        const decision = deriveHibernationDeploymentState(
          {
            exists: true,
            hasHibernationAnnotation: true,
            replicas: desiredReplicas,
            availableReplicas,
            podFailure,
          },
          this.state,
        );

        if (decision.kind === "finish-wake") {
          this.observeState("waking");
          if (hibernationOptions?.skipWakeCompletion) {
            this.runningMissCount = 0;
            return;
          }
          try {
            await this.completeWake(hibernationOptions);
          } catch (error) {
            logger.warn(
              { err: error },
              `Failed to self-heal wake completion for ${this.deploymentName}; retrying on the next refresh`,
            );
            this.observeState("pending");
          }
          this.runningMissCount = 0;
          return;
        }

        if (decision.kind !== "state") return;
        const stateChanged = decision.state !== this.state;
        this.observeState(decision.state);
        if (podFailure?.failed) {
          this.errorMessage = failureMessage;
          this.runningMissCount = 0;
        } else if (
          stateChanged ||
          decision.state === "hibernated" ||
          decision.state === "waking"
        ) {
          this.errorMessage = null;
          this.runningMissCount = 0;
        }
        return;
      }
      // SPDX-SnippetEnd

      let availableReplicas = deployment.status?.availableReplicas ?? 0;
      if (availableReplicas > 0) {
        const pod = await this.findPodForDeployment();
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        if (this.stateGeneration !== generation) return;
        // SPDX-SnippetEnd
        if (!pod) availableReplicas = 0;
      }

      let podFailure: OrdinaryDeploymentFacts["podFailure"] = null;
      let failureMessage: string | null = null;
      if (availableReplicas === 0) {
        const failureCheck = await this.checkPodContainerStatusesForFailure();
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        if (this.stateGeneration !== generation) return;
        // SPDX-SnippetEnd
        if (failureCheck.hasFailed) {
          podFailure = {
            failed: true,
            transient: failureCheck.isTransientImagePull,
          };
          failureMessage = failureCheck.message;
        }
      }

      let decision = deriveOrdinaryDeploymentState(
        { exists: true, availableReplicas, podFailure },
        this.state,
      );

      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (
        decision.kind === "state" &&
        (decision.state === "hibernated" || decision.state === "waking")
      ) {
        decision = { kind: "state", state: "pending" };
      }
      // SPDX-SnippetEnd

      if (decision.kind === "debounce-running") {
        // Only downgrade a running deployment after several consecutive
        // misses, so a transient K8s API inconsistency can't flicker the UI.
        this.runningMissCount++;
        if (this.runningMissCount >= K8sDeployment.RUNNING_MISS_THRESHOLD) {
          if (this.observeState("pending")) {
            this.errorMessage = null;
          }
          this.runningMissCount = 0;
        }
        return;
      }

      const stateChanged = decision.state !== this.state;
      if (!this.observeState(decision.state)) return;
      if (podFailure?.failed) {
        // "failed" (terminal) or "pending" (an image pull the kubelet retries
        // on its own) — either way, surface WHY.
        this.errorMessage = failureMessage;
        this.runningMissCount = 0;
      } else if (stateChanged || decision.state === "running") {
        // A state backed by a positive cluster fact clears any stale error.
        // A "pending"/"failed" the deployment merely stayed in carries no new
        // evidence, so it keeps the message an earlier refresh recorded.
        this.errorMessage = null;
        this.runningMissCount = 0;
      }
    } catch (error) {
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (hibernationOptions?.throwOnError) throw error;
      // SPDX-SnippetEnd
      if (!isK8sNotFoundError(error)) {
        logger.error(
          { err: error },
          `Failed to refresh state for ${this.deploymentName}`,
        );
      }
    }
  }

  /**
   * Get the deployment's status summary
   */
  get statusSummary(): K8sDeploymentStatusSummary {
    let message = "Deployment not created";
    switch (this.state) {
      case "running":
        message = "Deployment is running";
        break;
      case "pending":
        message = "Deployment is starting";
        break;
      case "failed":
        message = "Deployment failed";
        break;
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      case "waking":
        message = "Waking (from idle)";
        break;
      case "hibernated":
        message = "Hibernated (idle)";
        break;
      // SPDX-SnippetEnd
    }

    return {
      state: this.state,
      message,
      error: this.errorMessage,
      serverName: this.mcpServer.name,
      deploymentName: this.deploymentName,
      namespace: this.namespace,
      restartCount: this.cachedRestartCount,
      podAge: this.cachedPodCreationTime
        ? K8sDeployment.formatAge(this.cachedPodCreationTime)
        : undefined,
      podName: this.cachedPodName ?? undefined,
    };
  }

  private static formatAge(createdAt: Date): string {
    const diffMs = Date.now() - createdAt.getTime();
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

  get containerName(): string {
    // Return the deployment name (label selector will find the pod)
    return this.deploymentName;
  }

  /**
   * Get the Kubernetes Attach API client
   */
  get k8sAttachClient(): Attach {
    return this.k8sAttach;
  }

  /**
   * Get the Kubernetes namespace
   */
  get k8sNamespace(): string {
    return this.namespace;
  }

  /**
   * Get the deployment name
   */
  get k8sDeploymentName(): string {
    return this.deploymentName;
  }

  /**
   * Check if this pod uses streamable HTTP transport
   */
  async usesStreamableHttp(): Promise<boolean> {
    return await this.needsHttpPort();
  }

  /**
   * Get the name of the currently running pod for this deployment.
   * Useful for attaching to the pod or streaming logs.
   */
  async getRunningPodName(): Promise<string | undefined> {
    const pod = await this.findPodForDeployment();
    return pod?.metadata?.name;
  }

  /**
   * Get an HTTP endpoint URL pinned to the currently running pod.
   * Useful for sticky session resumption in multi-replica streamable-http deployments.
   */
  async getRunningPodHttpEndpoint(): Promise<
    { endpointUrl: string; podName: string } | undefined
  > {
    const needsHttp = await this.needsHttpPort();
    if (!needsHttp) {
      return undefined;
    }

    const pod = await this.findPodForDeployment();
    const podIp = pod?.status?.podIP;
    const podName = pod?.metadata?.name;
    if (!podIp || !podName) {
      return undefined;
    }

    const catalogItem = await this.getCatalogItem();
    const httpPort = catalogItem?.localConfig?.httpPort || 8080;
    const httpPath = catalogItem?.localConfig?.httpPath || "/mcp";

    return {
      endpointUrl: `http://${podIp}:${httpPort}${httpPath}`,
      podName,
    };
  }

  /**
   * Get the HTTP endpoint URL for streamable-http servers
   */
  getHttpEndpointUrl(): string | undefined {
    return this.httpEndpointUrl;
  }

  /**
   * Exec into the container, spawning an interactive shell.
   * Returns the K8s WebSocket for the caller to bridge to a browser WebSocket.
   */
  async execIntoContainer(
    stdin: import("node:stream").Readable,
    stdout: import("node:stream").Writable,
    stderr: import("node:stream").Writable,
    options: {
      command?: string[];
      /**
       * Invoked with the K8s exec status when the session ends. A `Failure`
       * status carries the real reason (e.g. `/bin/sh` not found on a
       * distroless image), which is otherwise dropped on the floor.
       */
      onStatus?: (status: k8s.V1Status) => void;
    } = {},
  ) {
    const { command = ["/bin/sh"], onStatus } = options;
    const pod = await this.findPodForDeployment();
    if (!pod?.metadata?.name) {
      throw new Error("No running pod found for this deployment");
    }

    const podName = pod.metadata.name;
    const k8sWs = await this.k8sExec.exec(
      this.namespace,
      podName,
      "mcp-server",
      command,
      stdout,
      stderr,
      stdin,
      true, // tty
      onStatus,
    );

    return { k8sWs, podName };
  }
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// The only scheduling wordings an autoscaler, a rescheduled neighbour or a
// quota change can clear on their own. kube-scheduler's NodeResourcesFit
// plugin says "Insufficient <resource>" for every resource kind (cpu, memory,
// ephemeral-storage, extended resources) and "Too many pods" when a node is at
// its pod cap; admission says "exceeded quota" when the namespace
// ResourceQuota is full.
const CAPACITY_PRESSURE_PATTERNS = [
  /\binsufficient\b/i,
  /\btoo many pods\b/i,
  /\bexceeded quota\b/i,
];

/**
 * Whether the scheduler has already bound the pod to a node. Distinguishes a
 * pod still waiting for capacity from one that got a node and is failing for
 * some later reason (image pull, mount, crash).
 */
function isPodScheduled(pod: k8s.V1Pod): boolean {
  return (pod.status?.conditions ?? []).some(
    (condition) =>
      condition.type === "PodScheduled" && condition.status === "True",
  );
}
// SPDX-SnippetEnd

function listCustomObjectItems(response: unknown): Array<{
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: unknown;
}> {
  if (!response || typeof response !== "object" || !("items" in response)) {
    return [];
  }

  const items = (response as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return [];
  }

  return items.filter(
    (
      item,
    ): item is {
      metadata?: { name?: string; labels?: Record<string, string> };
      spec?: unknown;
    } => Boolean(item) && typeof item === "object",
  );
}

// Bounded optimistic-concurrency retries for the custom-policy read-modify-write
// replace: a CRD controller can bump resourceVersion between the GET and the PUT.
const CUSTOM_POLICY_REPLACE_MAX_ATTEMPTS = 4;

/**
 * Carry the live object's resourceVersion (a CRD replace/PUT is rejected 422
 * without it) and any controller-owned finalizers into the replacement body, so
 * a full replace satisfies optimistic concurrency and doesn't strip finalizers.
 */
function bodyWithPreservedMetadata(
  body: Record<string, unknown>,
  existing: unknown,
): Record<string, unknown> {
  const existingMetadata =
    existing && typeof existing === "object" && "metadata" in existing
      ? ((existing as { metadata?: unknown }).metadata as
          | { resourceVersion?: string; finalizers?: string[] }
          | undefined)
      : undefined;
  const bodyMetadata =
    (body.metadata as Record<string, unknown> | undefined) ?? {};
  return {
    ...body,
    metadata: {
      ...bodyMetadata,
      resourceVersion: existingMetadata?.resourceVersion,
      ...(existingMetadata?.finalizers
        ? { finalizers: existingMetadata.finalizers }
        : {}),
    },
  };
}

function policyTargetsPodLabels(
  spec: unknown,
  podLabels: Record<string, string>,
): boolean {
  const matchLabels = getPolicyMatchLabels(spec);
  if (!matchLabels) {
    return false;
  }

  return Object.entries(podLabels).every(
    ([key, value]) => matchLabels[key] === value,
  );
}

function hasManagedNetworkPolicyLabels(
  labels?: Record<string, string>,
): boolean {
  if (!labels) {
    return false;
  }

  return Object.entries(MANAGED_NETWORK_POLICY_LABELS).every(
    ([key, value]) => labels[key] === value,
  );
}

function getPolicyMatchLabels(
  spec: unknown,
): Record<string, string> | undefined {
  if (!spec || typeof spec !== "object") {
    return undefined;
  }

  const maybeSpec = spec as {
    podSelector?: { matchLabels?: Record<string, string> };
    endpointSelector?: { matchLabels?: Record<string, string> };
  };

  return (
    maybeSpec.podSelector?.matchLabels ??
    normalizeCiliumEndpointLabels(maybeSpec.endpointSelector?.matchLabels)
  );
}

function normalizeCiliumEndpointLabels(
  labels?: Record<string, string>,
): Record<string, string> | undefined {
  if (!labels) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(labels).map(([key, value]) => [
      key.startsWith("k8s:") ? key.slice(4) : key,
      value,
    ]),
  );
}
