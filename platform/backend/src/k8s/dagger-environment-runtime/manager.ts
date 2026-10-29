import type { EnvironmentTarget } from "@archestra/sandbox-rs";
import type * as k8s from "@kubernetes/client-node";
import { PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import config from "@/config";
import { getK8sCapabilities } from "@/k8s/capabilities";
import { clusterDnsResolver } from "@/k8s/cluster-dns";
import { clusterIpFamilyResolver } from "@/k8s/cluster-ip-families";
import {
  fetchPlatformPodNodeSelector,
  fetchPlatformPodTolerations,
} from "@/k8s/mcp-server-runtime/k8s-deployment";
import { constructManagedNetworkPolicyName } from "@/k8s/mcp-server-runtime/network-policy";
import { resolveRuntimeOwnerReferences } from "@/k8s/mcp-server-runtime/runtime-owner";
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

/**
 * All an organization's default engine needs: which organization it belongs to
 * and where it runs. Its egress policy is read per engine, so a full row (with
 * the logos and favicons an engine never looks at) is never fetched for this.
 */
interface OrganizationDefaultEngineTarget {
  id: string;
  defaultEnvironmentNamespace: string | null;
}

/** Where an engine pod may be scheduled. */
interface EngineScheduling {
  nodeSelector: k8s.V1PodSpec["nodeSelector"] | null;
  tolerations: k8s.V1Toleration[] | null;
}

const ENGINE_IMAGE = "registry.dagger.io/engine:v0.21.9";
const ENGINE_CONTAINER = "dagger-engine";
const OWNER_LABEL = "archestra.io/dagger-runtime-owner";
const ORGANIZATION_LABEL = "archestra.io/dagger-organization";
// Engine resources (cpu/memory requests, memory limit, buildkit cache PVC size)
// come from config so small/local clusters can override the defaults. No CPU
// limit (build throughput). The memory limit caps the buildkit daemon; the
// sandboxes it runs are capped separately by `engineStartupScript` below,
// because buildkit puts them in a cgroup beside this pod rather than under it.
// Their usage therefore does not appear in `kubectl top pod`, so the memory
// request has to reserve node capacity for both.
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
    organization: OrganizationDefaultEngineTarget,
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

    let organizations: OrganizationDefaultEngineTarget[];
    try {
      organizations = await OrganizationModel.listDefaultEngineTargets();
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
    await this.cleanupOrphanedEngines();
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
    const organization =
      await OrganizationModel.getDefaultEngineTarget(organizationId);
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
    // A startup/update snapshot may already have been deleted by another pod.
    // Re-read before provisioning AND after its final mutation: deletion wins
    // even when an in-flight Kubernetes create finishes after teardown.
    const current = await EnvironmentModel.findByIdForOrganization(
      environment.id,
      environment.organizationId,
    );
    if (!current) return;
    const namespace = this.engineNamespace(current.namespace);
    try {
      await this.reconcileEngine({
        engineId: current.id,
        organizationId: current.organizationId,
        namespace,
        networkPolicyOverride: current.networkPolicy,
      });
    } finally {
      const latest = await EnvironmentModel.findByIdForOrganization(
        current.id,
        current.organizationId,
      );
      if (!latest || this.engineNamespace(latest.namespace) !== namespace) {
        await this.teardownEngine(current.id, namespace);
      }
    }
  }

  /**
   * Only prune an engine we can attribute to this installation. UUID-shaped
   * names alone are insufficient in a namespace shared by multiple releases.
   * Legacy resources require a successful environment audit snapshot in THIS
   * database. Without that evidence they are left for operator review.
   */
  private async cleanupOrphanedEngines(): Promise<void> {
    const namespaces = new Set([
      getK8sNamespace(),
      ...config.orchestrator.kubernetes.environmentNamespaces,
    ]);
    for (const namespace of namespaces) {
      try {
        const { kubeConfig } = loadKubeConfig();
        const clients = createK8sClients(kubeConfig, namespace);
        const owner = (
          await resolveRuntimeOwnerReferences(clients.rbacApi, namespace)
        )?.[0]?.uid;
        const candidates = new Map<
          string,
          { owned: boolean; foreign: boolean; organizationIds: Set<string> }
        >();
        const add = (
          metadata: k8s.V1ObjectMeta | undefined,
          pattern: RegExp,
        ) => {
          const id = metadata?.name?.match(pattern)?.[1];
          if (!id) return;
          const record = candidates.get(id) ?? {
            owned: false,
            foreign: false,
            organizationIds: new Set<string>(),
          };
          const resourceOwner = metadata?.labels?.[OWNER_LABEL];
          if (resourceOwner) {
            if (resourceOwner === owner) record.owned = true;
            else record.foreign = true;
          }
          const organization = metadata?.labels?.[ORGANIZATION_LABEL];
          if (organization) record.organizationIds.add(organization);
          candidates.set(id, record);
        };
        const uuid =
          "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
        const list = async <T extends { metadata?: k8s.V1ObjectMeta }>(
          fetch: (
            continuation?: string,
          ) => Promise<{ items: T[]; metadata?: k8s.V1ListMeta }>,
          pattern: RegExp,
        ) => {
          let continuation: string | undefined;
          do {
            const page = await fetch(continuation);
            for (const resource of page.items) add(resource.metadata, pattern);
            continuation = page.metadata?._continue;
          } while (continuation);
        };
        await list(
          (continuation) =>
            clients.appsApi.listNamespacedStatefulSet({
              namespace,
              labelSelector: "app=dagger-engine",
              limit: 200,
              _continue: continuation,
            }),
          new RegExp(`^dagger-engine-${uuid}$`),
        );
        await list(
          (continuation) =>
            clients.coreApi.listNamespacedConfigMap({
              namespace,
              labelSelector: "app=dagger-engine",
              limit: 200,
              _continue: continuation,
            }),
          new RegExp(`^dagger-engine-${uuid}-config$`),
        );
        // Old volumeClaimTemplates had no labels. The exact cache claim name
        // is only a candidate; owner/audit evidence is still required below.
        await list(
          (continuation) =>
            clients.coreApi.listNamespacedPersistentVolumeClaim({
              namespace,
              limit: 200,
              _continue: continuation,
            }),
          new RegExp(`^varlib-dagger-engine-${uuid}-0$`),
        );

        const history = await EnvironmentModel.findHistoricalNamespaces([
          ...candidates.keys(),
        ]);
        // Read after Kubernetes enumeration so a newly-created organization's
        // default engine cannot be mistaken for a deleted Environment.
        const defaults = await OrganizationModel.listDefaultEngineTargets();
        const defaultIds = new Set(
          defaults.map((org) => deriveOrgEngineId(org.id)),
        );
        for (const [id, candidate] of candidates) {
          if (candidate.foreign || defaultIds.has(id)) continue;
          // An explicitly shared external runtime-owner Role is not a database
          // identity. Require the resource's organization to exist here too.
          if (
            [...candidate.organizationIds].some((org) => !defaultIds.has(org))
          )
            continue;
          const historicalOwner = history.some(
            (record) =>
              record.id === id &&
              ((record.hasBeforeNamespace &&
                this.engineNamespace(record.beforeNamespace) === namespace) ||
                (record.hasAfterNamespace &&
                  this.engineNamespace(record.afterNamespace) === namespace)),
          );
          const owned =
            candidate.organizationIds.size > 0 && (!owner || candidate.owned);
          if (!owned && !historicalOwner) continue;
          const current = await EnvironmentModel.findById(id);
          if (current && this.engineNamespace(current.namespace) === namespace)
            continue;
          await this.teardownEngine(id, namespace);
        }
      } catch (err) {
        // Failed list/DB/ownership reads never become an empty desired set.
        logger.warn(
          { err, namespace },
          "[DaggerEnvRuntime] orphan cleanup failed; will retry on next startup",
        );
      }
    }
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
    organization: OrganizationDefaultEngineTarget,
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

  /**
   * Delete the org-default engine from a namespace it no longer lives in.
   * `reconcileOrganizationDefault` provisions the engine in the org's current
   * namespace but leaves any engine in the previous one; without this a default
   * namespace change strands a privileged pod and its Retain-policy cache PVC in
   * the old namespace. Call after reconciling the new engine, with the
   * pre-change namespace. Best-effort and idempotent.
   */
  async teardownOrganizationDefaultEngine(
    organization: OrganizationDefaultEngineTarget,
    previousNamespace: string | null | undefined,
  ): Promise<void> {
    if (!this.isEnabled()) return;
    if (config.daggerRuntime.runnerHost) return;
    const from = this.engineNamespace(previousNamespace);
    const to = this.engineNamespace(organization.defaultEnvironmentNamespace);
    // Both resolve to the same namespace (e.g. the old value was invalid and
    // fell back to the release namespace, same as the new), so the engine never
    // moved — tearing `from` down would delete the engine just reconciled.
    if (from === to) return;
    await this.teardownEngine(deriveOrgEngineId(organization.id), from);
  }

  /**
   * Delete an environment's engine when the environment is removed. A deleted
   * environment otherwise leaves its privileged StatefulSet and retained cache
   * PVC running with nothing routing to them. Mirrors reconcileEnvironment's
   * guard — a per-environment engine exists even behind a BYO runner host, so
   * this does not early-return on one. Best-effort and idempotent.
   */
  async teardownEnvironmentEngine(environment: Environment): Promise<void> {
    if (!this.isEnabled()) return;
    await this.teardownEngine(
      environment.id,
      this.engineNamespace(environment.namespace),
    );
  }

  // Remove one engine's StatefulSet, its cache PVC (the volumeClaimTemplate is
  // Retain, so deleting the StatefulSet alone would strand it — safe to drop
  // here since the build cache is rebuildable and the engine has left this
  // namespace), ConfigMap, and every managed egress policy kind. Each delete is
  // idempotent: an already-absent object is not an error.
  private async teardownEngine(
    engineId: string,
    namespace: string,
  ): Promise<void> {
    const { kubeConfig } = loadKubeConfig();
    const clients = createK8sClients(kubeConfig, namespace);
    const name = daggerEngineDeploymentName(engineId);

    const workloadRemoved = await this.deleteIfPresent(
      "StatefulSet",
      namespace,
      name,
      () =>
        clients.appsApi.deleteNamespacedStatefulSet({
          name,
          namespace,
          propagationPolicy: "Foreground",
        }),
    );
    // Keep storage, config and egress protection intact if the workload could
    // not be removed. A later reconciliation retries from the remaining objects.
    if (!workloadRemoved) return;
    // DELETE acknowledges termination, not pod exit. Foreground deletion keeps
    // the StatefulSet until its pods exit. Preserve protection until then.
    const terminationDeadline = Date.now() + 35_000;
    while (true) {
      try {
        await clients.appsApi.readNamespacedStatefulSet({ name, namespace });
      } catch (err) {
        if (!isK8sNotFoundError(err)) throw err;
        break;
      }
      if (Date.now() >= terminationDeadline) {
        logger.warn(
          { engineId, namespace },
          "[DaggerEnvRuntime] engine termination still pending; retaining resources for next startup",
        );
        return;
      }
      // A bounded wait for this deletion, not a recurring orphan-sweep job.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const cacheRemoved = await this.deleteIfPresent(
      "PersistentVolumeClaim",
      namespace,
      `varlib-${name}-0`,
      () =>
        clients.coreApi.deleteNamespacedPersistentVolumeClaim({
          name: `varlib-${name}-0`,
          namespace,
        }),
    );
    if (!cacheRemoved) return;
    const policiesRemoved = await this.pruneStalePolicies(
      clients,
      namespace,
      constructManagedNetworkPolicyName(name),
      new Set(),
    );
    if (!policiesRemoved) return;
    // Keep the owned ConfigMap as a durable retry marker until everything else
    // is gone, including an old cache PVC that has no ownership labels.
    await this.deleteIfPresent(
      "ConfigMap",
      namespace,
      engineConfigMapName(engineId),
      () =>
        clients.coreApi.deleteNamespacedConfigMap({
          name: engineConfigMapName(engineId),
          namespace,
        }),
    );
  }

  // Returns true when the object is gone (deleted now, or already absent),
  // false when the delete failed and it may still exist.
  private async deleteIfPresent(
    kind: string,
    namespace: string,
    name: string,
    del: () => Promise<unknown>,
  ): Promise<boolean> {
    try {
      await del();
      return true;
    } catch (error) {
      if (isK8sNotFoundError(error)) {
        return true;
      }
      logger.warn(
        { err: error, namespace, name, kind },
        "[DaggerEnvRuntime] failed to delete engine resource on teardown",
      );
      return false;
    }
  }

  private async reconcileEngine(target: EngineReconcileTarget): Promise<void> {
    const { engineId, namespace } = target;
    const { kubeConfig } = loadKubeConfig();
    const clients = createK8sClients(kubeConfig, namespace);
    const owner = (
      await resolveRuntimeOwnerReferences(clients.rbacApi, namespace)
    )?.[0]?.uid;
    const ownershipLabels: Record<string, string> = {
      [ORGANIZATION_LABEL]: deriveOrgEngineId(target.organizationId),
      ...(owner ? { [OWNER_LABEL]: owner } : {}),
    };

    // Must precede the StatefulSet: a new engine pod mounts this ConfigMap and
    // would be stuck in ContainerCreating (failed mount) if it didn't exist yet.
    await this.applyEngineConfig(
      clients.coreApi,
      engineId,
      namespace,
      ownershipLabels,
    );
    await this.applyEngineStatefulSet(
      clients.appsApi,
      engineId,
      namespace,
      await this.resolveEngineScheduling(),
      ownershipLabels,
    );

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
      clusterIpFamilies: await clusterIpFamilyResolver.getIpFamilies({
        coreApi: clients.coreApi,
        namespace,
        clusterDnsIps,
      }),
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
    const defaultNetworkPolicy =
      await OrganizationModel.getDefaultNetworkPolicy(target.organizationId);
    return resolveEffectiveNetworkPolicy({
      organizationId: target.organizationId,
      environmentId: target.engineId,
      environmentNetworkPolicy: target.networkPolicyOverride,
      defaultNetworkPolicy,
    });
  }

  // Engines land where the platform runs unless an operator names a pool of
  // their own, matching MCP server pods. Without this, a platform pinned to a
  // tainted pool leaves its engines Pending (no toleration) or on nodes outside
  // that pool (no selector). The platform pod lookup is cached and never
  // throws; a failed lookup falls back to default scheduling.
  private async resolveEngineScheduling(): Promise<EngineScheduling> {
    const override = config.daggerRuntime.engine.nodeSelector;
    if (Object.keys(override).length > 0) {
      return {
        nodeSelector: override,
        tolerations: Object.entries(override).map(([key, value]) => ({
          key,
          operator: "Equal",
          value,
          effect: "NoSchedule",
        })),
      };
    }
    const platformNamespace = process.env.POD_NAMESPACE || getK8sNamespace();
    const { kubeConfig } = loadKubeConfig();
    const { coreApi } = createK8sClients(kubeConfig, platformNamespace);
    return {
      nodeSelector: await fetchPlatformPodNodeSelector(
        coreApi,
        platformNamespace,
      ),
      tolerations: await fetchPlatformPodTolerations(
        coreApi,
        platformNamespace,
      ),
    };
  }

  private async applyEngineStatefulSet(
    appsApi: k8s.AppsV1Api,
    engineId: string,
    namespace: string,
    scheduling: EngineScheduling,
    ownershipLabels: Record<string, string> = {},
  ): Promise<void> {
    try {
      await appsApi.createNamespacedStatefulSet({
        namespace,
        body: this.buildEngineStatefulSet(
          engineId,
          namespace,
          scheduling,
          ownershipLabels,
        ),
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      // Engine already exists — left as-is. Image/resource changes do NOT roll
      // out on reconcile (a deliberate limitation: the engine is long-lived and
      // rarely changes; bumping ENGINE_IMAGE needs a manual StatefulSet delete).
      // The per-reconcile mutation a target actually drives — its egress policy
      // — is applied below via the NetworkPolicy, not the engine spec.
      await this.warnIfEngineOutdated(appsApi, engineId, namespace, scheduling);
    }
  }

  /**
   * An existing engine keeps the spec it was created with for as long as it
   * lives. One created before the sandbox memory cap goes on running sandboxes
   * unbounded, and one created before engines inherited the platform's
   * scheduling can sit Pending or on the wrong nodes. Nothing repairs either on
   * its own — say so, since the alternative is a silent gap the deployment does
   * not know it has.
   */
  private async warnIfEngineOutdated(
    appsApi: k8s.AppsV1Api,
    engineId: string,
    namespace: string,
    scheduling: EngineScheduling,
  ): Promise<void> {
    const name = daggerEngineDeploymentName(engineId);
    try {
      const existing = await appsApi.readNamespacedStatefulSet({
        name,
        namespace,
      });
      const podSpec = existing.spec?.template.spec;
      const command = podSpec?.containers[0]?.command?.join("\n") ?? "";
      if (!command.includes(sandboxCgroupName(engineId))) {
        logger.warn(
          { engineId, namespace, statefulSet: name },
          "[DaggerEnvRuntime] engine predates the sandbox memory cap and runs sandboxes unbounded; delete the StatefulSet to recreate it",
        );
      }
      if (
        schedulingKey(podSpec?.nodeSelector, podSpec?.tolerations) !==
        schedulingKey(scheduling.nodeSelector, scheduling.tolerations)
      ) {
        logger.warn(
          { engineId, namespace, statefulSet: name },
          "[DaggerEnvRuntime] engine nodeSelector/tolerations differ from the desired scheduling; delete the StatefulSet to recreate it",
        );
      }
    } catch (error) {
      logger.debug(
        { err: error, engineId, namespace },
        "[DaggerEnvRuntime] could not check whether the engine spec is current",
      );
    }
  }

  private async applyEngineConfig(
    coreApi: k8s.CoreV1Api,
    engineId: string,
    namespace: string,
    ownershipLabels: Record<string, string> = {},
  ): Promise<void> {
    const name = engineConfigMapName(engineId);
    const body: k8s.V1ConfigMap = {
      metadata: {
        name,
        namespace,
        labels: { ...daggerEnginePodLabels(engineId), ...ownershipLabels },
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
    scheduling: EngineScheduling,
    ownershipLabels: Record<string, string> = {},
  ): k8s.V1StatefulSet {
    const name = daggerEngineDeploymentName(engineId);
    const labels = daggerEnginePodLabels(engineId);
    const engine = config.daggerRuntime.engine;
    return {
      apiVersion: "apps/v1",
      kind: "StatefulSet",
      metadata: { name, namespace, labels: { ...labels, ...ownershipLabels } },
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
            ...(scheduling.nodeSelector &&
            Object.keys(scheduling.nodeSelector).length > 0
              ? { nodeSelector: scheduling.nodeSelector }
              : {}),
            ...(scheduling.tolerations?.length
              ? { tolerations: scheduling.tolerations }
              : {}),
            containers: [
              {
                name: ENGINE_CONTAINER,
                image: ENGINE_IMAGE,
                command: [
                  "/bin/sh",
                  "-c",
                  engineStartupScript(engineId, engine.sandboxMemoryMaxBytes),
                ],
                lifecycle: {
                  // The sandbox cgroup is created in the host's tree, so it
                  // outlives the pod that made it and nothing else reaps it.
                  preStop: {
                    exec: {
                      command: [
                        "/bin/sh",
                        "-c",
                        `rmdir ${sandboxCgroupPath(engineId)} 2>/dev/null || true`,
                      ],
                    },
                  },
                },
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
            metadata: {
              name: "varlib",
              labels: { ...labels, ...ownershipLabels },
            },
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
  ): Promise<boolean> {
    let removed = true;
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
          removed = false;
          logger.warn(
            { err: error, namespace, policyName, kind },
            "[DaggerEnvRuntime] failed to prune stale policy",
          );
        }
      }
    }
    return removed;
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

/**
 * Bounds an engine's sandbox containers, then hands off to the image's own
 * entrypoint.
 *
 * Nothing otherwise limits what the sandboxes hold: buildkit runs them in a
 * cgroup beside the engine pod rather than under it, so no Kubernetes limit
 * reaches them, and the per-run cap is an RLIMIT_AS, which the kernel applies
 * per process — one run that spawns several holds a multiple of it. Capping
 * that cgroup makes a runaway run die on its own while the daemon and every
 * other run keep going. The pod's own limit is deliberately not used for this:
 * the kernel would OOM-kill the engine container instead, taking every
 * in-flight run with it.
 *
 * The cgroup is named per engine because a privileged pod sees the host's
 * cgroup tree, so engines sharing a node would otherwise share one budget and
 * one environment's sandboxes could starve another's. `defaultCgroupParent` is
 * what points buildkit at it, and lives in the legacy `engine.toml` because
 * `engine.json` has no worker settings; the two are read together, with
 * `engine.json` winning per option, so the hardening it carries still applies.
 *
 * The cap is applied before the engine starts, and retried in the background
 * where the memory controller is not delegated yet. That retry is detached so a
 * cluster which never delegates it (cgroup v1) leaves the engine serving
 * unbounded sandboxes rather than crash-looping with no repair, since engine
 * StatefulSets are created once and never reconciled.
 */
function engineStartupScript(
  engineId: string,
  sandboxMemoryMaxBytes: number,
): string {
  const cgroup = sandboxCgroupName(engineId);
  const path = sandboxCgroupPath(engineId);
  return [
    "set -eu",
    `printf '[worker.oci]\\n  defaultCgroupParent = "/${cgroup}"\\n' > /etc/dagger/engine.toml`,
    "cap() {",
    `  mkdir -p ${path} 2>/dev/null &&`,
    `  echo ${sandboxMemoryMaxBytes} > ${path}/memory.max 2>/dev/null &&`,
    // Swap is not bounded by memory.max, and this cgroup is not under kubepods
    // so the kubelet's swap policy never reaches it. Absent on kernels built
    // without swap accounting, hence best-effort.
    `  { echo 0 > ${path}/memory.swap.max 2>/dev/null || true; }`,
    "}",
    "if ! cap; then",
    "  (",
    "    i=0",
    "    while [ $i -lt 60 ]; do",
    "      if cap; then exit 0; fi",
    "      i=$((i + 1))",
    "      sleep 1",
    "    done",
    "    echo 'archestra: sandbox memory is NOT capped (needs cgroup v2)' >&2",
    "  ) &",
    "fi",
    "exec /usr/local/bin/dagger-entrypoint.sh",
  ].join("\n");
}

// Order-insensitive identity of a pod's scheduling, so an engine read back from
// the API compares equal to the desired spec regardless of key order.
function schedulingKey(
  nodeSelector: Record<string, string> | null | undefined,
  tolerations: k8s.V1Toleration[] | null | undefined,
): string {
  const sortedEntries = (record: object) =>
    Object.entries(record)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    nodeSelector: sortedEntries(nodeSelector ?? {}),
    tolerations: (tolerations ?? []).map(sortedEntries),
  });
}

function sandboxCgroupName(engineId: string): string {
  return `archestra-sandbox-${engineId}`;
}

function sandboxCgroupPath(engineId: string): string {
  return `/sys/fs/cgroup/${sandboxCgroupName(engineId)}`;
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
