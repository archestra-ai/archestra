import type {
  V1ContainerStateTerminated,
  V1ContainerStatus,
  V1Deployment,
  V1LabelSelector,
  V1LabelSelectorRequirement,
  V1OwnerReference,
  V1Pod,
  V1StatefulSet,
} from "@kubernetes/client-node";
import {
  type K8sWorkloadKind,
  severityRank,
  type TunerCandidate,
  type TunerCandidateSource,
  type TunerEvidenceRef,
  type TunerFingerprint,
  type TunerSeverity,
  tunerFingerprint,
} from "@/types/tuner";

export interface SreClusterSnapshot {
  pods: V1Pod[];
  deployments: V1Deployment[];
  statefulSets: V1StatefulSet[];
}

export function sreCandidates(
  snapshot: SreClusterSnapshot,
  now: Date,
): TunerCandidate[] {
  const owned = snapshot.pods.map(
    (pod): OwnedPod => ({
      pod,
      owner: resolvePodOwner(pod, snapshot.deployments),
    }),
  );
  const findings = [
    ...owned.flatMap((ownedPod) => podFindings(ownedPod, now)),
    ...snapshot.deployments.flatMap((d) =>
      replicaFindings({ kind: "Deployment", object: d }, { owned, now }),
    ),
    ...snapshot.statefulSets.flatMap((s) =>
      replicaFindings({ kind: "StatefulSet", object: s }, { owned, now }),
    ),
  ];
  return aggregate(findings);
}

// === Internal helpers ===

type SreSource = Extract<TunerCandidateSource, `sre_${string}`>;

type IssueOwner =
  | { type: "workload"; namespace: string; kind: K8sWorkloadKind; name: string }
  | { type: "pod"; namespace: string; name: string };

interface OwnedPod {
  pod: V1Pod;
  owner: IssueOwner;
}

type StuckReason = "CrashLoopBackOff" | "ImagePullBackOff" | "ErrImagePull";

type ReplicaWorkload =
  | { kind: "Deployment"; object: V1Deployment }
  | { kind: "StatefulSet"; object: V1StatefulSet };

interface Finding {
  source: SreSource;
  owner: IssueOwner;
  container: string | null;
  severity: TunerSeverity;
  /** Pods that show the issue; empty when the workload itself does. */
  pods: string[];
  note: string;
}

const MINUTE_MS = 60_000;
const RECENT_TERMINATION_MS = 24 * 60 * MINUTE_MS;
const STUCK_PENDING_MS = 10 * MINUTE_MS;
const REPLICA_SHORTAGE_MS = 10 * MINUTE_MS;
const OOM_CRITICAL_RESTARTS = 5;
const RESTART_LOOP_MIN_RESTARTS = 5;
const MAX_POD_EVIDENCE = 5;

function podFindings({ pod, owner }: OwnedPod, now: Date): Finding[] {
  const podName = pod.metadata?.name ?? "";
  const statuses = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  const at = (source: SreSource, container: string | null) => ({
    source,
    owner,
    container,
    pods: [podName],
  });

  const terminationFindings = statuses.flatMap((status): Finding[] => {
    const terminated = lastTermination(status);
    const finishedAt = terminated?.finishedAt;
    if (
      !terminated ||
      !finishedAt ||
      now.getTime() - finishedAt.getTime() >= RECENT_TERMINATION_MS
    ) {
      return [];
    }
    const when = finishedAt.toISOString();
    // A recent OOMKilled termination is reported only as OOM, never also as a restart loop.
    if (terminated.reason === "OOMKilled") {
      return [
        {
          ...at("sre_oom_killed", status.name),
          severity:
            status.restartCount >= OOM_CRITICAL_RESTARTS ? "critical" : "warn",
          note: `${podName}: OOMKilled at ${when}, ${status.restartCount} restarts`,
        },
      ];
    }
    if (status.restartCount > RESTART_LOOP_MIN_RESTARTS) {
      return [
        {
          ...at("sre_restart_loop", status.name),
          severity: "warn",
          note: `${podName}: ${status.restartCount} restarts, last exit ${terminated.reason ?? "unknown"} (code ${terminated.exitCode}) at ${when}`,
        },
      ];
    }
    return [];
  });

  const waitingFindings = statuses.flatMap((status): Finding[] => {
    const reason = stuckReason(status.state?.waiting?.reason);
    if (!reason) return [];
    return [
      {
        ...at("sre_pod_stuck", status.name),
        severity: stuckSeverity(reason),
        note: `${podName}: waiting in ${reason}, ${status.restartCount} restarts`,
      },
    ];
  });

  const createdAt = pod.metadata?.creationTimestamp;
  const pendingFindings: Finding[] =
    waitingFindings.length === 0 &&
    pod.status?.phase === "Pending" &&
    createdAt &&
    now.getTime() - createdAt.getTime() > STUCK_PENDING_MS
      ? [
          {
            ...at("sre_pod_stuck", null),
            severity: "warn",
            note: `${podName}: Pending since ${createdAt.toISOString()}${schedulingNote(pod)}`,
          },
        ]
      : [];

  return [...terminationFindings, ...waitingFindings, ...pendingFindings];
}

