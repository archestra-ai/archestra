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
import type { Environment } from "@/types";
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

const ENGINE_IMAGE = "registry.dagger.io/engine:v0.21.5";
const ENGINE_CONTAINER = "dagger-engine";
// Per-env buildkit cache PVC size; matches the default engine's chart PVC.
const ENGINE_CACHE_SIZE = "50Gi";
// Engine resources mirror the dagger-runtime chart — we run few per-env engines,
// so the chart's sizing applies directly. No CPU limit (build throughput), also
// per the chart; the memory limit caps a runaway build so it can't OOM the node.
const ENGINE_CPU_REQUEST = "2";
const ENGINE_MEMORY_REQUEST = "8Gi";
const ENGINE_MEMORY_LIMIT = "16Gi";
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
      namespace: this.engineNamespace(environment),
    };
  }

  /**
   * Provision every environment's engine on startup so environment-bound agents
   * never route to a pod that was never created (the create/update path only
   * covers environments touched after boot). Best-effort; never throws.
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
  }

  /** Provision (or update) the engine + egress policy for every environment. */
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
  }

  /** Provision (or update) one environment's engine pod + egress policy. */
  async reconcileEnvironment(environment: Environment): Promise<void> {
    if (!this.isEnabled()) return;
    const namespace = this.engineNamespace(environment);
    const { kubeConfig } = loadKubeConfig();
    const clients = createK8sClients(kubeConfig, namespace);

    // Must precede the StatefulSet: a new engine pod mounts this ConfigMap and
    // would be stuck in ContainerCreating (failed mount) if it didn't exist yet.
    await this.applyEngineConfig(clients.coreApi, environment, namespace);
    await this.applyEngineStatefulSet(clients.appsApi, environment, namespace);

    const effectivePolicy =
      await this.resolveEngineEffectivePolicy(environment);
    const capabilities = (await getK8sCapabilities()).networkPolicy;
    const clusterDnsIps = await clusterDnsResolver.getClusterDnsIps(
      clients.coreApi,
    );
    const policies = buildDaggerEgressPolicies({
      environmentId: environment.id,
      effectivePolicy,
      capabilities,
      clusterDnsIps,
    });
    const policyName = constructManagedNetworkPolicyName(
      daggerEngineDeploymentName(environment.id),
    );
    // Delete any managed policy kind no longer desired (e.g. the environment was
    // relaxed to unrestricted → empty list → drop the restrictive policy; or the
    // cluster's provider changed) so a stale object can't keep governing the pod.
    const desiredKinds = new Set(policies.map((p) => p.kind));
    await this.pruneStalePolicies(clients, namespace, policyName, desiredKinds);
    await this.applyEgressPolicies(clients, namespace, policies);

    logger.info(
      {
        environmentId: environment.id,
        namespace,
        egressMode: effectivePolicy.policy?.egressMode ?? "none",
        policies: policies.map((p) => p.kind),
      },
      "[DaggerEnvRuntime] reconciled environment engine",
    );
  }

  private isEnabled(): boolean {
    return config.skillsSandbox.enabled && isK8sConfigured();
  }

  // Mirrors the MCP runtime's resolution (the environment's namespace, else the
  // release namespace), so a per-env engine only ever lands where the chart
  // already grants RBAC: a declared `environmentNamespaces` namespace or the
  // release namespace. No namespace is created at runtime.
  private engineNamespace(environment: Environment): string {
    return environment.namespace?.trim() || getK8sNamespace();
  }

  // Threads the org default so an environment that inherits a restricted
  // organization policy locks down the engine too — parity with the MCP server
  // runtime, which passes the same default. Without it, such an environment
  // resolves to the unrestricted built-in policy and the sandbox egresses freely.
  private async resolveEngineEffectivePolicy(environment: Environment) {
    const organization = await OrganizationModel.getById(
      environment.organizationId,
    );
    return resolveEffectiveNetworkPolicy({
      organizationId: environment.organizationId,
      environmentId: environment.id,
      environmentNetworkPolicy: environment.networkPolicy,
      defaultNetworkPolicy: organization?.defaultNetworkPolicy,
    });
  }

  private async applyEngineStatefulSet(
    appsApi: k8s.AppsV1Api,
    environment: Environment,
    namespace: string,
  ): Promise<void> {
    try {
      await appsApi.createNamespacedStatefulSet({
        namespace,
        body: this.buildEngineStatefulSet(environment, namespace),
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      // Engine already exists — left as-is. Image/resource changes do NOT roll
      // out on reconcile (a deliberate limitation: the engine is long-lived and
      // rarely changes; bumping ENGINE_IMAGE needs a manual StatefulSet delete).
      // The per-reconcile mutation an environment actually drives — its egress
      // policy — is applied below via the NetworkPolicy, not the engine spec.
    }
  }

  private async applyEngineConfig(
    coreApi: k8s.CoreV1Api,
    environment: Environment,
    namespace: string,
  ): Promise<void> {
    const name = engineConfigMapName(environment.id);
    const body: k8s.V1ConfigMap = {
      metadata: {
        name,
        namespace,
        labels: daggerEnginePodLabels(environment.id),
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
    environment: Environment,
    namespace: string,
  ): k8s.V1StatefulSet {
    const name = daggerEngineDeploymentName(environment.id);
    const labels = daggerEnginePodLabels(environment.id);
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
                    cpu: ENGINE_CPU_REQUEST,
                    memory: ENGINE_MEMORY_REQUEST,
                  },
                  limits: { memory: ENGINE_MEMORY_LIMIT },
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
                configMap: { name: engineConfigMapName(environment.id) },
              },
            ],
          },
        },
        // Persistent buildkit cache (warm base + layers): the single replica gets
        // its own PVC that re-attaches across restarts, so the engine reuses its
        // warm base instead of cold-rebuilding (matches the default engine's PVC).
        volumeClaimTemplates: [
          {
            metadata: { name: "varlib" },
            spec: {
              accessModes: ["ReadWriteOnce"],
              resources: { requests: { storage: ENGINE_CACHE_SIZE } },
            },
          },
        ],
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

function engineConfigMapName(environmentId: string): string {
  return `${daggerEngineDeploymentName(environmentId)}-config`;
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
