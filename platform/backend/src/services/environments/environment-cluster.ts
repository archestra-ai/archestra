import config from "@/config";
import { resolvePlatformUrlForEnvironmentCluster } from "@/k8s/agent-runtime/platform-service";
import { daggerEnvironmentRuntimeManager } from "@/k8s/dagger-environment-runtime/manager";
import {
  checkEnvironmentCluster,
  findMissingMcpServerPermissions,
} from "@/k8s/environment-cluster-check";
import {
  clientsForKubeconfig,
  environmentClusters,
  readEnvironmentKubeconfig,
} from "@/k8s/environment-clusters";
import {
  type EnvironmentKubeconfig,
  EnvironmentKubeconfigError,
  parseEnvironmentKubeconfig,
} from "@/k8s/environment-kubeconfig";
import mcpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import { getK8sNamespace } from "@/k8s/shared";
import { EnvironmentModel } from "@/models";
import {
  ApiError,
  type EnvironmentClusterTestResult,
  type EnvironmentRow,
} from "@/types";

// === Public API ===

/**
 * Check a kubeconfig an administrator pasted for an environment before it is
 * stored: it must be one the platform accepts, and its identity must be able
 * to deploy into the environment's namespace of that cluster. Anything less
 * would store a binding nothing can ever be deployed through.
 */
export async function validateEnvironmentKubeconfig(params: {
  kubeconfig: string;
  namespace: string | null | undefined;
}): Promise<EnvironmentKubeconfig> {
  if (!mcpServerRuntimeManager.isEnabled) {
    throw new ApiError(
      400,
      "The Kubernetes runtime is not enabled, so an environment cannot deploy into another cluster.",
    );
  }
  const kubeconfig = parseKubeconfig(params.kubeconfig);
  if (!params.namespace) {
    throw new ApiError(
      400,
      "An environment with its own cluster needs a Kubernetes namespace in that cluster.",
    );
  }
  // Everything MCP servers use, which is also what it takes to remove this
  // installation's workloads from the cluster again before the environment
  // is deleted.
  let missing: string[];
  try {
    missing = await findMissingMcpServerPermissions({
      clients: clientsForKubeconfig(kubeconfig.normalized),
      namespace: params.namespace,
    });
  } catch {
    throw new ApiError(
      400,
      `Could not reach the cluster at ${kubeconfig.server} with this kubeconfig.`,
    );
  }
  if (missing.length > 0) {
    throw new ApiError(
      400,
      `The kubeconfig's identity lacks permissions in namespace "${params.namespace}" of the cluster at ${kubeconfig.server}: ${missing.join(", ")}. Grant them first.`,
    );
  }
  return kubeconfig;
}

/**
 * Check that an environment's own cluster lets its kubeconfig's identity
 * deploy into a namespace the environment is being moved to.
 */
export async function assertNamespaceDeployableInEnvironmentCluster(params: {
  environment: EnvironmentRow;
  namespace: string;
}): Promise<void> {
  let missing: string[];
  try {
    missing = await findMissingMcpServerPermissions({
      clients: await environmentClusters.forEnvironment(params.environment),
      namespace: params.namespace,
    });
  } catch {
    throw new ApiError(400, "Could not reach the environment's cluster.");
  }
  if (missing.length > 0) {
    throw new ApiError(
      400,
      `The environment's kubeconfig lacks permissions in namespace "${params.namespace}" of its cluster: ${missing.join(", ")}. Grant them first.`,
    );
  }
}

/**
 * Check a kubeconfig sent for an environment that already has one. Only its
 * credential may differ: the cluster of an environment is fixed when the
 * environment is created, because workloads and stored placement refer to the
 * environment, not to a cluster.
 */
