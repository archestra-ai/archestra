import type { AgentRunAttachPhase } from "@archestra/shared";
import type * as k8s from "@kubernetes/client-node";

/** One reportable step of an attach, before the terminal is live. */
export type RunnerStartupProgress = {
  phase: AgentRunAttachPhase;
  message: string;
  detail: string | null;
};

/**
 * Describe what a run's pod is currently waiting on.
 *
 * Kubernetes already explains itself — an unschedulable pod names the
 * constraint it failed, a failing pull names the image — but none of that
 * reaches the person watching a terminal that says "Connecting…". This turns
 * the pod's own status into that sentence.
 *
 * `null` is the pre-pod case: the Job is accepted and nothing carries it yet.
 */
export function describeRunnerStartupProgress(
  pod: k8s.V1Pod | null,
): RunnerStartupProgress {
  if (!pod) {
    return {
      phase: "queued",
      message: "Waiting for the run to be scheduled",
      detail: null,
    };
  }

  const phase = pod.status?.phase;

  if (phase === "Pending") {
    const unschedulable = findUnschedulableCondition(pod);
    if (unschedulable) {
      return {
        phase: "scheduling",
        message: "Waiting for a node with room for this run",
        detail: unschedulable,
      };
    }

    const waiting = findWaitingContainer(pod);
    if (waiting) return waiting;

    // Scheduled, but no container has reported a state yet.
    return isScheduled(pod)
      ? {
          phase: "pulling",
          message: "Preparing the container",
          detail: null,
        }
      : {
          phase: "scheduling",
          message: "Waiting for a node",
          detail: null,
        };
  }

  if (phase === "Running") {
    // A Running pod can still hold a container that is not up: a crash loop
    // reports here, and silently calling that "starting" is how a broken image
    // spends the whole attach timeout looking like a slow one.
    const waiting = findWaitingContainer(pod);
    if (waiting?.detail) {
      return { ...waiting, phase: "starting" };
    }
    return {
      phase: "starting",
      message: "Waiting for the agent session",
      detail: null,
    };
  }

  // Succeeded/Failed/Unknown: the callers that wait for a terminal treat these
  // as the end of the road, but a phase is still reported so a run that
  // finished mid-attach explains itself rather than timing out silently.
  return {
    phase: "starting",
    message: "Waiting for the agent session",
    detail: pod.status?.message ?? pod.status?.reason ?? null,
  };
}

/** The attach step after the agent session exists and before output flows. */
export function attachingProgress(): RunnerStartupProgress {
  return {
    phase: "attaching",
    message: "Opening the terminal stream",
    detail: null,
  };
}

/**
 * Whether two reports say the same thing.
 *
 * Startup is polled once a second; without this every subscriber would get a
 * message per tick saying nothing new.
 */
export function isSameRunnerStartupProgress(
  a: RunnerStartupProgress | null,
  b: RunnerStartupProgress,
): boolean {
  return (
    a !== null &&
    a.phase === b.phase &&
    a.message === b.message &&
    a.detail === b.detail
  );
}

export type RunnerStartupProgressReporter = (
  progress: RunnerStartupProgress & { resourceName?: string | null },
) => void;

// ===================== internals =====================

/**
 * Waiting reasons that mean the image itself is the problem, not the wait.
 * These are surfaced verbatim: "ImagePullBackOff: manifest unknown" is the
 * whole diagnosis, and hiding it behind "Connecting…" costs an operator the
 * trip to `kubectl describe`.
 */
const IMAGE_WAITING_REASONS = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "ImageInspectError",
  "InvalidImageName",
  "RegistryUnavailable",
]);

/** Waiting reasons that are ordinary progress, not a fault. */
const BENIGN_WAITING_REASONS = new Set([
  "ContainerCreating",
  "PodInitializing",
]);

function findWaitingContainer(pod: k8s.V1Pod): RunnerStartupProgress | null {
  const statuses = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];

  for (const status of statuses) {
    const waiting = status.state?.waiting;
    if (!waiting?.reason) continue;

    if (BENIGN_WAITING_REASONS.has(waiting.reason)) {
      return {
        phase: "pulling",
        message: "Pulling the agent image",
        detail: null,
      };
    }

    const detail = joinReason(waiting.reason, waiting.message);
    if (IMAGE_WAITING_REASONS.has(waiting.reason)) {
      return { phase: "pulling", message: "Pulling the agent image", detail };
    }
    // Anything else (CreateContainerConfigError, CrashLoopBackOff, a reason
    // this build has never heard of) is still worth showing rather than
    // flattening into a generic wait.
    return { phase: "pulling", message: "Starting the container", detail };
  }

  return null;
}

function findUnschedulableCondition(pod: k8s.V1Pod): string | null {
  const scheduled = pod.status?.conditions?.find(
    (condition) => condition.type === "PodScheduled",
  );
  if (!scheduled || scheduled.status === "True") return null;
  return joinReason(scheduled.reason, scheduled.message) ?? "Not yet scheduled";
}

function isScheduled(pod: k8s.V1Pod): boolean {
  return (
    pod.status?.conditions?.some(
      (condition) =>
        condition.type === "PodScheduled" && condition.status === "True",
    ) ?? false
  );
}

function joinReason(
  reason: string | undefined,
  message: string | undefined,
): string | null {
  if (reason && message) return `${reason}: ${message}`;
  return reason ?? message ?? null;
}
