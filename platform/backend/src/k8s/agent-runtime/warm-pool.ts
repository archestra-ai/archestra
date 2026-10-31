import {
  followAgentCatalogImage,
  resolveAgentRuntimeTiers,
  TimeInMs,
} from "@archestra/shared";
import type { CustomObjectsApi } from "@kubernetes/client-node";
import { PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import config from "@/config";
import {
  createK8sClients,
  isK8sConflictError,
  isK8sNotFoundError,
  loadKubeConfig,
} from "@/k8s/shared";
import logger from "@/logging";
import { AgentModel, EnvironmentModel, OrganizationModel } from "@/models";
import {
  AGENT_RUNTIME_CPU_REQUEST_ENV,
  AGENT_RUNTIME_MEMORY_LIMIT_ENV,
  AGENT_RUNTIME_TIER_ENV,
} from "@/services/agent-runtime/runtime-contract";
import {
  agentRuntimeTier,
  resolveRunResources,
  warmPoolReplicas,
} from "@/services/agent-runtime/runtime-tiers";
import { resolveEffectiveNetworkPolicy } from "@/services/environments/network-policy";
import type { AgentRuntimeTier } from "@/types";
import { usesFloatingAgentImageTag } from "./image-pull-policy";
import {
  AGENT_SANDBOX_API,
  type AgentSandbox,
  type KubernetesAgentRunLaunchSpec,
} from "./manifests";
import { AGENT_RUNTIME_WORKSPACE_LABEL, agentRuntimeLabels } from "./naming";
import { AGENT_SANDBOX_EXTENSIONS_API, agentSandboxApi } from "./sandbox-api";
import { warmPoolTemplate } from "./warm-pool-template";

export const SANDBOX_CLAIM_API = {
  ...AGENT_SANDBOX_EXTENSIONS_API,
  plural: "sandboxclaims",
} as const;

/** Logical workspace names stay stable even when the controller assigns a pooled Sandbox. */
export async function readWorkspaceSandbox(params: {
  api: CustomObjectsApi;
  namespace: string;
  name: string;
}): Promise<AgentSandbox> {
  const { api, namespace, name } = params;
  try {
    return (await api.getNamespacedCustomObject({
      ...AGENT_SANDBOX_API,
      namespace,
      name,
    })) as AgentSandbox;
  } catch (error) {
    if (!isK8sNotFoundError(error)) throw error;
    const claim = (await api.getNamespacedCustomObject({
      ...SANDBOX_CLAIM_API,
      namespace,
      name,
    })) as Claim;
    const failure = claim.status?.conditions?.find(
      (condition) =>
        condition.status === "False" &&
        ["InvalidMetadata", "InvalidTemplate", "Forbidden"].includes(
          condition.reason ?? "",
        ),
    );
    if (failure)
      throw new Error(`Agent allocation rejected: ${failure.reason}`);
    const assigned = claim.status?.sandbox?.name;
    if (!assigned) throw error;
    const sandbox = (await api.getNamespacedCustomObject({
      ...AGENT_SANDBOX_API,
      namespace,
      name: assigned,
    })) as AgentSandbox;
    if (
      !claim.metadata.uid ||
      !sandbox.metadata.ownerReferences?.some(
        (owner) =>
          owner.uid === claim.metadata.uid && owner.kind === "SandboxClaim",
      )
    )
      throw new Error("Sandbox does not belong to this Agent allocation");
    return sandbox;
  }
}

class AgentWarmPoolManager {
  private timer: NodeJS.Timeout | undefined;
  private clients: ReturnType<typeof createK8sClients> | undefined;
  private inFlight = false;

  start() {
    if (this.timer) return;
    void this.reconcileSafely();
    this.timer = setInterval(() => void this.reconcileSafely(), 30_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async reconcile() {
    if (this.inFlight || !agentSandboxApi.isInstalled) return;
    this.inFlight = true;
    try {
      if (!this.clients) {
        const { kubeConfig, namespace } = loadKubeConfig();
        this.clients = createK8sClients(kubeConfig, namespace);
      }
      const clients = this.clients;
      const candidates = await AgentModel.listWarmPoolCandidates({
        since: new Date(Date.now() - RECENT_RUN_WINDOW_MS),
      });
      const desired = new Map<
        string,
        {
          namespace: string;
          organizationId: string;
          template: ReturnType<typeof warmPoolTemplate>;
          replicas: number;
        }
      >();
      const [environments, organizations] = await Promise.all([
        EnvironmentModel.listAll(),
        OrganizationModel.listDefaultEngineTargets(),
      ]);
      if (!organizations.length) return;
      const managedSelector = `${MANAGED_SELECTOR},archestra.io/organization-id in (${organizations.map(({ id }) => id).join(",")})`;
      const namespaces = new Set([
        clients.namespace,
        ...environments.flatMap((environment) =>
          environment.namespace ? [environment.namespace] : [],
        ),
        ...organizations.flatMap((organization) =>
          organization.defaultEnvironmentNamespace
            ? [organization.defaultEnvironmentNamespace]
            : [],
        ),
      ]);
      for (const agent of candidates) {
        // Pool the image a launch resolves to, or no claim would ever match.
        const runtime = agent.runtime && {
          ...agent.runtime,
          image: followAgentCatalogImage({
            image: agent.runtime.image,
            catalogImages: config.agentRuntime.catalogImages,
          }),
        };
        if (
          !runtime ||
          runtime.backend !== "kubernetes" ||
          usesFloatingAgentImageTag(runtime.image) ||
          (runtime.privileged && !config.agentRuntime.allowPrivileged)
        )
          continue;
        const namespace =
          agent.namespace ?? agent.defaultNamespace ?? clients.namespace;
        namespaces.add(namespace);
        const tiers = resolveAgentRuntimeTiers(agent.agentRuntimeTiers);
        const tier = agentRuntimeTier(runtime);
        const replicas = warmPoolReplicas(tiers, tier);
        // A tier without spares takes no pool slot from the other Agents.
        if (
          replicas === 0 ||
          desired.size >= config.agentRuntime.warmPoolMaxPools
        )
          continue;
        const effectiveNetworkPolicy = await resolveEffectiveNetworkPolicy({
          organizationId: agent.organizationId,
          environmentId: agent.environmentId,
          environmentNetworkPolicy: agent.environmentPolicy,
          defaultNetworkPolicy: agent.defaultPolicy,
        });
        const template = warmPoolTemplate({
          poolScope: `${agent.organizationId}:${agent.environmentId ?? "default"}`,
          namespace,
          image: runtime.image,
          privileged: runtime.privileged,
          resources: resolveRunResources(tier, tiers),
          tier,
          warmTiers: [],
          workspaceStorageSize: config.agentRuntime.workspaceStorageSize,
          workspaceStorageClass: config.agentRuntime.workspaceStorageClass,
          nodeSelector: config.agentRuntime.nodeSelector,
          imagePullSecrets: [],
          effectiveNetworkPolicy,
          taskId: "",
          agentRuntimeId: "",
          frozenName: "warm",
          command: null,
          env: {},
          secretEnv: {},
          inputFileCount: 0,
          activeDeadlineSeconds: null,
          ownerReferences: undefined,
        });
        desired.set(`${namespace}/${template.name}`, {
          namespace,
          organizationId: agent.organizationId,
          template,
          replicas,
        });
      }
      for (const namespace of namespaces) {
        const existing =
          (await clients.customObjectsApi.listNamespacedCustomObject({
            ...POOL_API,
            namespace,
            labelSelector: managedSelector,
          })) as { items: Array<{ metadata: { name: string } }> };
        const claims =
          (await clients.customObjectsApi.listNamespacedCustomObject({
            ...SANDBOX_CLAIM_API,
            namespace,
            labelSelector: "archestra.io/purpose=agent-runtime",
          })) as { items: Array<{ spec: { warmPoolRef: { name: string } } }> };
        const claimedPools = new Set(
          claims.items.map((claim) => claim.spec.warmPoolRef.name),
        );
        // Retire unused capacity before creating replacements. Claimed Sandboxes have a different owner.
        for (const pool of existing.items) {
          if (desired.has(`${namespace}/${pool.metadata.name}`)) continue;
          if (claimedPools.has(pool.metadata.name)) {
            await clients.customObjectsApi.patchNamespacedCustomObject(
              {
                ...POOL_API,
                namespace,
                name: pool.metadata.name,
                body: { spec: { replicas: 0 } },
              },
              setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
            );
            continue;
          }
          await clients.customObjectsApi.deleteNamespacedCustomObject({
            ...POOL_API,
            namespace,
            name: pool.metadata.name,
            propagationPolicy: "Foreground",
          });
          await clients.customObjectsApi
            .deleteNamespacedCustomObject({
              ...TEMPLATE_API,
              namespace,
              name: pool.metadata.name,
            })
            .catch((error) => {
              if (!isK8sNotFoundError(error)) throw error;
            });
        }
        for (const {
          namespace: target,
          organizationId,
          template,
          replicas,
        } of desired.values()) {
          if (target !== namespace) continue;
          const metadata = {
            name: template.name,
            namespace,
            labels: {
              ...MANAGED_LABELS,
              "archestra.io/organization-id": organizationId,
            },
          };
          // Empty warm workspaces have no egress. Claimed workspaces receive the existing per-run allow policies.
          await clients.networkingApi
            .createNamespacedNetworkPolicy({
              namespace,
              body: {
                metadata: { ...metadata, name: "archestra-warm-workspaces" },
                spec: {
                  podSelector: {
                    matchExpressions: [{ key: POOL_LABEL, operator: "Exists" }],
                  },
                  policyTypes: ["Ingress", "Egress"],
                  ingress: [],
                  egress: [],
                },
              },
            })
            .catch((error) => {
              if (!isK8sConflictError(error)) throw error;
            });
          await clients.customObjectsApi
            .createNamespacedCustomObject({
              ...TEMPLATE_API,
              namespace,
              body: {
                apiVersion: API_VERSION,
                kind: "SandboxTemplate",
                metadata,
                spec: template.spec,
              },
            })
            .catch((error) => {
              if (!isK8sConflictError(error)) throw error;
            });
          await clients.customObjectsApi
            .createNamespacedCustomObject({
              ...POOL_API,
              namespace,
              body: {
                apiVersion: API_VERSION,
                kind: "SandboxWarmPool",
                metadata,
                spec: {
                  replicas,
                  sandboxTemplateRef: { name: template.name },
                  updateStrategy: { type: "Recreate" },
                },
              },
            })
            .catch(async (error) => {
              if (!isK8sConflictError(error)) throw error;
              await clients.customObjectsApi.patchNamespacedCustomObject(
                {
                  ...POOL_API,
                  namespace,
                  name: template.name,
                  body: {
                    metadata: { labels: metadata.labels },
                    spec: { replicas },
                  },
                },
                setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
              );
            });
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Claim a warm Sandbox for the run. The requested tier's pool serves it
   * while that pool has a ready Sandbox. When it is drained or missing, the
   * next larger tier, up to the Agent's largest tier, serves it if that pool
   * has a ready Sandbox, and the run runs at that tier; a smaller tier never
   * does. When neither has one, the run claims from its own pool and waits for
   * it to refill. Null means a cold start.
   */
  async claim(params: {
    api: CustomObjectsApi;
    spec: KubernetesAgentRunLaunchSpec;
  }): Promise<{ tier: AgentRuntimeTier | null } | null> {
    // A pre-started Sandbox keeps the image it pulled when capacity was
    // created. Floating tags must cold-start so every new workspace resolves
    // the current image instead of claiming stale warm capacity.
    if (
      !config.agentRuntime.warmPoolSize ||
      !params.spec.poolScope ||
      usesFloatingAgentImageTag(params.spec.image)
    )
      return null;
    const { api, spec } = params;
    const namespace = spec.namespace;
    // Each candidate is sized as the run's organization sizes that tier.
    const candidates = spec.warmTiers.length
      ? spec.warmTiers.map(({ tier, resources }) => ({
          tier,
          sized: tier === spec.tier ? spec : { ...spec, tier, resources },
        }))
      : [{ tier: spec.tier, sized: spec }];
    let drained: string | undefined;
    for (const { tier, sized } of candidates) {
      const template = warmPoolTemplate(sized);
      let pool: { status?: { readyReplicas?: number } };
      try {
        pool = (await api.getNamespacedCustomObject({
          ...POOL_API,
          namespace,
          name: template.name,
        })) as typeof pool;
      } catch (error) {
        if (isK8sNotFoundError(error)) continue;
        throw error;
      }
      if ((pool.status?.readyReplicas ?? 0) > 0 || candidates.length === 1) {
        await this.createClaim({ api, spec, templateName: template.name });
        return { tier };
      }
      if (tier === spec.tier) drained = template.name;
    }
    if (drained === undefined) return null;
    await this.createClaim({ api, spec, templateName: drained });
    return { tier: spec.tier };
  }

  private async createClaim(params: {
    api: CustomObjectsApi;
    spec: KubernetesAgentRunLaunchSpec;
    templateName: string;
  }): Promise<void> {
    const { api, spec } = params;
    const namespace = spec.namespace;
    const labels = {
      ...agentRuntimeLabels(spec),
      [AGENT_RUNTIME_WORKSPACE_LABEL]: spec.frozenName,
    };
    await api
      .createNamespacedCustomObject({
        ...SANDBOX_CLAIM_API,
        namespace,
        body: {
          apiVersion: API_VERSION,
          kind: "SandboxClaim",
          metadata: {
            name: spec.frozenName,
            namespace,
            labels,
            ownerReferences: spec.ownerReferences,
          },
          spec: {
            warmPoolRef: { name: params.templateName },
            additionalPodMetadata: {
              labels: Object.fromEntries(
                Object.entries(labels).filter(([key]) => key.includes("/")),
              ),
            },
            lifecycle: {
              shutdownPolicy: "Retain",
              ...(spec.activeDeadlineSeconds
                ? {
                    shutdownTime: new Date(
                      Date.now() + spec.activeDeadlineSeconds * 1000,
                    ).toISOString(),
                  }
                : {}),
            },
          },
        },
      })
      .catch((error) => {
        if (!isK8sConflictError(error)) throw error;
      });
  }
  private async reconcileSafely() {
    try {
      await this.reconcile();
    } catch (error) {
      if (isK8sNotFoundError(error)) {
        logger.debug(
          { error },
          "Agent warm pool reconciliation skipped: extensions or a resource are unavailable",
        );
      } else
        logger.warn(
          { error },
          "Agent warm pool reconciliation failed; new workspaces can still cold-start",
        );
    }
  }
}

export const agentWarmPoolManager = new AgentWarmPoolManager();

/**
 * The launch spec as the pod that served it is sized: a run claimed from a
 * larger tier's pool runs at that tier, so its size variables must say so.
 */
export function servedLaunchSpec<
  T extends Pick<
    KubernetesAgentRunLaunchSpec,
    "tier" | "resources" | "warmTiers" | "env"
  >,
>(spec: T, tier: AgentRuntimeTier | null): T {
  const served = spec.warmTiers.find((candidate) => candidate.tier === tier);
  if (!served || tier === spec.tier) return spec;
  return {
    ...spec,
    tier,
    resources: served.resources,
    env: {
      ...spec.env,
      [AGENT_RUNTIME_TIER_ENV]: tier,
      ...(served.resources.cpuRequest
        ? { [AGENT_RUNTIME_CPU_REQUEST_ENV]: served.resources.cpuRequest }
        : {}),
      ...(served.resources.memoryLimit
        ? { [AGENT_RUNTIME_MEMORY_LIMIT_ENV]: served.resources.memoryLimit }
        : {}),
    },
  };
}

/** Agents idle longer than this hold no spare capacity. */
const RECENT_RUN_WINDOW_MS = 7 * TimeInMs.Day;
const POOL_LABEL = "archestra.io/warm-pool";
const MANAGED_LABELS = { "archestra.io/purpose": "agent-warm-pool" };
const MANAGED_SELECTOR = "archestra.io/purpose=agent-warm-pool";
const API_VERSION = "extensions.agents.x-k8s.io/v1beta1";
const POOL_API = { ...SANDBOX_CLAIM_API, plural: "sandboxwarmpools" };
const TEMPLATE_API = { ...SANDBOX_CLAIM_API, plural: "sandboxtemplates" };
type Claim = {
  metadata: { uid?: string };
  status?: {
    sandbox?: { name?: string };
    conditions?: Array<{ status: string; reason?: string }>;
  };
};