export async function validateEnvironmentKubeconfigRotation(params: {
  environment: EnvironmentRow;
  kubeconfig: string;
  namespace: string | null | undefined;
}): Promise<EnvironmentKubeconfig> {
  const { environment } = params;
  if (!environment.kubeconfigSecretId) {
    throw new ApiError(
      400,
      "This environment deploys into the platform's own cluster. The cluster of an environment is chosen when it is created; create a new environment for another cluster.",
    );
  }
  const stored = await readEnvironmentKubeconfig(environment);
  const kubeconfig = await validateEnvironmentKubeconfig({
    kubeconfig: params.kubeconfig,
    namespace: params.namespace,
  });
  if (kubeconfig.clusterIdentity !== stored.clusterIdentity) {
    throw new ApiError(
      400,
      `This kubeconfig is for a different cluster (${kubeconfig.server}) than the environment's (${stored.server}). An environment's cluster cannot change; create a new environment for another cluster.`,
    );
  }
  return kubeconfig;
}

/**
 * Report what a cluster lets the platform do: the cluster of a pasted
 * kubeconfig, or the one an environment is already bound to.
 */
export async function testEnvironmentCluster(params: {
  organizationId: string;
  kubeconfig?: string;
  environmentId?: string;
  namespace?: string | null;
  agentRuntimePlatformBaseUrl?: string | null;
}): Promise<EnvironmentClusterTestResult> {
  const environment = params.environmentId
    ? await EnvironmentModel.findByIdForOrganization(
        params.environmentId,
        params.organizationId,
      )
    : null;
  if (params.environmentId && !environment) {
    throw new ApiError(404, "Environment not found");
  }
  if (environment?.deletingAt) {
    throw new ApiError(409, "This environment is being deleted.");
  }

  let server: string;
  let clients: ReturnType<typeof clientsForKubeconfig>;
  if (params.kubeconfig) {
    const kubeconfig = parseKubeconfig(params.kubeconfig);
    server = kubeconfig.server;
    clients = clientsForKubeconfig(kubeconfig.normalized);
  } else if (environment?.kubeconfigSecretId) {
    server = environment.kubeconfigServer ?? "";
    clients = await environmentClusters.forEnvironment(environment);
  } else {
    throw new ApiError(
      400,
      "Provide a kubeconfig to test, or an environment that has one.",
    );
  }

  const namespace = params.namespace ?? environment?.namespace;
  if (!namespace) {
    throw new ApiError(
      400,
      "Provide the Kubernetes namespace of that cluster to test.",
    );
  }

  return {
    server,
    checks: await checkEnvironmentCluster({
      clients,
      namespace,
      platformUrl: resolvePlatformUrlForEnvironmentCluster({
        environmentUrl:
          params.agentRuntimePlatformBaseUrl !== undefined
            ? params.agentRuntimePlatformBaseUrl
            : (environment?.agentRuntimePlatformBaseUrl ?? null),
        installUrl: config.agentRuntime.platformBaseUrl,
        platformNamespace: process.env.POD_NAMESPACE || getK8sNamespace(),
      }),
    }),
  };
}

/**
 * Remove everything this installation has in an environment's own cluster:
 * its MCP deployments (the environment's built-in browser server, and what
 * servers that moved to another environment left behind), the shared egress
 * baseline, and the code sandbox engines (the environment's and its agents').
 * Call once the environment is marked as being deleted and while its
 * kubeconfig still exists; afterwards nothing can reach that cluster. Throws
 * when something could not be removed.
 */
export async function removeEnvironmentClusterWorkloads(
  environment: EnvironmentRow,
): Promise<void> {
  await mcpServerRuntimeManager.removeEnvironmentClusterDeployments(
    environment,
  );
  await daggerEnvironmentRuntimeManager.teardownEnginesInEnvironmentCluster(
    environment,
  );
}

// === Internal helpers ===

function parseKubeconfig(content: string): EnvironmentKubeconfig {
  try {
    return parseEnvironmentKubeconfig(content);
  } catch (error) {
    if (error instanceof EnvironmentKubeconfigError) {
      throw new ApiError(400, error.message);
    }
    throw error;
  }
}
