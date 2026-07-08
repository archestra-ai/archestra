import type { EnvironmentTarget } from "@archestra/sandbox-rs";
import type * as k8s from "@kubernetes/client-node";
import { PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import config from "@/config";
import { getK8sCapabilities } from "@/k8s/capabilities";
import { clusterDnsResolver } from "@/k8s/cluster-dns";
import { constructManagedNetworkPolicyName } from "@/k8s/mcp-server-runtime/network-policy";
import {
  createK8sClients,
  getK8sNamespace,
  isK8sConfigured,
  isK8sNotFoundError,
  loadKubeConfig,
} from "@/k8s/shared";
import logger from "@/logging";
import { EnvironmentModel, OrganizationModel } from "@/models";
import { resolveEffectiveNetworkPolicy } from "@/services/environments/network-policy";
import {
  type Environment,
  KubernetesNamespaceSchema,
  type NetworkPolicy,
  type Organization,
} from "@/types";
import { uuidv5 } from "@/utils/uuid";
import {
  buildDaggerEgressPolicies,
  type DaggerEgressPolicyObject,
  daggerEngineDeploymentName,
  daggerEnginePodLabels,
} from "./network-policy";

type PolicyKind = DaggerEgressPolicyObject["kind"];
const ALL_POLICY_KINDS: PolicyKind[] = [
  "NetworkPolicy",
  "CiliumNetworkPolicy",
  "FQDNNetworkPolicy",
  "ApplicationNetworkPolicy",
];

/**
 * The minimal identity + policy inputs to provision one Dagger engine. A
 * per-environment engine (keyed by the environment id, carrying the
 * environment's own network policy) and an organization's default engine
 * (keyed by a derived id, no override so the org default applies) both reduce
 * to this.
 */
interface EngineReconcileTarget {
  engineId: string;
  organizationId: string;
  namespace: string;
  networkPolicyOverride: NetworkPolicy | null;
}

const ENGINE_IMAGE = "registry.dagger.io/engine:v0.21.5";
const ENGINE_CONTAINER = "dagger-engine";
// Engine resources (cpu/memory requests, memory limit, buildkit cache PVC size)
// come from config so small/local clusters can override the production defaults.
// No CPU limit (build throughput); the memory limit caps a runaway build so it
// can't OOM the node.
// Mirrors the chart engine config: disables insecure root capabilities and
// bounds the buildkit GC so the cache PVC can't fill unreclaimed. Read by the
// engine from /etc/dagger/engine.json.
const ENGINE_CONFIG_JSON = JSON.stringify({
  logLevel: "info",
  security: { insecureRootCapabilities: false },
  gc: { maxUsedSpace: "40GB", reservedSpace: "5GB", minFreeSpace: "20%" },
});

/**
 * Provisions one Dagger engine pod per Environment and applies that
 * Environment's egress NetworkPolicy to it (reusing the MCP network-policy
 * builders). An Agent bound to an environment routes its sandbox runs to that
 * environment's engine via the engine's `kube-pod://` runner host, so the
 * sandbox inherits the environment's network access — same machinery as MCP.
 *
 * Engines are provisioned eagerly (reconcile on startup + on environment policy
 * change) so there are no cold starts; with only a handful of environments the
 * standing pods are cheap.
 */
class DaggerEnvironmentRuntimeManager {
  /**
   * The isolation target for an environment's engine, or undefined when k8s
   * isn't configured. The Dagger `kube-pod://` address is built in the
   * sandbox-core backend from this; the engine is provisioned by `reconcile*`.
   */
  environmentTargetForEnvironment(
    environment: Environment,
  ): EnvironmentTarget | undefined {
    if (!isK8sConfigured()) return undefined;
    return {
      environmentId: environment.id,
      namespace: this.engineNamespace(environment.namespace),
    };
  }

  /**
   * The isolation target for an organization's default engine — the runtime an
   * agent with no environment routes to. The engine id is derived from the org
   * id (a non-UUID string) so the address is still a valid `kube-pod://` UUID
   * target; the engine is provisioned by `reconcileOrganizationDefault`.
   */
  organizationDefaultTarget(
    organization: Organization,
  ): EnvironmentTarget | undefined {
    if (!isK8sConfigured()) return undefined;
    return {
      environmentId: deriveOrgEngineId(organization.id),
      namespace: this.engineNamespace(organization.defaultEnvironmentNamespace),
    };
  }

  /**
   * Provision every environment's engine and every organization's default
   * engine on startup, so an agent never routes to a pod that was never created
   * (the create/update paths only cover rows touched after boot). Best-effort;
   * never throws.
   */
  async reconcileAll(): Promise<void> {
    if (!this.isEnabled()) return;
    let environments: Environment[];
    try {
      environments = await EnvironmentModel.listAll();
    } catch (error) {
      logger.error(
        { err: error },
        "[DaggerEnvRuntime] startup reconcile: failed to list environments",
      );
      return;
    }
    for (const environment of environments) {
      try {
        await this.reconcileEnvironment(environment);
      } catch (error) {
        logger.error(
          { err: error, environmentId: environment.id },
          "[DaggerEnvRuntime] startup reconcile failed for environment",
        );
      }
    }

    let organizations: Organization[];
    try {
      organizations = await OrganizationModel.listAll();
    } catch (error) {
      logger.error(
        { err: error },
        "[DaggerEnvRuntime] startup reconcile: failed to list organizations",
      );
      return;
    }
    for (const organization of organizations) {
      try {
        await this.reconcileOrganizationDefault(organization);
      } catch (error) {
        logger.error(
          { err: error, organizationId: organization.id },
          "[DaggerEnvRuntime] startup reconcile failed for organization default",
        );
      }
    }
  }

  /**
   * Provision (or update) every engine for one organization — its environments
   * and its default engine. Best-effort per item.
   */
  async reconcileAllForOrganization(organizationId: string): Promise<void> {
    if (!this.isEnabled()) return;
    const environments =
      await EnvironmentModel.listForOrganization(organizationId);
    for (const environment of environments) {
      try {
        await this.reconcileEnvironment(environment);
      } catch (error) {
        logger.error(
          { err: error, environmentId: environment.id },
          "[DaggerEnvRuntime] failed to reconcile environment engine",
        );
      }
    }
    const organization = await OrganizationModel.getById(organizationId);
    if (!organization) return;
    try {
      await this.reconcileOrganizationDefault(organization);
    } catch (error) {
      logger.error(
        { err: error, organizationId },
        "[DaggerEnvRuntime] failed to reconcile organization default engine",
      );
    }
  }

  /** Provision (or update) one environment's engine pod + egress policy. */
  async reconcileEnvironment(environment: Environment): Promise<void> {
    if (!this.isEnabled()) return;
    await this.reconcileEngine({
      engineId: environment.id,
      organizationId: environment.organizationId,
      namespace: this.engineNamespace(environment.namespace),
      networkPolicyOverride: environment.networkPolicy,
    });
  }

  /**
   * Provision (or update) an organization's default engine — the runtime for
   * agents with no environment. It carries no policy override, so the org's
   * `defaultNetworkPolicy` (or unrestricted, when unset) governs its egress.
   *
   * An operator-supplied runner host already serves every run from an unbound
   * agent (`resolveEnvironmentTarget` returns no target for them), so a default
   * engine would be a privileged pod nothing ever routes to. Per-environment
   * engines are still provisioned in that mode: an environment-bound agent runs
   * on its own engine, never on the shared one, so its egress policy holds.
   */
  async reconcileOrganizationDefault(
    organization: Organization,
  ): Promise<void> {
    if (!this.isEnabled()) return;
    if (config.daggerRuntime.runnerHost) return;
    await this.reconcileEngine({
      engineId: deriveOrgEngineId(organization.id),
      organizationId: organization.id,
      namespace: this.engineNamespace(organization.defaultEnvironmentNamespace),
      networkPolicyOverride: null,
    });
  }

  private async reconcileEngine(target: EngineReconcileTarget): Promise<void> {
    const { engineId, namespace } = target;
    const { kubeConfig } = loadKubeConfig();
    const clients = createK8sClients(kubeConfig, namespace);

    // Must precede the StatefulSet: a new engine pod mounts this ConfigMap and
    // would be stuck in ContainerCreating (failed mount) if it didn't exist yet.
    await this.applyEngineConfig(clients.coreApi, engineId, namespace);
    await this.applyEngineStatefulSet(clients.appsApi, engineId, namespace);

    const effectivePolicy = await this.resolveEngineEffectivePolicy(target);
    const capabilities = (await getK8sCapabilities()).networkPolicy;
    const clusterDnsIps = await clusterDnsResolver.getClusterDnsIps(
      clients.coreApi,
    );
    const policies = buildDaggerEgressPolicies({
      environmentId: engineId,
      effectivePolicy,
      capabilities,
      clusterDnsIps,
      additionalDeniedCidrs: config.daggerRuntime.engine.additionalDeniedCidrs,
    });
    const policyName = constructManagedNetworkPolicyName(
      daggerEngineDeploymentName(engineId),
    );
    // Delete any managed policy kind no longer desired (e.g. the policy was
    // relaxed to unrestricted → empty list → drop the restrictive policy; or the
    // cluster's provider changed) so a stale object can't keep governing the pod.
    const desiredKinds = new Set(policies.map((p) => p.kind));
    await this.pruneStalePolicies(clients, namespace, policyName, desiredKinds);
    await this.applyEgressPolicies(clients, namespace, policies);

    logger.info(
      {
        engineId,
        organizationId: target.organizationId,
        namespace,
        egressMode: effectivePolicy.policy?.egressMode ?? "none",
        policies: policies.map((p) => p.kind),
      },
      "[DaggerEnvRuntime] reconciled engine",
    );
  }

  private isEnabled(): boolean {
    return config.skillsSandbox.enabled && isK8sConfigured();
  }

  // Mirrors the MCP runtime's resolution (the configured namespace, else the
  // release namespace), so an engine only ever lands where the chart already
  // grants RBAC: a declared `environmentNamespaces` namespace or the release
  // namespace. No namespace is created at runtime.
  //
  // A stored namespace can predate the RFC1123 validation on the write path, and
  // it had no runtime effect until engines moved into code. An invalid one would
  // now fail the Kubernetes create AND be rejected by the `kube-pod://` target's
  // NAPI validator, breaking every sandbox run for that org. Fall back to the
  // release namespace — the behaviour those installs already had — rather than
  // wedging them. Provisioning and routing both resolve through here, so they
  // cannot disagree about where the engine lives.
  private engineNamespace(namespace: string | null | undefined): string {
    const trimmed = namespace?.trim();
    if (!trimmed) return getK8sNamespace();
    if (!KubernetesNamespaceSchema.safeParse(trimmed).success) {
      logger.warn(
        { namespace: trimmed },
        "[DaggerEnvRuntime] stored namespace is not a valid Kubernetes namespace; using the release namespace",
      );
      return getK8sNamespace();
    }
    return trimmed;
  }

  // Threads the org default so a target that carries no override still locks
  // down the engine when the organization sets a restricted default policy —
  // parity with the MCP server runtime. Without it, such a target resolves to
  // the unrestricted built-in policy and the sandbox egresses freely.
  private async resolveEngineEffectivePolicy(target: EngineReconcileTarget) {
    const organization = await OrganizationModel.getById(target.organizationId);
    return resolveEffectiveNetworkPolicy({
      organizationId: target.organizationId,
      environmentId: target.engineId,
      environmentNetworkPolicy: target.networkPolicyOverride,
      defaultNetworkPolicy: organization?.defaultNetworkPolicy,
    });
  }

  private async applyEngineStatefulSet(
    appsApi: k8s.AppsV1Api,
    engineId: string,
    namespace: string,
  ): Promise<void> {
    try {
      await appsApi.createNamespacedStatefulSet({
        namespace,
        body: this.buildEngineStatefulSet(engineId, namespace),
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      // Engine already exists — left as-is. Image/resource changes do NOT roll
      // out on reconcile (a deliberate limitation: the engine is long-lived and
      // rarely changes; bumping ENGINE_IMAGE needs a manual StatefulSet delete).
      // The per-reconcile mutation a target actually drives — its egress policy
      // — is applied below via the NetworkPolicy, not the engine spec.
    }
  }

  private async applyEngineConfig(
    coreApi: k8s.CoreV1Api,
    engineId: string,
    namespace: string,
  ): Promise<void> {
    const name = engineConfigMapName(engineId);
    const body: k8s.V1ConfigMap = {
      metadata: {
        name,
        namespace,
        labels: daggerEnginePodLabels(engineId),
      },
      data: { "engine.json": ENGINE_CONFIG_JSON },
    };
    try {
      await coreApi.createNamespacedConfigMap({ namespace, body });
    } catch (error) {
      if (!isConflict(error)) throw error;
      await coreApi.replaceNamespacedConfigMap({ name, namespace, body });
    }
  }

  private buildEngineStatefulSet(
    engineId: string,
    namespace: string,
  ): k8s.V1StatefulSet {
    const name = daggerEngineDeploymentName(engineId);
    const labels = daggerEnginePodLabels(engineId);
    const engine = config.daggerRuntime.engine;
    return {
      apiVersion: "apps/v1",
      kind: "StatefulSet",
      metadata: { name, namespace, labels },
      spec: {
        serviceName: name,
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            terminationGracePeriodSeconds: 30,
            // The engine is reached via exec/attach (`kube-pod://`), never the k8s
            // API, so it gets no ServiceAccount token mounted next to the
            // privileged sandbox workload it runs.
            automountServiceAccountToken: false,
            containers: [
              {
                name: ENGINE_CONTAINER,
                image: ENGINE_IMAGE,
                securityContext: { privileged: true },
                resources: {
                  requests: {
                    cpu: engine.cpuRequest,
                    memory: engine.memoryRequest,
                  },
                  limits: { memory: engine.memoryLimit },
                },
                volumeMounts: [
                  { name: "varlib", mountPath: "/var/lib/dagger" },
                  { name: "run", mountPath: "/run/dagger" },
                  {
                    name: "config",
                    mountPath: "/etc/dagger/engine.json",
                    subPath: "engine.json",
                  },
                ],
              },
            ],
            volumes: [
              // /run/dagger is the runtime socket dir — ephemeral by design.
              { name: "run", emptyDir: { medium: "Memory" } },
              {
                name: "config",
                configMap: { name: engineConfigMapName(engineId) },
              },
            ],
          },
        },
        // Persistent buildkit cache (warm base + layers): the single replica gets
        // its own PVC that re-attaches across restarts, so the engine reuses its
        // warm base instead of cold-rebuilding.
        volumeClaimTemplates: [
          {
            metadata: { name: "varlib" },
            spec: {
              accessModes: ["ReadWriteOnce"],
              resources: { requests: { storage: engine.cacheStorage } },
            },
          },
        ],
        // Keep the cache PVC when the StatefulSet is deleted or scaled to zero,
        // so tearing down an engine doesn't discard its warm buildkit cache.
        persistentVolumeClaimRetentionPolicy: {
          whenDeleted: "Retain",
          whenScaled: "Retain",
        },
      },
    };
  }

  private async applyEgressPolicies(
    clients: ReturnType<typeof createK8sClients>,
    namespace: string,
    policies: DaggerEgressPolicyObject[],
  ): Promise<void> {
    for (const policy of policies) {
      if (policy.kind === "NetworkPolicy") {
        await this.applyNetworkPolicy(
          clients.networkingApi,
          namespace,
          policy.object,
        );
      } else {
        await this.applyCustomPolicy(
          clients.customObjectsApi,
          namespace,
          policy,
        );
      }
    }
  }

  private async pruneStalePolicies(
    clients: ReturnType<typeof createK8sClients>,
    namespace: string,
    policyName: string,
    desiredKinds: Set<PolicyKind>,
  ): Promise<void> {
    for (const kind of ALL_POLICY_KINDS) {
      if (desiredKinds.has(kind)) continue;
      try {
        if (kind === "NetworkPolicy") {
          await clients.networkingApi.deleteNamespacedNetworkPolicy({
            name: policyName,
            namespace,
          });
        } else {
          const { group, version, plural } = CRD_COORDS[kind];
          await clients.customObjectsApi.deleteNamespacedCustomObject({
            group,
            version,
            namespace,
            plural,
            name: policyName,
          });
        }
      } catch (error) {
        // Already absent (or the CRD isn't installed on this cluster) — nothing
        // to prune. Any other failure is logged but must not fail reconcile.
        if (!isK8sNotFoundError(error)) {
          logger.warn(
            { err: error, namespace, policyName, kind },
            "[DaggerEnvRuntime] failed to prune stale policy",
          );
        }
      }
    }
  }

  private async applyNetworkPolicy(
    networkingApi: k8s.NetworkingV1Api,
    namespace: string,
    body: k8s.V1NetworkPolicy,
  ): Promise<void> {
    const name = body.metadata?.name as string;
    try {
      await networkingApi.createNamespacedNetworkPolicy({ namespace, body });
    } catch (error) {
      if (!isConflict(error)) throw error;
      await networkingApi.replaceNamespacedNetworkPolicy({
        name,
        namespace,
        body,
      });
    }
  }

  private async applyCustomPolicy(
    customObjectsApi: k8s.CustomObjectsApi,
    namespace: string,
    policy: Extract<
      DaggerEgressPolicyObject,
      { object: Record<string, unknown> }
    >,
  ): Promise<void> {
    const { group, version, plural } = CRD_COORDS[policy.kind];
    const body = policy.object;
    const name = (body.metadata as { name: string }).name;
    try {
      await customObjectsApi.createNamespacedCustomObject({
        group,
        version,
        namespace,
        plural,
        body,
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      // Merge-patch, not replace (PUT): the AWS ApplicationNetworkPolicy CRD
      // rejects a PUT without metadata.resourceVersion (422), and a merge patch
      // also leaves controller-owned fields like finalizers intact.
      await customObjectsApi.patchNamespacedCustomObject(
        {
          group,
          version,
          namespace,
          plural,
          name,
          body,
        },
        setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
      );
    }
  }
}

function engineConfigMapName(engineId: string): string {
  return `${daggerEngineDeploymentName(engineId)}-config`;
}

// Fixed namespace for deriving an organization's default-engine id. Arbitrary
// but constant, so the derived id is stable across restarts and processes.
const ORG_DEFAULT_ENGINE_NAMESPACE = "a7c3e0d2-6b1f-4e8a-9c5d-2f0b8e4a1d63";

/**
 * Stable engine id for an organization's default Dagger engine. Organization
 * ids are non-UUID strings, but the `kube-pod://` engine address and its NAPI
 * validator require a canonical UUID, so derive one deterministically from the
 * org id. Distinct from any real environment id (a random v4 UUID).
 */
function deriveOrgEngineId(organizationId: string): string {
  return uuidv5(organizationId, ORG_DEFAULT_ENGINE_NAMESPACE);
}

const CRD_COORDS: Record<
  "CiliumNetworkPolicy" | "FQDNNetworkPolicy" | "ApplicationNetworkPolicy",
  { group: string; version: string; plural: string }
> = {
  CiliumNetworkPolicy: {
    group: "cilium.io",
    version: "v2",
    plural: "ciliumnetworkpolicies",
  },
  FQDNNetworkPolicy: {
    group: "networking.gke.io",
    version: "v1alpha1",
    plural: "fqdnnetworkpolicies",
  },
  ApplicationNetworkPolicy: {
    group: "networking.k8s.aws",
    version: "v1alpha1",
    plural: "applicationnetworkpolicies",
  },
};

function isConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === 409) return true;
  if ("statusCode" in error && error.statusCode === 409) return true;
  if (
    "response" in error &&
    error.response &&
    typeof error.response === "object" &&
    "statusCode" in error.response &&
    error.response.statusCode === 409
  ) {
    return true;
  }
  return false;
}

export const daggerEnvironmentRuntimeManager =
  new DaggerEnvironmentRuntimeManager();