/**
 * Stateless "observed > 10 min": the shortage counts only when the controller
 * has seen the current spec and neither the workload's conditions nor any of
 * its unready pods changed within the window. Rollouts and fresh pods reset it.
 */
function replicaFindings(
  workload: ReplicaWorkload,
  { owned, now }: { owned: OwnedPod[]; now: Date },
): Finding[] {
  const { metadata, spec, status } = workload.object;
  const namespace = metadata?.namespace ?? "";
  const name = metadata?.name ?? "";
  const desired = spec?.replicas ?? 1;
  const available = (() => {
    switch (workload.kind) {
      case "Deployment":
        return workload.object.status?.availableReplicas ?? 0;
      case "StatefulSet":
        return workload.object.status?.readyReplicas ?? 0;
    }
  })();
  const createdAt = metadata?.creationTimestamp;
  if (
    available >= desired ||
    !createdAt ||
    metadata?.generation !== status?.observedGeneration
  ) {
    return [];
  }

  const unreadyPods = owned
    .filter(
      ({ pod, owner }) =>
        owner.type === "workload" &&
        owner.kind === workload.kind &&
        owner.namespace === namespace &&
        owner.name === name &&
        !isPodReady(pod),
    )
    .map(({ pod }) => pod);
  const lastChange = Math.max(
    createdAt.getTime(),
    ...(status?.conditions ?? []).flatMap((c) =>
      c.lastTransitionTime ? [c.lastTransitionTime.getTime()] : [],
    ),
    ...unreadyPods.flatMap((pod) => {
      const changedAt =
        readyCondition(pod)?.lastTransitionTime ??
        pod.metadata?.creationTimestamp;
      return changedAt ? [changedAt.getTime()] : [];
    }),
  );
  if (now.getTime() - lastChange <= REPLICA_SHORTAGE_MS) {
    return [];
  }

  return [
    {
      source: "sre_replicas_unavailable",
      owner: { type: "workload", namespace, kind: workload.kind, name },
      container: null,
      severity: available === 0 && desired > 0 ? "critical" : "warn",
      pods: unreadyPods.map((pod) => pod.metadata?.name ?? ""),
      note: `${available} of ${desired} replicas ${workload.kind === "Deployment" ? "available" : "ready"}, unchanged since ${new Date(lastChange).toISOString()}`,
    },
  ];
}

function aggregate(findings: Finding[]): TunerCandidate[] {
  const groups = new Map<TunerFingerprint, [Finding, ...Finding[]]>();
  for (const finding of findings) {
    const key = fingerprintOf(finding);
    const group = groups.get(key);
    groups.set(key, group ? [...group, finding] : [finding]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fingerprint, group]) => {
      const [first] = group;
      const pods = [...new Set(group.flatMap((f) => f.pods))].sort();
      const notes = group.map((f) => f.note).sort();
      const shownNotes = notes.slice(0, MAX_POD_EVIDENCE).join("; ");
      const hiddenNotes = notes.length - MAX_POD_EVIDENCE;
      const subject = describeSubject(first);
      return {
        fingerprint,
        source: first.source,
        severity: group.reduce<TunerSeverity>(
          (max, f) =>
            severityRank(f.severity) > severityRank(max) ? f.severity : max,
          "info",
        ),
        title: `${sourceLabel(first.source)}: ${subject}`,
        detail: `${sourceLabel(first.source)} on ${subject}; ${pods.length} pod(s) affected. ${shownNotes}${hiddenNotes > 0 ? `; and ${hiddenNotes} more` : ""}.`,
        evidence: evidenceOf(first.owner, pods),
      };
    });
}

function fingerprintOf(finding: Finding): TunerFingerprint {
  const { owner, container } = finding;
  const kind = owner.type === "workload" ? owner.kind : "Pod";
  return tunerFingerprint(
    finding.source,
    owner.namespace,
    kind,
    owner.name,
    ...(container === null ? [] : [container]),
  );
}

function evidenceOf(owner: IssueOwner, pods: string[]): TunerEvidenceRef[] {
  const podRefs = pods.slice(0, MAX_POD_EVIDENCE).map(
    (name): TunerEvidenceRef => ({
      type: "k8s_pod",
      namespace: owner.namespace,
      name,
    }),
  );
  switch (owner.type) {
    case "workload":
      return [
        {
          type: "k8s_workload",
          namespace: owner.namespace,
          kind: owner.kind,
          name: owner.name,
        },
        ...podRefs,
      ];
    case "pod":
      return podRefs;
  }
}

