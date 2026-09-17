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
import { resolveEffectiveNetworkPolicy } from "@/services/environments/network-policy";
import {
  AGENT_SANDBOX_API,
  type AgentSandbox,
  type KubernetesAgentRunLaunchSpec,
} from "./manifests";
import { AGENT_RUNTIME_WORKSPACE_LABEL, agentRuntimeLabels } from "./naming";
import { warmPoolTemplate } from "./warm-pool-template";

export const SANDBOX_CLAIM_API = {
  group: "extensions.agents.x-k8s.io",
  version: "v1beta1",
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
    if (failure) throw new Error(`Workspace claim rejected: ${failure.reason}`);
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
      throw new Error("Sandbox does not belong to this workspace claim");
    return sandbox;
  }
}

class AgentWarmPoolManager {
  private timer: NodeJS.Timeout | undefined;
  private clients: ReturnType<typeof createK8sClients> | undefined;
  private inFlight = false;

  start() {
    if (this.timer || !config.agentRuntime.enabled) return;
    void this.reconcileSafely();
    this.timer = setInterval(() => void this.reconcileSafely(), 30_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async reconcile() {
    if (this.inFlight || !config.agentRuntime.enabled) return;
    this.inFlight = true;
    try {
      if (!this.clients) {
        const { kubeConfig, namespace } = loadKubeConfig();
        this.clients = createK8sClients(kubeConfig, namespace);
      }
      const clients = this.clients;
      const candidates = await AgentModel.listWarmPoolCandidates();
      const desired = new Map<
        string,
        {
          namespace: string;
          organizationId: string;
          template: ReturnType<typeof warmPoolTemplate>;
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
        const runtime = agent.runtime;
        if (
          !runtime ||
          runtime.backend !== "kubernetes" ||
          (runtime.privileged && !config.agentRuntime.allowPrivileged)
        )
          continue;
        const namespace =
          agent.namespace ?? agent.defaultNamespace ?? clients.namespace;
        namespaces.add(namespace);
        if (
          config.agentRuntime.warmPoolSize === 0 ||
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
          resources: runtime.resources ?? config.agentRuntime.resources,
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
                  replicas: config.agentRuntime.warmPoolSize,
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
                    spec: { replicas: config.agentRuntime.warmPoolSize },
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

  async claim(params: {
    api: CustomObjectsApi;
    spec: KubernetesAgentRunLaunchSpec;
  }): Promise<boolean> {
    if (!config.agentRuntime.warmPoolSize || !params.spec.poolScope)
      return false;
    const { api, spec } = params;
    const namespace = spec.namespace;
    const template = warmPoolTemplate(spec);
    try {
      await api.getNamespacedCustomObject({
        ...POOL_API,
        namespace,
        name: template.name,
      });
    } catch (error) {
      if (isK8sNotFoundError(error)) return false;
      throw error;
    }
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
            warmPoolRef: { name: template.name },
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
    return true;
  }
  private async reconcileSafely() {
    try {
      await this.reconcile();
    } catch (error) {
      if (!isK8sNotFoundError(error))
        logger.warn(
          { error },
          "Agent warm pool reconciliation failed; new workspaces can still cold-start",
        );
    }
  }
}

export const agentWarmPoolManager = new AgentWarmPoolManager();

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
