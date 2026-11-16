import * as k8s from "@kubernetes/client-node";
import config from "@/config";
import { describeK8sApiError, loadKubeConfig } from "@/k8s/shared";
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
 * The check asks the API server to admit, as a dry run, a pod that names the
 * class in the Agent Runtime namespace: Kubernetes' RuntimeClass admission
 * rejects it when the class does not exist, and nothing is ever created. This
 * needs only the `create pods` the platform already has there, not the
 * cluster-scoped read of RuntimeClasses. Any other rejection (RBAC, Pod
 * Security, a policy webhook) leaves the answer unknown: launches go ahead and
 * the platform logs once that it could not check.
 */
class AgentRuntimeClassDetector {
  private state: "present" | "missing" | "unknown" | null = null;
  private lastCheckedAt = 0;
  private inFlight: Promise<void> | null = null;
  private api: k8s.CoreV1Api | null = null;
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
  reset(api: k8s.CoreV1Api | null = null): void {
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
      const { kubeConfig, namespace } = loadKubeConfig();
      this.api ??= kubeConfig.makeApiClient(k8s.CoreV1Api);
      await this.api.createNamespacedPod({
        namespace: config.agentRuntime.namespace ?? namespace,
        body: probePod(name),
        dryRun: "All",
      });
      if (this.state === "missing") {
        logger.info(
          { runtimeClassName: name },
          "Agent Runtime RuntimeClass is now available",
        );
      }
      this.state = "present";
    } catch (error) {
      if (isMissingRuntimeClassRejection(error, name)) {
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
          "Could not verify that the Agent Runtime RuntimeClass exists; runs will start without the check. The check is a dry-run pod create in the Agent Runtime namespace.",
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

/**
 * A pod that only exists to be admitted as a dry run. It meets the restricted
 * Pod Security level, so a namespace that enforces it does not reject it for
 * an unrelated reason.
 */
function probePod(runtimeClassName: string): k8s.V1Pod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      generateName: "archestra-runtime-class-check-",
      labels: { "app.kubernetes.io/managed-by": "archestra" },
    },
    spec: {
      runtimeClassName,
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 65532,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "check",
          image: "registry.k8s.io/pause:3.10",
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
        },
      ],
    },
  };
}

/** The RuntimeClass admission plugin's rejection: `pod rejected: RuntimeClass "x" not found`. */
function isMissingRuntimeClassRejection(error: unknown, name: string): boolean {
  return (
    describeK8sApiError(error)?.includes(`RuntimeClass "${name}" not found`) ??
    false
  );
}

function missingMessage(name: string): string {
  return `The RuntimeClass "${name}" set in ARCHESTRA_AGENT_RUNTIME_RUNTIME_CLASS_NAME does not exist in this cluster, so Kubernetes rejects unprivileged Agent Runtime pods. Install the RuntimeClass (for example a gVisor node pool) or correct the setting.`;
}
