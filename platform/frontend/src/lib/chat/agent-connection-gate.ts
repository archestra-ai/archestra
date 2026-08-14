import type { archestraApiTypes } from "@archestra/shared";

type AgentCredentialReadiness =
  archestraApiTypes.GetAgentCredentialReadinessResponses["200"][number];

export type AgentConnectionGate =
  | { kind: "ok" }
  | { kind: "warn"; serverNames: string[] }
  | { kind: "block"; serverNames: string[] };

/**
 * Turns one readiness row into what the UI should do about it. The backend only
 * reports agents whose author moved them off "allow", so a missing row — or a
 * row with nothing missing — is the ordinary, unrestricted case.
 */
export function resolveAgentConnectionGate(
  entry: AgentCredentialReadiness | undefined,
): AgentConnectionGate {
  if (!entry || entry.missingConnections.length === 0) return { kind: "ok" };

  const serverNames = entry.missingConnections.map(
    (connection) => connection.catalogName,
  );

  return entry.missingCredentialBehavior === "block"
    ? { kind: "block", serverNames }
    : { kind: "warn", serverNames };
}

/** "Notion", "Notion and Jira", "Notion, Jira and GitHub". */
export function listServerNames(serverNames: string[]): string {
  if (serverNames.length <= 1) return serverNames[0] ?? "";
  return `${serverNames.slice(0, -1).join(", ")} and ${serverNames.at(-1)}`;
}

/** Indexes a readiness response for per-agent lookup while rendering a list. */
export function indexReadinessByAgent(
  readiness: AgentCredentialReadiness[] | undefined,
): Map<string, AgentCredentialReadiness> {
  return new Map((readiness ?? []).map((entry) => [entry.agentId, entry]));
}
