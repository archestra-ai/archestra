import type * as k8s from "@kubernetes/client-node";
import logger from "@/logging";

// === Public API ===

export type NetworkPolicyProbeResult =
  | "enforced"
  | "not-enforced"
  | "inconclusive"
  | "absent";

export interface NetworkPolicyProbeVerdict {
  result: NetworkPolicyProbeResult;
  /** When the treatment arm ran, for reporting how current the answer is. */
  probedAt: string | null;
  /** Short human summary of the two arms, e.g. "control=reachable treatment=blocked". */
  detail: string | null;
}

/**
 * Reads the verdict left behind by the chart's NetworkPolicy enforcement probe.
 *
 * The chart runs two pods after each install/upgrade against the same target,
 * with a deny-all egress policy selecting only one of them. Comparing the arms
 * answers a question no API surface can: the Kubernetes API accepts
 * NetworkPolicy objects whether or not a dataplane enforces them, GKE serves the
 * Calico CRDs with node enforcement switched off, and Dataplane V2, kindnet and
 * the EKS VPC CNI all enforce while publishing no CRD at all.
 *
 * Each pod records its own arm in its container's termination message, because
 * the treatment pod is network-isolated by construction and cannot reach the API
 * server to report; the kubelet copies the message into pod status on its behalf.
 */
class NetworkPolicyProbeReader {
  private cache = new WeakMap<
    k8s.CoreV1Api,
    { expiresAt: number; value: NetworkPolicyProbeVerdict }
  >();

  async readVerdict(
    coreApi: k8s.CoreV1Api,
    namespace: string,
  ): Promise<NetworkPolicyProbeVerdict> {
    const cached = this.cache.get(coreApi);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const verdict = await this.loadVerdict(coreApi, namespace);
    // The probe runs as a post-install hook, so the platform is already serving
    // by the time it reports. Holding "no result yet" for the full interval
    // would keep the inferred answer in place well after the real one landed.
    this.cache.set(coreApi, {
      value: verdict,
      expiresAt:
        Date.now() +
        (verdict.result === "absent"
          ? PENDING_PROBE_CACHE_TTL_MS
          : PROBE_CACHE_TTL_MS),
    });
    return verdict;
  }

  /** @internal exported for tests */
  clearCache(): void {
    this.cache = new WeakMap();
  }

  // === Private helpers ===

  private async loadVerdict(
    coreApi: k8s.CoreV1Api,
    namespace: string,
  ): Promise<NetworkPolicyProbeVerdict> {
    let pods: k8s.V1Pod[];
    try {
      const list = await coreApi.listNamespacedPod({
        namespace,
        labelSelector: PROBE_LABEL_SELECTOR,
      });
      pods = list.items ?? [];
    } catch (error) {
      // Reporting "not enforced" here would state, on no evidence, that a
      // cluster nobody could reach is insecure.
      logger.debug(
        { err: error, namespace },
        "Failed to list network policy probe pods",
      );
      return absent("probe pods could not be listed");
    }

    const control = armOutcome(pods, "control");
    const treatment = armOutcome(pods, "treatment");
    const detail = `control=${control ?? "none"} treatment=${treatment ?? "none"}`;

    if (control === null || treatment === null) {
      return absent(detail);
    }
    const measuredAt = probedAt(pods);
    // A verdict only describes the cluster as it was when the probe ran. Left to
    // stand indefinitely, an old "enforced" would keep the warning hidden on a
    // cluster that has since lost enforcement, so an aged result gives way to
    // whatever the API can still be asked directly.
    if (
      measuredAt &&
      Date.now() - Date.parse(measuredAt) > MAX_VERDICT_AGE_MS
    ) {
      return { result: "inconclusive", probedAt: measuredAt, detail };
    }
    if (control === "blocked") {
      // The target never came up, so the treatment arm was never given a
      // reachable path to be denied and its result carries no information.
      return { result: "inconclusive", probedAt: measuredAt, detail };
    }
    return {
      result: treatment === "reachable" ? "not-enforced" : "enforced",
      probedAt: measuredAt,
      detail,
    };
  }
}

export const networkPolicyProbeReader = new NetworkPolicyProbeReader();

// === Internal helpers ===

const PROBE_CACHE_TTL_MS = 5 * 60 * 1000;
const PENDING_PROBE_CACHE_TTL_MS = 30 * 1000;

/**
 * How long a verdict is trusted. The probe reruns on every install and upgrade,
 * so anything older than this belongs to a cluster nobody has deployed to in a
 * week and should no longer speak for its current state.
 */
const MAX_VERDICT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Must match `archestra-platform.networkPolicyProbeLabels` in the chart. */
const PROBE_LABEL_SELECTOR = "app.kubernetes.io/component=netpol-probe";
const PROBE_ROLE_LABEL = "archestra.io/netpol-probe-role";

type ArmOutcome = "reachable" | "blocked";

function absent(detail: string): NetworkPolicyProbeVerdict {
  return { result: "absent", probedAt: null, detail };
}

/**
 * The arm's own report, or null when it has not finished. A pod that was
 * evicted, OOM-killed or deadline-exceeded leaves no message, and a half-run
 * probe must not be scored.
 */
function armOutcome(pods: k8s.V1Pod[], role: string): ArmOutcome | null {
  const message = terminatedState(pods, role)?.message?.trim();
  return message === "reachable" || message === "blocked" ? message : null;
}

function probedAt(pods: k8s.V1Pod[]): string | null {
  const finishedAt = terminatedState(pods, "treatment")?.finishedAt;
  return finishedAt ? new Date(finishedAt).toISOString() : null;
}

/**
 * The latest run of an arm. Hook pods survive `helm uninstall`, so a namespace
 * can hold pods from a release that is no longer installed; taking the newest
 * keeps a retired run from answering for the cluster as it is now.
 */
function terminatedState(
  pods: k8s.V1Pod[],
  role: string,
): k8s.V1ContainerStateTerminated | undefined {
  return pods
    .filter((pod) => pod.metadata?.labels?.[PROBE_ROLE_LABEL] === role)
    .map((pod) => pod.status?.containerStatuses?.[0]?.state?.terminated)
    .filter((state) => state?.finishedAt)
    .sort(
      (a, b) =>
        Date.parse(String(b?.finishedAt)) - Date.parse(String(a?.finishedAt)),
    )[0];
}
