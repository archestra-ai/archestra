import type { A2aRemoteAgent } from "@/lib/a2a-remote-agents.query";

type DeleteTarget = Pick<A2aRemoteAgent, "name" | "assignmentCount">;

export function getA2aRemoteAgentDeleteDescription(
  target: DeleteTarget,
): string {
  const base = `This removes ${target.name} and its stored connection credential.`;
  if (target.assignmentCount === 0) {
    return `${base} This cannot be undone.`;
  }

  const singular = target.assignmentCount === 1;
  return `${base} It is currently assigned as a subagent to ${target.assignmentCount} ${singular ? "agent" : "agents"}. Deleting it will remove ${singular ? "that assignment" : "those assignments"}, and ${singular ? "that agent" : "those agents"} will no longer be able to delegate to it. This cannot be undone.`;
}

export function getBulkA2aRemoteAgentDeleteDescription(
  targets: DeleteTarget[],
): string {
  const targetCount = targets.length;
  const base = `Delete ${targetCount} ${targetCount === 1 ? "external A2A agent" : "external A2A agents"}?`;
  const assignmentCount = targets.reduce(
    (total, target) => total + target.assignmentCount,
    0,
  );
  if (assignmentCount === 0) {
    return `${base} This cannot be undone.`;
  }

  const singular = assignmentCount === 1;
  return `${base} The selected external ${targetCount === 1 ? "agent has" : "agents have"} ${assignmentCount} subagent ${singular ? "assignment" : "assignments"}. Deleting ${targetCount === 1 ? "it" : "them"} will remove ${singular ? "that assignment" : "those assignments"}, and ${singular ? "that assigned agent" : "those assigned agents"} will no longer be able to delegate to ${targetCount === 1 ? "it" : "them"}. This cannot be undone.`;
}
