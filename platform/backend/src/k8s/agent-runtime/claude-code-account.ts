import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import config from "@/config";
import { getK8sCapabilities } from "@/k8s/capabilities";
import { clusterDnsResolver } from "@/k8s/cluster-dns";
import {
  createK8sClients,
  isK8sNotFoundError,
  loadKubeConfig,
} from "@/k8s/shared";
import type { AgentRunLaunchSpec } from "@/services/agent-runtime/backends";
import { execAgentRuntimeCommand } from "./exec";
import { AGENT_RUNTIME_TASK_LABEL } from "./naming";
import {
  AGENT_RUNTIME_EGRESS_POLICY_CRDS,
  buildAgentRuntimeEnvironmentEgressPolicies,
} from "./network-policy";

/** Disposable CLI processes. Jobs collect their Pods and egress policies even
 * if the platform stops during sign-in. No credential files survive the Job. */
class ClaudeCodeAccountRuntime {
  private clients: ReturnType<typeof createK8sClients> | null = null;

  async create(
    params: Flow & {
      image: string;
      agentId: string;
      vaultReference: boolean;
      effectiveNetworkPolicy: AgentRunLaunchSpec["effectiveNetworkPolicy"];
    },
  ) {
    const clients = this.requireClients();
    const name = jobName(params.flowId);
    const labels = { [AGENT_RUNTIME_TASK_LABEL]: name };
    const job = await clients.batchApi.createNamespacedJob({
      namespace: params.namespace,
      body: {
        metadata: { name },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: 600,
          ttlSecondsAfterFinished: 60,
          template: {
            metadata: { labels },
            spec: {
              restartPolicy: "Never",
              automountServiceAccountToken: false,
              schedulingGates: [{ name: "archestra.io/egress-ready" }],
              securityContext: {
                runAsUser: 1000,
                runAsGroup: 1000,
                fsGroup: 1000,
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
                  image: params.image,
                  command: [
                    "/bin/sh",
                    "-c",
                    params.vaultReference
                      ? "exec sleep 600"
                      : "archestra-claude-account start >/dev/null; exec sleep 600",
                  ],
                  env: [
                    { name: "CLAUDE_CONFIG_DIR", value: "/tmp/claude-config" },
                    {
                      name: "ARCHESTRA_AGENT_RUNTIME_CLAUDE_FLOW_ID",
                      value: params.flowId,
                    },
                  ],
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    capabilities: { drop: ["ALL"] },
                  },
                  resources: {
                    requests: { cpu: "100m", memory: "256Mi" },
                    limits: { memory: "1Gi" },
                  },
                },
              ],
            },
          },
        },
      },
    });
    try {
      if (!job.metadata?.uid) throw new Error("Sign-in Job has no identity");
      const policies = buildAgentRuntimeEnvironmentEgressPolicies({
        spec: {
          frozenName: name,
          taskId: name,
          agentRuntimeId: params.agentId,
          namespace: params.namespace,
          effectiveNetworkPolicy: params.effectiveNetworkPolicy,
          ownerReferences: [
            {
              apiVersion: "batch/v1",
              kind: "Job",
              name,
              uid: job.metadata.uid,
            },
          ],
        },
        capabilities: (await getK8sCapabilities()).networkPolicy,
        clusterDnsIps: await clusterDnsResolver.getClusterDnsIps(
          clients.coreApi,
        ),
      });
      for (const policy of policies) {
        if (policy.kind === "NetworkPolicy") {
          await clients.networkingApi.createNamespacedNetworkPolicy({
            namespace: params.namespace,
            body: policy.object,
          });
        } else {
          await clients.customObjectsApi.createNamespacedCustomObject({
            ...AGENT_RUNTIME_EGRESS_POLICY_CRDS[policy.kind],
            namespace: params.namespace,
            body: policy.object,
          });
        }
      }
      // Keep the Job deadline running while policy installation gates scheduling.
      // A platform crash cannot leave an unbounded suspended sign-in Job.
      let pod = await this.pod(params);
      for (let attempt = 0; !pod && attempt < 15; attempt++) {
        await delay(1000);
        pod = await this.pod(params);
      }
      if (!pod?.metadata?.name) throw new Error("Sign-in Pod was not created");
      const gate =
        pod.spec?.schedulingGates?.findIndex(
          ({ name }) => name === "archestra.io/egress-ready",
        ) ?? -1;
      if (gate < 0)
        throw new Error("Sign-in Pod is missing its scheduling gate");
      await clients.coreApi.patchNamespacedPod(
        {
          namespace: params.namespace,
          name: pod.metadata.name,
          body: [{ op: "remove", path: `/spec/schedulingGates/${gate}` }],
        },
        setHeaderOptions("Content-Type", PatchStrategy.JsonPatch),
      );
    } catch (error) {
      await this.delete(params);
      throw error;
    }
  }

  async status(params: Flow): Promise<unknown> {
    const pod = await this.pod(params);
    if (!pod || pod.status?.phase === "Pending")
      return { state: "starting", flowId: params.flowId };
    if (pod.status?.phase !== "Running") return { state: "failed" };
    return this.command({
      ...params,
      podName: pod.metadata?.name ?? "",
      operation: "status",
    });
  }

  async complete(
    params: Flow & { code?: string; token?: string },
  ): Promise<unknown> {
    const pod = await this.pod(params);
    if (!pod || pod.status?.phase === "Pending")
      return { state: "connecting", flowId: params.flowId };
    if (pod.status?.phase !== "Running") return { state: "failed" };
    return this.command({
      ...params,
      podName: pod.metadata?.name ?? "",
      operation: params.token ? "models" : "complete",
      input: { code: params.code, flowId: params.flowId, token: params.token },
    });
  }

  async delete(params: Flow) {
    await this.requireClients()
      .batchApi.deleteNamespacedJob({
        namespace: params.namespace,
        name: jobName(params.flowId),
        propagationPolicy: "Background",
      })
      .catch((error) => {
        if (!isK8sNotFoundError(error)) throw error;
      });
  }

  private async pod(params: Flow) {
    const { items } = await this.requireClients().coreApi.listNamespacedPod({
      namespace: params.namespace,
      labelSelector: `job-name=${jobName(params.flowId)}`,
    });
    return items[0] ?? null;
  }

  private async command(
    params: Flow & {
      podName: string;
      operation: string;
      input?: { code?: string; flowId: string; token?: string };
    },
  ): Promise<unknown> {
    const output = await execAgentRuntimeCommand({
      exec: this.requireClients().exec,
      namespace: params.namespace,
      podName: params.podName,
      container: "claude-code",
      command: ["archestra-claude-account", params.operation],
      stdin: params.input
        ? Readable.from([JSON.stringify(params.input)])
        : undefined,
      maxOutputBytes: 512 * 1024,
    });
    try {
      return JSON.parse(output);
    } catch {
      throw new Error("Claude Code returned invalid account data");
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

export const claudeCodeAccountRuntime = new ClaudeCodeAccountRuntime();

type Flow = { namespace: string; flowId: string };
function jobName(flowId: string) {
  return `claude-sign-in-${flowId}`;
}
