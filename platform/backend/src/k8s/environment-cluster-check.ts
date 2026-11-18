import { isIP } from "node:net";
import * as k8s from "@kubernetes/client-node";
import { getK8sCapabilitiesFromApi } from "@/k8s/capabilities";
import {
  ENVIRONMENT_CLUSTER_PERMISSIONS,
  type EnvironmentClusterFeature,
  type EnvironmentClusterPermission,
} from "@/k8s/environment-cluster-permissions";
import { describeK8sApiError, type K8sClients } from "@/k8s/shared";
import type { EnvironmentClusterCheck, K8sCapabilities } from "@/types";

// === Public API ===

/**
 * What an environment's cluster lets the platform do there, one result per
 * feature, so an administrator sees before deploying which of them will work.
 *
 * Every check only asks; none leaves an object behind. A failed API check
 * skips the rest: there is nothing to learn from a cluster that does not
 * answer.
 */
export async function checkEnvironmentCluster(params: {
  clients: K8sClients;
  namespace: string;
  /** The clients reach the cluster through its cluster agent. */
  throughAgent?: boolean;
  /**
   * The URL Agent Runtime pods in this cluster would call the platform at, or
   * the reason there is none.
   */
  platformUrl: { url: string } | { problem: string };
}): Promise<EnvironmentClusterCheck[]> {
  const { clients, namespace } = params;

  const api = await checkApi(clients);
  if (api.status === "failed") return [api];

  const capabilities = await getK8sCapabilitiesFromApi(
    clients.customObjectsApi,
    { coreApi: clients.coreApi, namespace },
  );
  let denied: DeniedPermissions;
  try {
    denied = await findDeniedPermissions({
      clients,
      namespace,
      capabilities,
      throughAgent: params.throughAgent ?? false,
    });
  } catch (error) {
    return [
      api,
      {
        id: "deployAccess",
        status: "failed",
        message: `Could not check permissions in namespace "${namespace}": ${describeError(error)}`,
      },
    ];
  }

  return [
    api,
    checkDeployAccess(namespace, denied),
    checkNetworkPolicy(capabilities),
    await checkCodeSandbox(clients, namespace, denied),
    checkAgentRuntime(capabilities, denied, params.platformUrl),
  ];
}

/**
 * Whether a kubeconfig's identity may deploy MCP servers into a namespace:
 * every permission that feature uses, which is also what removing them again
 * takes. Resolves to the missing ones, as `verb resource`.
 */
export async function findMissingMcpServerPermissions(params: {
  clients: K8sClients;
  namespace: string;
  /** The clients reach the cluster through its cluster agent. */
  throughAgent?: boolean;
}): Promise<string[]> {
  const capabilities = await getK8sCapabilitiesFromApi(
    params.clients.customObjectsApi,
    { coreApi: params.clients.coreApi, namespace: params.namespace },
  );
  return (
    await findDeniedPermissions({
      ...params,
      capabilities,
      throughAgent: params.throughAgent ?? false,
    })
  ).mcpServers;
}

// === Internal helpers ===

type DeniedPermissions = Record<EnvironmentClusterFeature, string[]>;

async function checkApi(clients: K8sClients): Promise<EnvironmentClusterCheck> {
  try {
    const version = await clients.kubeConfig
      .makeApiClient(k8s.VersionApi)
      .getCode();
    // The version endpoint is often open to anyone. A review of the caller's
    // own access is refused unless the credential is accepted.
    await clients.authApi.createSelfSubjectAccessReview({
      body: {
        spec: { resourceAttributes: { verb: "get", resource: "pods" } },
      },
    });
    return {
      id: "api",
      status: "ok",
      message: `Connected to Kubernetes ${version.gitVersion}.`,
    };
  } catch (error) {
    return {
      id: "api",
      status: "failed",
      message: `Could not connect to the cluster: ${describeError(error)}`,
    };
  }
}

/**
 * Ask the cluster, through access reviews of the kubeconfig's own identity
 * (always permitted), for every permission the platform uses. Resolves, per
 * feature, to the ones it is refused, as `verb resource`.
 */
async function findDeniedPermissions(params: {
  clients: K8sClients;
  namespace: string;
  capabilities: K8sCapabilities;
  throughAgent: boolean;
}): Promise<DeniedPermissions> {
  const { clients, namespace, capabilities } = params;
  const installed: Record<
    NonNullable<EnvironmentClusterPermission["onlyWhen"]>,
    boolean
  > = {
    cilium: capabilities.networkPolicy.ciliumNetworkPolicy,
    gkeFqdn: capabilities.networkPolicy.gkeFqdnNetworkPolicy,
    awsAnp: capabilities.networkPolicy.awsApplicationNetworkPolicy,
    agentSandbox: capabilities.agentSandbox.installed,
  };
  const denied: DeniedPermissions = {
    mcpServers: [],
    codeSandbox: [],
    agentRuntime: [],
  };
  const reviews = ENVIRONMENT_CLUSTER_PERMISSIONS.filter(
    (permission) =>
      (!permission.onlyWhen || installed[permission.onlyWhen]) &&
      !(params.throughAgent && permission.notThroughAgent),
  ).flatMap((permission) =>
    permission.verbs.map((verb) => ({ permission, verb })),
  );
  // A bounded burst: the list is about a hundred small requests.
  for (let start = 0; start < reviews.length; start += REVIEW_CONCURRENCY) {
    await Promise.all(
      reviews
        .slice(start, start + REVIEW_CONCURRENCY)
        .map(async ({ permission, verb }) => {
          const [resource, subresource] = permission.resource.split("/");
          const review = await clients.authApi.createSelfSubjectAccessReview({
            body: {
              spec: {
                resourceAttributes: {
                  namespace,
                  verb,
                  group: permission.apiGroup,
                  resource,
                  subresource,
                },
              },
            },
          });
          if (review.status?.allowed) return;
          for (const feature of permission.features) {
            denied[feature].push(`${verb} ${permission.resource}`);
          }
        }),
    );
  }
  for (const feature of Object.keys(denied) as EnvironmentClusterFeature[]) {
    denied[feature].sort();
  }
  return denied;
}

