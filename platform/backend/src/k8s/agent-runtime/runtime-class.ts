import * as k8s from "@kubernetes/client-node";
import config from "@/config";
import { describeK8sApiError, isK8sNotFoundError, loadKubeConfig } from "@/k8s/shared";
import logger from "@/logging";
import { tagAgentRunFailure } from "@/services/agent-runtime/run-failure";
import { ApiError } from "@/types";

/**
 * Whether the RuntimeClass named by ARCHESTRA_AGENT_RUNTIME_RUNTIME_CLASS_NAME
 * exists. Kubernetes rejects a pod that names a missing RuntimeClass, so a
 * typo, or a cluster without sandbox nodes, would otherwise leave every
 * unprivileged run waiting for a pod that is never created until the startup
 * timeout. A missing class refuses the launch at once with a clear reason.
 *
 * Reading a RuntimeClass needs a cluster-scoped `get` (the Helm chart grants
 * it for the configured name). Without it the answer is unknown: launches go
 * ahead and the platform logs once that it could not check.
 */
class AgentRuntimeClassDetector {
  private state: "present" | "missing" | "unknown" | null = null;
  private lastCheckedAt = 0;
  private inFlight: Promise<void> | null = null;
  private api: k8s.NodeV1Api | null = null;
  private warnedUnknown = false;

  /** Check at startup and log a clear error when the class is missing. */
  async checkAtStartup(): Promise<void> {
    if (!config.agentRuntime.runtimeClassName) return;
    await this.refresh({ force: true });
  }

  /**
   * Refuse an unprivileged launch when the configured RuntimeClass does not
   * exist. A privileged run never uses the RuntimeClass, so it is not checked.
   */
  async assertUsable(params: { privileged: boolean }): Promise<void> {
    const name = config.agentRuntime.runtimeClassName;
    if (!name || params.privileged) return;
    await this.refresh({ force: false });
    if (this.state === "missing") {
      throw tagAgentRunFailure(
        new ApiError(409, missingMessage(name)),
        "launch.misconfigured",
      );
    }
  }

  /** @internal exported for tests */
  reset(api: k8s.NodeV1Api | null = null): void {
    this.state = null;
    this.lastCheckedAt = 0;
    this.inFlight = null;
    this.api = api;
    this.warnedUnknown = false;
  }

  private async refresh(params: { force: boolean }): Promise<void> {
    const maxAge =
      this.state === "present" ? PRESENT_RECHECK_MS : MISSING_RECHECK_MS;
    if (
      !params.force &&
      this.state !== null &&
      Date.now() - this.lastCheckedAt < maxAge
    ) {
      return;
    }
    this.inFlight ??= this.detect().finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
  }

  private async detect(): Promise<void> {
    const name = config.agentRuntime.runtimeClassName;
    if (!name) return;
    this.lastCheckedAt = Date.now();
    try {
      this.api ??= loadKubeConfig().kubeConfig.makeApiClient(k8s.NodeV1Api);
      await this.api.readRuntimeClass({ name });
      if (this.state === "missing") {
        logger.info(
          { runtimeClassName: name },
          "Agent Runtime RuntimeClass is now available",
        );
      }
      this.state = "present";
    } catch (error) {
      if (isK8sNotFoundError(error)) {
        if (this.state !== "missing") {
          logger.error({ runtimeClassName: name }, missingMessage(name));
        }
        this.state = "missing";
        return;
      }
      // Forbidden, unreachable or anything else: say so once and do not
      // block runs on a check that could not be made.
      if (!this.warnedUnknown) {
        this.warnedUnknown = true;
        logger.warn(
          {
            runtimeClassName: name,
            reason: describeK8sApiError(error) ?? String(error),
          },
          "Could not verify that the Agent Runtime RuntimeClass exists; runs will start without the check. Grant the platform ServiceAccount get on this RuntimeClass to enable it.",
        );
      }
      this.state = "unknown";
    }
  }
}

export const agentRuntimeClassDetector = new AgentRuntimeClassDetector();

// === Internal helpers ===

/** A class that exists rarely disappears; a missing one is re-checked soon. */
const PRESENT_RECHECK_MS = 5 * 60_000;
const MISSING_RECHECK_MS = 30_000;

function missingMessage(name: string): string {
  return `The RuntimeClass "${name}" set in ARCHESTRA_AGENT_RUNTIME_RUNTIME_CLASS_NAME does not exist in this cluster, so Kubernetes rejects unprivileged Agent Runtime pods. Install the RuntimeClass (for example a gVisor node pool) or correct the setting.`;
}
