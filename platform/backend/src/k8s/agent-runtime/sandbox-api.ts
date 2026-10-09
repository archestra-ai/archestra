import type * as k8s from "@kubernetes/client-node";
import {
  createK8sClients,
  isK8sNotFoundError,
  loadKubeConfig,
} from "@/k8s/shared";
import logger from "@/logging";
import type { K8sAgentSandboxCapabilities } from "@/types";
import { AGENT_SANDBOX_API } from "./manifests";

/** The upstream extensions group: warm pools, templates and claims. */
export const AGENT_SANDBOX_EXTENSIONS_API = {
  group: "extensions.agents.x-k8s.io",
  version: "v1beta1",
} as const;

/**
 * Which Agent Sandbox resources the cluster serves. Agent Runtime is available
 * exactly when every one of them is: each run is a `Sandbox`, and the warm pool
 * claims pooled sandboxes through the extensions group.
 *
 * API discovery needs no RBAC, so this works with namespaced runtime
 * permissions.
 */
export async function inspectAgentSandboxApi(
  customObjectsApi: k8s.CustomObjectsApi,
): Promise<K8sAgentSandboxCapabilities> {
  const missing = await Promise.all(
    REQUIRED_RESOURCES.map(async ({ group, version, plurals }) => {
      const served = await listServedResources(customObjectsApi, {
        group,
        version,
      });
      return plurals
        .filter((plural) => !served.has(plural))
        .map((plural) => `${plural}.${group}`);
    }),
  );
  const missingResources = missing.flat();
  const installed = missingResources.length === 0;
  return {
    installed,
    missingResources,
    message: installed
      ? "The Agent Sandbox controller is installed. Agents can run in dedicated runtimes."
      : AGENT_SANDBOX_MISSING_MESSAGE,
  };
}

/** Reported when the cluster could not be inspected at all. */
export function uninspectedAgentSandboxCapabilities(): K8sAgentSandboxCapabilities {
  return {
    installed: false,
    missingResources: [],
    message:
      "Kubernetes capabilities could not be inspected. Agent Runtime is unavailable until Kubernetes access is configured.",
  };
}

/**
 * Whether this deployment can run Agent Runtime work right now, readable
 * synchronously by the many call sites that gate on it.
 *
 * Only a positive answer is kept for good. A negative one is re-checked in the
 * background once it is stale, so installing the controller takes effect
 * without a platform restart.
 */
class AgentSandboxApiDetector {
  private installed = false;
  private lastCheckedAt = 0;
  /** Without a kubeconfig there is nothing to re-check. */
  private clusterUnreachable = false;
  private inFlight: Promise<boolean> | null = null;
  private customObjectsApi: k8s.CustomObjectsApi | null = null;

  get isInstalled(): boolean {
    if (
      !this.installed &&
      !this.clusterUnreachable &&
      Date.now() - this.lastCheckedAt >= RECHECK_INTERVAL_MS
    ) {
      void this.refresh();
    }
    return this.installed;
  }

  /** Re-inspect the cluster now; resolves to the fresh answer. */
  async refresh(): Promise<boolean> {
    if (this.installed) return true;
    this.inFlight ??= this.detect().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** @internal exported for tests */
  reset(): void {
    this.installed = false;
    this.lastCheckedAt = 0;
    this.clusterUnreachable = false;
    this.inFlight = null;
    this.customObjectsApi = null;
  }

  private async detect(): Promise<boolean> {
    this.lastCheckedAt = Date.now();
    if (!this.customObjectsApi) {
      try {
        const { kubeConfig, namespace } = loadKubeConfig();
        this.customObjectsApi = createK8sClients(
          kubeConfig,
          namespace,
        ).customObjectsApi;
      } catch {
        this.clusterUnreachable = true;
        return false;
      }
    }
    const { installed } = await inspectAgentSandboxApi(this.customObjectsApi);
    if (installed && !this.installed) {
      logger.info("Agent Sandbox controller detected; Agent Runtime is available");
    }
    this.installed = installed;
    return installed;
  }
}

export const agentSandboxApi = new AgentSandboxApiDetector();

// === Internal helpers ===

const RECHECK_INTERVAL_MS = 30_000;

const AGENT_SANDBOX_MISSING_MESSAGE =
  "The Agent Sandbox controller is not installed on this cluster, so agents cannot run in dedicated runtimes. Install the controller to enable Agent Runtime.";

const REQUIRED_RESOURCES = [
  {
    group: AGENT_SANDBOX_API.group,
    version: AGENT_SANDBOX_API.version,
    plurals: [AGENT_SANDBOX_API.plural],
  },
  {
    ...AGENT_SANDBOX_EXTENSIONS_API,
    plurals: ["sandboxclaims", "sandboxtemplates", "sandboxwarmpools"],
  },
] as const;

async function listServedResources(
  customObjectsApi: k8s.CustomObjectsApi,
  groupVersion: { group: string; version: string },
): Promise<Set<string>> {
  try {
    const resourceList =
      await customObjectsApi.getAPIResources(groupVersion);
    return new Set(resourceList.resources?.map((resource) => resource.name));
  } catch (error) {
    // A cluster without the CRD answers discovery with a plain-text 404.
    if (!isK8sNotFoundError(error)) {
      logger.warn(
        { err: error, ...groupVersion },
        "Failed to inspect Agent Sandbox Kubernetes API resources",
      );
    }
    return new Set();
  }
}
