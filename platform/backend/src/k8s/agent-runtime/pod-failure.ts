import { stripVTControlCharacters } from "node:util";
import type { V1Pod } from "@kubernetes/client-node";
import { workspaceExitExplanation } from "./workspace-exit";

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
      // A memory kill names the limit it hit: the reader then knows the size
      // the run had and can start one at a larger tier.
      const memoryLimit =
        terminated.reason === "OOMKilled"
          ? containerMemoryLimit(pod, status.name)
          : null;
      if (memoryLimit) exit.push(`memory limit ${memoryLimit}`);
      details.push(
        `${kind} ${diagnosticText(status.name)}: ${diagnosticText(terminated.reason) || "Terminated"} (${exit.join(", ")})`,
      );
      const terminationMessage = diagnosticText(terminated.message);
      if (terminationMessage) details.push(terminationMessage);
      // The runtime writes why its volume stopped the run to the termination
      // message; this says the same when that write did not happen.
      else if (kind === "Container") {
        const workspace = workspaceExitExplanation(terminated.exitCode);
        if (workspace) details.push(workspace);
      }
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

function containerMemoryLimit(
  pod: V1Pod,
  containerName: string | undefined,
): string | null {
  const container = [
    ...(pod.spec?.initContainers ?? []),
    ...(pod.spec?.containers ?? []),
  ].find((candidate) => candidate.name === containerName);
  return diagnosticText(container?.resources?.limits?.memory) || null;
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
