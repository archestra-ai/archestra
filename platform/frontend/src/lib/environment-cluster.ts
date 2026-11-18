import {
  type archestraApiTypes,
  ENVIRONMENT_CLUSTER_BUSY_CODE,
  ENVIRONMENT_CLUSTER_CLEANUP_FAILED_CODE,
} from "@archestra/shared";
import { getApiErrorInternalCode, getApiErrorMessage } from "@/lib/utils/api";

type ClusterTestResult =
  archestraApiTypes.TestEnvironmentKubeconfigResponses["200"];
export type EnvironmentClusterCheck = ClusterTestResult["checks"][number];

/**
 * Why a delete of an environment with its own cluster was refused, when the
 * person can act on it from the delete dialog itself:
 *
 * - `cleanup-failed`: its workloads could not be removed from the cluster.
 *   They can retry, or delete it and leave the workloads there.
 * - `busy`: something is still deploying into the cluster. They can retry.
 */
export interface EnvironmentDeleteBlock {
  kind: "cleanup-failed" | "busy";
  message: string;
}

/** The delete block an API error stands for; null for any other error. */
export function environmentDeleteBlock(
  error: unknown,
): EnvironmentDeleteBlock | null {
  const code = getApiErrorInternalCode(error);
  if (code === ENVIRONMENT_CLUSTER_CLEANUP_FAILED_CODE) {
    return { kind: "cleanup-failed", message: getApiErrorMessage(error) };
  }
  if (code === ENVIRONMENT_CLUSTER_BUSY_CODE) {
    return { kind: "busy", message: getApiErrorMessage(error) };
  }
  return null;
}

/**
 * The cluster fields of the environment editor.
 *
 * `ownCluster` and `kubeconfig` are set when an environment is created; later
 * `kubeconfig` holds only a replacement credential for the same cluster.
 */
export interface EnvironmentClusterDraft {
  ownCluster: boolean;
  kubeconfig: string;
  agentRuntimePlatformBaseUrl: string;
}

export const EMPTY_ENVIRONMENT_CLUSTER_DRAFT: EnvironmentClusterDraft = {
  ownCluster: false,
  kubeconfig: "",
  agentRuntimePlatformBaseUrl: "",
};

/**
 * The address to suggest for the Agent Runtime platform URL: the first
 * `https://` entry of the API's configured addresses, which the deployment
 * publishes for clients outside its cluster. Empty when there is none.
 */
export function suggestedAgentRuntimePlatformUrl(
  apiBaseUrls: string[],
): string {
  const url = apiBaseUrls.find((entry) => entry.startsWith("https://"));
  // The configured entry may carry the proxy's /v1 path; the platform URL is
  // the base the paths are added to.
  return url ? url.replace(/\/+$/, "").replace(/\/v1$/, "") : "";
}

/**
 * Choose the cluster of a new environment. Choosing another cluster fills an
 * empty platform URL with the suggested one; the admin can change it.
 */
export function chooseEnvironmentCluster(
  draft: EnvironmentClusterDraft,
  ownCluster: boolean,
  suggestedPlatformUrl: string,
): EnvironmentClusterDraft {
  return {
    ...draft,
    ownCluster,
    agentRuntimePlatformBaseUrl:
      ownCluster && draft.agentRuntimePlatformBaseUrl.trim() === ""
        ? suggestedPlatformUrl
        : draft.agentRuntimePlatformBaseUrl,
  };
}

/** The editor's starting cluster fields for an existing environment. */
export function environmentClusterDraftFor(
  environment: {
    kubeconfigServer: string | null;
    agentRuntimePlatformBaseUrl: string | null;
  } | null,
): EnvironmentClusterDraft {
  if (!environment) return EMPTY_ENVIRONMENT_CLUSTER_DRAFT;
  return {
    ownCluster: environment.kubeconfigServer !== null,
    kubeconfig: "",
    agentRuntimePlatformBaseUrl: environment.agentRuntimePlatformBaseUrl ?? "",
  };
}

/**
 * What stops a new environment with its own cluster from being saved; null
 * when nothing does. An environment of the platform's cluster needs nothing.
 */
export function environmentClusterCreateError(params: {
  draft: EnvironmentClusterDraft;
  namespace: string;
}): string | null {
  if (!params.draft.ownCluster) return null;
  if (params.draft.kubeconfig.trim() === "") {
    return "Paste the kubeconfig of the cluster.";
  }
  if (params.namespace.trim() === "") {
    return "Enter the namespace of that cluster to deploy into.";
  }
  return null;
}

/** The cluster fields to send when creating an environment. */
export function environmentClusterCreateFields(
  draft: EnvironmentClusterDraft,
): Pick<
  archestraApiTypes.CreateEnvironmentData["body"],
  "kubeconfig" | "agentRuntimePlatformBaseUrl"
> {
  if (!draft.ownCluster) return {};
  const platformUrl = draft.agentRuntimePlatformBaseUrl.trim();
  return {
    kubeconfig: draft.kubeconfig,
    ...(platformUrl ? { agentRuntimePlatformBaseUrl: platformUrl } : {}),
  };
}

/**
 * The cluster fields to send when updating an environment: only what the
 * person changed. An environment of the platform's cluster sends none.
 */
export function environmentClusterUpdateFields(params: {
  draft: EnvironmentClusterDraft;
  environment: {
    kubeconfigServer: string | null;
    agentRuntimePlatformBaseUrl: string | null;
  };
}): Pick<
  NonNullable<archestraApiTypes.UpdateEnvironmentData["body"]>,
  "kubeconfig" | "agentRuntimePlatformBaseUrl"
> {
  const { draft, environment } = params;
  if (environment.kubeconfigServer === null) return {};
  const platformUrl = draft.agentRuntimePlatformBaseUrl.trim();
  const platformUrlChanged =
    platformUrl !== (environment.agentRuntimePlatformBaseUrl ?? "");
  return {
    ...(draft.kubeconfig.trim() ? { kubeconfig: draft.kubeconfig } : {}),
    ...(platformUrlChanged
      ? { agentRuntimePlatformBaseUrl: platformUrl || null }
      : {}),
  };
}

/** The API server of a cluster as shown in lists: its host and port. */
export function clusterServerLabel(server: string): string {
  try {
    return new URL(server).host || server;
  } catch {
    return server;
  }
}

/** What each check of a cluster test is about, in the editor's words. */
export const ENVIRONMENT_CLUSTER_CHECK_LABELS: Record<
  EnvironmentClusterCheck["id"],
  string
> = {
  api: "Connection",
  deployAccess: "MCP servers",
  networkPolicy: "Network egress policy",
  codeSandbox: "Code sandbox",
  agentRuntime: "Agent Runtime",
};
