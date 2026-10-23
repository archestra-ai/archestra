import { stripVTControlCharacters } from "node:util";
import type { V1Pod } from "@kubernetes/client-node";
import type { AgentRunFailureCode } from "@/services/agent-runtime/run-failure";

const TRUNCATED = "… (truncated)";

/** Preserve the failed pod's diagnostics before its workspace is cleaned up. */
export function describeAgentRuntimePodFailure(
  pod: V1Pod | null,
  namespace: string,
  sandboxCondition?: { reason?: string; message?: string },
): string | null {
  if (pod?.status?.phase !== "Failed") return null;

  const details: string[] = [];
  const reason = diagnosticText(pod.status.reason);
  const message = diagnosticText(pod.status.message);
  if (reason) details.push(`Reason: ${reason}`);
  if (message) details.push(message);

  for (const [kind, statuses] of [
    ["Init container", pod.status.initContainerStatuses],
    ["Container", pod.status.containerStatuses],
  ] as const) {
    for (const status of statuses ?? []) {
      const terminated = status.state?.terminated;
      if (
        !terminated ||
        (terminated.exitCode === 0 &&
          !terminated.signal &&
          (!terminated.reason || terminated.reason === "Completed"))
      )
        continue;

      const exit = [`exit code ${terminated.exitCode}`];
      if (terminated.signal) exit.push(`signal ${terminated.signal}`);
      details.push(
        `${kind} ${diagnosticText(status.name)}: ${diagnosticText(terminated.reason) || "Terminated"} (${exit.join(", ")})`,
      );
      const terminationMessage = diagnosticText(terminated.message);
      if (terminationMessage) details.push(terminationMessage);
    }
  }

  for (const condition of pod.status.conditions ?? []) {
    if (condition.type !== "DisruptionTarget" || condition.status !== "True")
      continue;
    const disruption = [
      diagnosticText(condition.reason),
      diagnosticText(condition.message),
    ]
      .filter(Boolean)
      .join(": ");
    if (disruption) details.push(disruption);
  }
  if (sandboxCondition && sandboxCondition.reason !== "PodFailed") {
    const context = [
      diagnosticText(sandboxCondition.reason),
      diagnosticText(sandboxCondition.message),
    ]
      .filter(Boolean)
      .join(": ");
    if (context) details.push(`Sandbox: ${context}`);
  }
  if (details.length === 0) {
    details.push("Kubernetes reported no additional failure details.");
  }
  const name = diagnosticText(pod.metadata?.name);
  const summary = [
    "The Agent Runtime pod failed.",
    ...(name ? [`Pod: ${diagnosticText(namespace)}/${name}`] : []),
    ...details,
  ].join("\n");
  return summary.length > 4096
    ? `${summary.slice(0, 4096 - TRUNCATED.length - 1)}\n${TRUNCATED}`
    : summary;
}

/** Failure code for a pod that `describeAgentRuntimePodFailure` reports. */
export function classifyAgentRuntimePodFailure(
  pod: V1Pod,
): Extract<AgentRunFailureCode, `pod.${string}`> {
  const disrupted = (pod.status?.conditions ?? []).some(
    (condition) =>
      condition.type === "DisruptionTarget" && condition.status === "True",
  );
  if (pod.status?.reason === "Evicted" || disrupted) return "pod.evicted";
  const statuses = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  if (
    statuses.some((status) => status.state?.terminated?.reason === "OOMKilled")
  )
    return "pod.oom_killed";
  return "pod.failed";
}

function diagnosticText(value: string | undefined): string {
  const text = stripVTControlCharacters(value ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Kubernetes termination text must not inject terminal control characters
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .trim();
  return text.length > 1600
    ? `${text.slice(0, 1600 - TRUNCATED.length)}${TRUNCATED}`
    : text;
}
