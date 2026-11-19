import type * as k8s from "@kubernetes/client-node";
import config from "@/config";
import { AGENT_SANDBOX_API } from "@/k8s/agent-runtime/manifests";
import { AGENT_SANDBOX_EXTENSIONS_API } from "@/k8s/agent-runtime/sandbox-api";
import { resolveRuntimeOwnerReferences } from "@/k8s/mcp-server-runtime/runtime-owner";
import {
  createK8sClients,
  getK8sNamespace,
  isK8sNotFoundError,
  loadKubeConfig,
} from "@/k8s/shared";
import logger from "@/logging";

/**
 * Namespaces the platform ran workloads in before a namespace change and now
 * only cleans up (`ARCHESTRA_ORCHESTRATOR_K8S_RETIRED_NAMESPACES`). A namespace
 * that is still in use is never retired.
 */
export function retiredWorkloadNamespaces(): string[] {
  const active = new Set(
    [
      getK8sNamespace(),
      config.agentRuntime.namespace,
      config.daggerRuntime.namespace,
      ...config.orchestrator.kubernetes.environmentNamespaces,
    ].filter((namespace): namespace is string => Boolean(namespace)),
  );
  return [...new Set(config.orchestrator.kubernetes.retiredNamespaces)].filter(
    (namespace) => !active.has(namespace),
  );
}

/**
 * Finishes the cleanup of each retired namespace. The MCP, warm-pool and code
 * sandbox reconcilers remove their own objects there straight away; Agent
 * Runtime sessions keep running until they end. Once no session of this
 * install is left, the drainer deletes the release's runtime owner Role in the
 * namespace, and Kubernetes garbage-collects every object that still names it
 * as owner (Secrets, Services, NetworkPolicies, finished runs and their
 * disks). Objects of other installs or other workloads are never touched.
 */
class RetiredNamespaceDrainer {
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private drained = new Set<string>();
  private waiting = new Map<string, number>();

  start() {
    if (this.timer || retiredWorkloadNamespaces().length === 0) return;
    void this.drainSafely();
    this.timer = setInterval(() => void this.drainSafely(), DRAIN_INTERVAL_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async drain(clientsFor: (namespace: string) => K8sClients = defaultClients) {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const roleName = config.orchestrator.kubernetes.runtimeOwnerRoleName;
      if (!roleName) return;
      for (const namespace of retiredWorkloadNamespaces()) {
        if (this.drained.has(namespace)) continue;
        try {
          await this.drainNamespace({
            namespace,
            roleName,
            clients: clientsFor(namespace),
          });
        } catch (error) {
          logger.warn(
            { err: error, namespace },
            "Failed to clean up a retired workload namespace; will retry",
          );
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  /** @internal exported for tests */
  reset() {
    this.drained.clear();
    this.waiting.clear();
    this.inFlight = false;
  }

  private async drainNamespace(params: {
    namespace: string;
    roleName: string;
    clients: K8sClients;
  }) {
    const { namespace, roleName, clients } = params;
    const ownerUid = (
      await resolveRuntimeOwnerReferences(clients.rbacApi, namespace).catch(
        (error) => {
          if (isK8sNotFoundError(error)) return undefined;
          throw error;
        },
      )
    )?.[0]?.uid;
    if (!ownerUid) {
      // Already drained, or the chart does not keep the Role here.
      this.drained.add(namespace);
      return;
    }
    const ownedBy = (object: { metadata?: k8s.V1ObjectMeta }) =>
      object.metadata?.ownerReferences?.some(
        (owner) => owner.uid === ownerUid,
      ) ?? false;
    const sessions =
      (await countOwned(clients, AGENT_SANDBOX_API, namespace, ownedBy)) +
      (await countOwned(clients, SANDBOX_CLAIM_API, namespace, ownedBy));
    // The code sandbox recognizes its engines by the owner Role's uid, so the
    // Role must outlive them.
    const engines = (
      await clients.appsApi.listNamespacedStatefulSet({
        namespace,
        labelSelector: `app=dagger-engine,${DAGGER_OWNER_LABEL}=${ownerUid}`,
      })
    ).items.length;
    if (sessions > 0 || engines > 0) {
      if (this.waiting.get(namespace) !== sessions + engines) {
        this.waiting.set(namespace, sessions + engines);
        logger.info(
          { namespace, sessions, engines },
          "Retired workload namespace still has Agent Runtime sessions or code sandbox engines; cleaning up after they end",
        );
      }
      return;
    }
    await clients.rbacApi
      .deleteNamespacedRole({
        name: roleName,
        namespace,
        body: { preconditions: { uid: ownerUid } },
      })
      .catch((error) => {
        if (!isK8sNotFoundError(error)) throw error;
      });
    this.drained.add(namespace);
    this.waiting.delete(namespace);
    logger.info(
      { namespace },
      "Removed everything Archestra left in the retired workload namespace. Remove it from rbac.retiredNamespaces (ARCHESTRA_ORCHESTRATOR_K8S_RETIRED_NAMESPACES).",
    );
  }

  private async drainSafely() {
    try {
      await this.drain();
    } catch (error) {
      logger.warn({ err: error }, "Retired namespace cleanup failed");
    }
  }
}

export const retiredNamespaceDrainer = new RetiredNamespaceDrainer();

// === Internal helpers ===

type K8sClients = ReturnType<typeof createK8sClients>;

const DRAIN_INTERVAL_MS = 5 * 60_000;
const SANDBOX_CLAIM_API = {
  ...AGENT_SANDBOX_EXTENSIONS_API,
  plural: "sandboxclaims",
} as const;
/** Mirrors the code sandbox's owner label (dagger-environment-runtime). */
const DAGGER_OWNER_LABEL = "archestra.io/dagger-runtime-owner";

function defaultClients(namespace: string): K8sClients {
  return createK8sClients(loadKubeConfig().kubeConfig, namespace);
}

async function countOwned(
  clients: K8sClients,
  api: { group: string; version: string; plural: string },
  namespace: string,
  ownedBy: (object: { metadata?: k8s.V1ObjectMeta }) => boolean,
): Promise<number> {
  try {
    const list = (await clients.customObjectsApi.listNamespacedCustomObject({
      ...api,
      namespace,
    })) as { items: Array<{ metadata?: k8s.V1ObjectMeta }> };
    return list.items.filter(ownedBy).length;
  } catch (error) {
    // Agent Sandbox not installed: there are no sessions to wait for.
    if (isK8sNotFoundError(error)) return 0;
    throw error;
  }
}