function describeSubject({ owner, container }: Finding): string {
  const kind = owner.type === "workload" ? owner.kind : "Pod";
  const base = `${kind} ${owner.namespace}/${owner.name}`;
  return container === null ? base : `${base} container ${container}`;
}

function sourceLabel(source: SreSource): string {
  switch (source) {
    case "sre_oom_killed":
      return "Container OOMKilled";
    case "sre_restart_loop":
      return "Container restart loop";
    case "sre_pod_stuck":
      return "Pod stuck";
    case "sre_replicas_unavailable":
      return "Replicas unavailable";
  }
}

function resolvePodOwner(pod: V1Pod, deployments: V1Deployment[]): IssueOwner {
  const namespace = pod.metadata?.namespace ?? "";
  const asPod: IssueOwner = {
    type: "pod",
    namespace,
    name: pod.metadata?.name ?? "",
  };
  const ref = pod.metadata?.ownerReferences?.find((r) => r.controller === true);
  const kind = ref ? ownerKind(ref) : null;
  if (!ref || !kind) return asPod;
  const owner: IssueOwner = {
    type: "workload",
    namespace,
    kind,
    name: ref.name,
  };

  switch (kind) {
    case "ReplicaSet": {
      const matches = deployments.filter(
        (d) =>
          d.metadata?.namespace === namespace &&
          ref.name.startsWith(`${d.metadata?.name}-`) &&
          selectorMatches(d.spec?.selector, pod.metadata?.labels ?? {}),
      );
      const [deployment] = matches;
      return matches.length === 1 && deployment?.metadata?.name
        ? { ...owner, kind: "Deployment", name: deployment.metadata.name }
        : owner;
    }
    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
    case "Job":
    case "CronJob":
      return owner;
  }
}

function ownerKind(ref: V1OwnerReference): K8sWorkloadKind | null {
  const group = ref.apiVersion.includes("/")
    ? ref.apiVersion.split("/")[0]
    : "";
  switch (`${group}/${ref.kind}`) {
    case "apps/Deployment":
      return "Deployment";
    case "apps/StatefulSet":
      return "StatefulSet";
    case "apps/DaemonSet":
      return "DaemonSet";
    case "apps/ReplicaSet":
      return "ReplicaSet";
    case "batch/Job":
      return "Job";
    case "batch/CronJob":
      return "CronJob";
    default:
      return null;
  }
}

/** An empty selector attributes nothing: only explicit label matches count. */
function selectorMatches(
  selector: V1LabelSelector | undefined,
  labels: Record<string, string>,
): boolean {
  const matchLabels = Object.entries(selector?.matchLabels ?? {});
  const matchExpressions = selector?.matchExpressions ?? [];
  if (matchLabels.length === 0 && matchExpressions.length === 0) return false;
  return (
    matchLabels.every(([key, value]) => labels[key] === value) &&
    matchExpressions.every((expr) => expressionMatches(expr, labels))
  );
}

function expressionMatches(
  { key, operator, values }: V1LabelSelectorRequirement,
  labels: Record<string, string>,
): boolean {
  const value = labels[key];
  switch (operator) {
    case "In":
      return value !== undefined && (values ?? []).includes(value);
    case "NotIn":
      return value === undefined || !(values ?? []).includes(value);
    case "Exists":
      return value !== undefined;
    case "DoesNotExist":
      return value === undefined;
    default:
      return false;
  }
}

function lastTermination(
  status: V1ContainerStatus,
): V1ContainerStateTerminated | undefined {
  return status.state?.terminated ?? status.lastState?.terminated;
}

function stuckReason(reason: string | undefined): StuckReason | null {
  switch (reason) {
    case "CrashLoopBackOff":
    case "ImagePullBackOff":
    case "ErrImagePull":
      return reason;
    default:
      return null;
  }
}

function stuckSeverity(reason: StuckReason): TunerSeverity {
  switch (reason) {
    case "CrashLoopBackOff":
      return "critical";
    case "ImagePullBackOff":
    case "ErrImagePull":
      return "warn";
  }
}

function schedulingNote(pod: V1Pod): string {
  const scheduled = pod.status?.conditions?.find(
    (c) => c.type === "PodScheduled",
  );
  return scheduled?.status === "False" && scheduled.reason
    ? ` (${scheduled.reason})`
    : "";
}

function readyCondition(pod: V1Pod) {
  return pod.status?.conditions?.find((c) => c.type === "Ready");
}

function isPodReady(pod: V1Pod): boolean {
  return readyCondition(pod)?.status === "True";
}