function checkDeployAccess(
  namespace: string,
  denied: DeniedPermissions,
): EnvironmentClusterCheck {
  return denied.mcpServers.length === 0
    ? {
        id: "deployAccess",
        status: "ok",
        message: `MCP servers can be deployed into namespace "${namespace}".`,
      }
    : {
        id: "deployAccess",
        status: "failed",
        message: `The kubeconfig's identity lacks permissions for MCP servers in namespace "${namespace}": ${denied.mcpServers.join(", ")}.`,
      };
}

function checkNetworkPolicy(
  capabilities: K8sCapabilities,
): EnvironmentClusterCheck {
  const { networkPolicy } = capabilities;
  const status =
    networkPolicy.enforcementStatus === "verified-enforced"
      ? "ok"
      : networkPolicy.enforcementStatus === "verified-not-enforced"
        ? "failed"
        : "unverified";
  return {
    id: "networkPolicy",
    status,
    message:
      status === "unverified"
        ? "Egress policies are written to this cluster, but nothing has verified that it enforces them."
        : (networkPolicy.message ??
          (status === "ok"
            ? "The cluster enforces egress policies."
            : "The cluster does not enforce egress policies.")),
  };
}

/**
 * Code sandbox engines run privileged. A server-side dry run of such a pod is
 * admitted or refused by the namespace's own policy (Pod Security admission,
 * policy engines) without creating anything.
 */
async function checkCodeSandbox(
  clients: K8sClients,
  namespace: string,
  denied: DeniedPermissions,
): Promise<EnvironmentClusterCheck> {
  if (denied.codeSandbox.length > 0) {
    return {
      id: "codeSandbox",
      status: "failed",
      message: `The kubeconfig's identity lacks permissions for the code sandbox in namespace "${namespace}": ${denied.codeSandbox.join(", ")}.`,
    };
  }
  try {
    await clients.coreApi.createNamespacedPod({
      namespace,
      dryRun: "All",
      body: {
        metadata: { generateName: "archestra-privileged-check-" },
        spec: {
          restartPolicy: "Never",
          containers: [
            {
              name: "check",
              image: "registry.k8s.io/pause:3.10",
              securityContext: { privileged: true },
            },
          ],
        },
      },
    });
    return {
      id: "codeSandbox",
      status: "ok",
      message: `Privileged pods are allowed in namespace "${namespace}", so the code sandbox can run there.`,
    };
  } catch (error) {
    return {
      id: "codeSandbox",
      status: "failed",
      message: `The code sandbox needs privileged pods, which namespace "${namespace}" does not admit: ${describeError(error)}`,
    };
  }
}

function checkAgentRuntime(
  capabilities: K8sCapabilities,
  denied: DeniedPermissions,
  platformUrl: { url: string } | { problem: string },
): EnvironmentClusterCheck {
  const failed = (message: string): EnvironmentClusterCheck => ({
    id: "agentRuntime",
    status: "failed",
    message,
  });
  if (!capabilities.agentSandbox.installed) {
    return failed(capabilities.agentSandbox.message);
  }
  if (denied.agentRuntime.length > 0) {
    return failed(
      `The kubeconfig's identity lacks permissions for Agent Runtime: ${denied.agentRuntime.join(", ")}.`,
    );
  }
  if ("problem" in platformUrl) return failed(platformUrl.problem);
  return {
    id: "agentRuntime",
    status: "unverified",
    message: `The Agent Sandbox controller is installed. Agent Runtime pods will call the platform at ${platformUrl.url}; whether that address is reachable from the cluster is not tested.${platformUrlEgressHint(platformUrl.url)}`,
  };
}

/**
 * A run's own egress policy opens the way to the addresses the platform
 * resolves the URL's host name to. Where that cluster resolves the name to
 * another address, only the environment's network egress policy can allow it.
 */
function platformUrlEgressHint(url: string): string {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  return isIP(hostname)
    ? ""
    : " If that host name resolves to a different address inside that cluster, allow the address in this environment's network egress policy, or put the IP address in the URL.";
}

const REVIEW_CONCURRENCY = 10;

/** A Kubernetes API error by its status and reason; anything else (a refused or timed-out connection) by its cause. */
function describeError(error: unknown): string {
  const apiError = describeK8sApiError(error);
  if (apiError) return apiError;
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error
    ? `${error.message}: ${error.cause.message}`
    : error.message;
}
