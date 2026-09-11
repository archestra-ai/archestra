import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import config from "@/config";
import { getK8sCapabilities } from "@/k8s/capabilities";
import { clusterDnsResolver } from "@/k8s/cluster-dns";
import {
  createK8sClients,
  isK8sConflictError,
  isK8sNotFoundError,
  loadKubeConfig,
} from "@/k8s/shared";
import { EnvironmentModel, OrganizationModel } from "@/models";
import { resolveAgentRuntimeBackendDriver } from "@/services/agent-runtime/backends";
import { resolveEffectiveNetworkPolicy } from "@/services/environments/network-policy";
import {
  AgentRuntimeCredentialsRequiredError,
  ApiError,
  type ResolvedAgentRuntime,
} from "@/types";
import {
  ClaudeCodeAccountSchema,
  ClaudeCodeModelsSchema,
} from "@/types/claude-code-account";
import { execAgentRuntimeCommand } from "./exec";
import { AGENT_RUNTIME_TASK_LABEL, agentRuntimeNames } from "./naming";
import {
  AGENT_RUNTIME_EGRESS_POLICY_CRDS,
  buildAgentRuntimeEnvironmentEgressPolicies,
} from "./network-policy";

/** Native CLI-owned storage, isolated by organization, user, Agent and environment. */
class ClaudeCodeAccountManager {
  private clients: ReturnType<typeof createK8sClients> | null = null;

  async status(params: AccountOwner) {
    const placement = await this.placement(params);
    const pod = await this.pod(placement);
    if (!pod) return { state: "disconnected" as const };
    if (pod.status?.phase !== "Running") return { state: "starting" as const };
    return ClaudeCodeAccountSchema.parse(
      await this.command({ ...placement, operation: "status" }),
    );
  }

  async start(params: AccountOwner) {
    const placement = await this.placement(params);
    const pod = await this.pod(placement);
    if (pod && pod.spec?.containers[0]?.image !== params.runtime.image) {
      throw new ApiError(
        409,
        "Disconnect Claude Code before changing its runtime image.",
      );
    }
    await this.applyPolicies(placement);
    if (pod?.status?.phase === "Running") {
      return ClaudeCodeAccountSchema.parse(
        await this.command({ ...placement, operation: "start" }),
      );
    }
    if (!pod) {
      const clients = this.requireClients();
      await clients.coreApi
        .createNamespacedPersistentVolumeClaim({
          namespace: placement.namespace,
          body: {
            metadata: { name: placement.name, labels: placement.labels },
            spec: {
              accessModes: ["ReadWriteOnce"],
              resources: { requests: { storage: "1Gi" } },
              ...(config.agentRuntime.workspaceStorageClass
                ? {
                    storageClassName: config.agentRuntime.workspaceStorageClass,
                  }
                : {}),
            },
          },
        })
        .catch(ignoreConflict);
      await clients.coreApi
        .createNamespacedPod({
          namespace: placement.namespace,
          body: {
            metadata: { name: placement.name, labels: placement.labels },
            spec: {
              automountServiceAccountToken: false,
              restartPolicy: "Always",
              securityContext: {
                runAsUser: 1000,
                runAsGroup: 1000,
                fsGroup: 1000,
              },
              affinity: {
                podAffinity: {
                  requiredDuringSchedulingIgnoredDuringExecution: [
                    {
                      labelSelector: {
                        matchLabels: {
                          "archestra.io/claude-account": placement.name,
                        },
                      },
                      topologyKey: "kubernetes.io/hostname",
                    },
                  ],
                },
              },
              nodeSelector: config.agentRuntime.nodeSelector,
              tolerations: Object.entries(config.agentRuntime.nodeSelector).map(
                ([key, value]) => ({
                  key,
                  value,
                  operator: "Equal",
                  effect: "NoSchedule",
                }),
              ),
              containers: [
                {
                  name: "claude-code",
                  image: params.runtime.image,
                  command: [
                    "/bin/sh",
                    "-c",
                    "archestra-claude-account start >/dev/null; exec sleep infinity",
                  ],
                  env: [
                    { name: "CLAUDE_CONFIG_DIR", value: "/opt/claude-account" },
                  ],
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    capabilities: { drop: ["ALL"] },
                  },
                  resources: {
                    requests: { cpu: "100m", memory: "256Mi" },
                    limits: { memory: "1Gi" },
                  },
                  volumeMounts: [
                    { name: "account", mountPath: "/opt/claude-account" },
                  ],
                },
              ],
              volumes: [
                {
                  name: "account",
                  persistentVolumeClaim: { claimName: placement.name },
                },
              ],
            },
          },
        })
        .catch(ignoreConflict);
    }
    return { state: "starting" as const };
  }

  async complete(params: AccountOwner & { flowId: string; code: string }) {
    const current = await this.status(params);
    if (current.state !== "awaiting_code" || current.flowId !== params.flowId) {
      throw new ApiError(
        409,
        "This sign-in has expired. Start Claude Code sign-in again.",
      );
    }
    const placement = await this.placement(params);
    return ClaudeCodeAccountSchema.parse(
      await this.command({
        ...placement,
        operation: "complete",
        input: { flowId: params.flowId, code: params.code },
      }),
    );
  }

  async models(params: AccountOwner) {
    const placement = await this.placement(params);
    if (!(await this.pod(placement))) return { models: [] };
    return ClaudeCodeModelsSchema.parse(
      await this.command({ ...placement, operation: "models" }),
    );
  }

  async disconnect(params: AccountOwner) {
    const placement = await this.placement(params);
    const pod = await this.pod(placement);
    if (!pod) return { state: "disconnected" as const };
    const result = ClaudeCodeAccountSchema.parse(
      await this.command({ ...placement, operation: "logout" }),
    );
    await this.requireClients().coreApi.deleteNamespacedPod({
      name: placement.name,
      namespace: placement.namespace,
      gracePeriodSeconds: 0,
    });
    return result;
  }

  async requireConnection(params: AccountOwner & { runtimeScope: string }) {
    const placement = await this.placement(params);
    if (placement.namespace !== params.runtimeScope)
      throw new ApiError(
        409,
        "Claude Code account belongs to a different environment.",
      );
    if ((await this.status(params)).state !== "connected") {
      throw new AgentRuntimeCredentialsRequiredError(params.runtime.agentId, [
        {
          key: "CLAUDE_CODE_ACCOUNT",
          label: "Claude Code account",
          description:
            "Sign in with your own Claude account in the native runtime.",
        },
      ]);
    }
    const pod = await this.pod(placement);
    if (pod?.spec?.containers[0]?.image !== params.runtime.image) {
      throw new ApiError(
        409,
        "Reconnect Claude Code after changing the runtime image.",
      );
    }
    await this.applyPolicies(placement);
    return { claimName: placement.name, label: "archestra.io/claude-account" };
  }

  private async placement(params: AccountOwner) {
    if (params.runtime.command?.[0] !== "archestra-claude-code") {
      throw new ApiError(
        400,
        "Claude subscriptions are only available in the Claude Code runtime.",
      );
    }
    const [organization, environment] = await Promise.all([
      OrganizationModel.getById(params.runtime.organizationId),
      params.runtime.environmentId
        ? EnvironmentModel.findByIdForOrganization(
            params.runtime.environmentId,
            params.runtime.organizationId,
          )
        : null,
    ]);
    const namespace = resolveAgentRuntimeBackendDriver(
      params.runtime.backend,
    ).resolveRuntimeScope({
      environmentScope: environment?.namespace,
      organizationScope: organization?.defaultEnvironmentNamespace,
    });
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          params.runtime.organizationId,
          params.userId,
          params.runtime.agentId,
        ]),
      )
      .digest("hex")
      .slice(0, 32);
    const name = `claude-account-${hash}`;
    const effectiveNetworkPolicy = await resolveEffectiveNetworkPolicy({
      organizationId: params.runtime.organizationId,
      environmentId: params.runtime.environmentId,
      environmentNetworkPolicy: environment?.networkPolicy,
      defaultNetworkPolicy: organization?.defaultNetworkPolicy,
    });
    return {
      name,
      namespace,
      effectiveNetworkPolicy,
      agentRuntimeId: params.runtime.agentId,
      labels: {
        "archestra.io/claude-account": name,
        [AGENT_RUNTIME_TASK_LABEL]: name,
      },
    };
  }

  private async pod(params: { name: string; namespace: string }) {
    return this.requireClients()
      .coreApi.readNamespacedPod(params)
      .catch((error) => {
        if (isK8sNotFoundError(error)) return null;
        throw error;
      });
  }

  private async command(params: {
    name: string;
    namespace: string;
    operation: string;
    input?: { code: string; flowId: string };
  }) {
    const output = await execAgentRuntimeCommand({
      exec: this.requireClients().exec,
      namespace: params.namespace,
      podName: params.name,
      container: "claude-code",
      command: ["archestra-claude-account", params.operation],
      stdin: params.input
        ? Readable.from([JSON.stringify(params.input)])
        : undefined,
      maxOutputBytes: 512 * 1024,
    });
    return JSON.parse(output);
  }

  private async applyPolicies(
    placement: Awaited<ReturnType<ClaudeCodeAccountManager["placement"]>>,
  ) {
    const clients = this.requireClients();
    const policies = buildAgentRuntimeEnvironmentEgressPolicies({
      spec: {
        ...placement,
        frozenName: placement.name,
        taskId: placement.name,
        ownerReferences: undefined,
      },
      capabilities: (await getK8sCapabilities()).networkPolicy,
      clusterDnsIps: await clusterDnsResolver.getClusterDnsIps(clients.coreApi),
    });
    for (const policy of policies) {
      if (policy.kind === "NetworkPolicy") {
        await clients.networkingApi
          .createNamespacedNetworkPolicy({
            namespace: placement.namespace,
            body: policy.object,
          })
          .catch(async (error) => {
            if (!isK8sConflictError(error)) throw error;
            await clients.networkingApi.replaceNamespacedNetworkPolicy({
              name: policy.object.metadata?.name ?? "",
              namespace: placement.namespace,
              body: policy.object,
            });
          });
      } else {
        const coordinates = AGENT_RUNTIME_EGRESS_POLICY_CRDS[policy.kind];
        await clients.customObjectsApi
          .createNamespacedCustomObject({
            ...coordinates,
            namespace: placement.namespace,
            body: policy.object,
          })
          .catch(async (error) => {
            if (!isK8sConflictError(error)) throw error;
            await clients.customObjectsApi.patchNamespacedCustomObject(
              {
                ...coordinates,
                namespace: placement.namespace,
                name: agentRuntimeNames(placement.name)
                  .environmentNetworkPolicy,
                body: [
                  { op: "replace", path: "/spec", value: policy.object.spec },
                ],
              },
              setHeaderOptions("Content-Type", PatchStrategy.JsonPatch),
            );
          });
      }
    }
    // Egress policies are additive: prune obsolete policy kinds before use.
    const name = agentRuntimeNames(placement.name).environmentNetworkPolicy;
    const desiredKinds = new Set(policies.map(({ kind }) => kind));
    if (!desiredKinds.has("NetworkPolicy")) {
      await clients.networkingApi
        .deleteNamespacedNetworkPolicy({ name, namespace: placement.namespace })
        .catch(ignoreNotFound);
    }
    for (const [kind, coordinates] of Object.entries(
      AGENT_RUNTIME_EGRESS_POLICY_CRDS,
    )) {
      if (policies.some((policy) => policy.kind === kind)) continue;
      await clients.customObjectsApi
        .deleteNamespacedCustomObject({
          ...coordinates,
          name,
          namespace: placement.namespace,
        })
        .catch(ignoreNotFound);
    }
  }

  private requireClients() {
    if (!this.clients) {
      const { kubeConfig, namespace } = loadKubeConfig();
      this.clients = createK8sClients(kubeConfig, namespace);
    }
    return this.clients;
  }
}

export const claudeCodeAccountManager = new ClaudeCodeAccountManager();

type AccountOwner = { runtime: ResolvedAgentRuntime; userId: string };

function ignoreConflict(error: unknown) {
  if (!isK8sConflictError(error)) throw error;
}

function ignoreNotFound(error: unknown) {
  if (!isK8sNotFoundError(error)) throw error;
}
