import { facetIssues, type McpServerIssue } from "@/lib/mcp/mcp-server-issues";
import type { InstalledServer } from "./mcp-server-card";

export type McpIssueActionOwner = {
  label: string;
  fact: string;
  sentence: string;
};

/**
 * Name the actor only when the server response made that identity visible.
 * Otherwise state the role instead of leaking or inventing an owner.
 */
export function describeMcpIssueActionOwner({
  issue,
  servers,
}: {
  issue: McpServerIssue;
  servers: InstalledServer[];
}): McpIssueActionOwner {
  const server = issue.serverId
    ? servers.find((candidate) => candidate.id === issue.serverId)
    : null;

  if (server) {
    const visibleOwner = server.ownerEmail?.trim();
    if (visibleOwner) {
      return {
        label: visibleOwner,
        fact: `Owner: ${visibleOwner}`,
        sentence: `${visibleOwner} owns this connection. An MCP installation admin can also act.`,
      };
    }
    return {
      label: "other user",
      fact: "Owner: other user",
      sentence:
        "Another user owns this connection. An MCP installation admin can also act.",
    };
  }

  // No serverId: a multi-tenant pod failure is catalog-scope, so no single
  // connection owns it.
  return {
    label: "MCP installation admin",
    fact: "Action by: MCP installation admin",
    sentence: "An MCP installation admin can resolve this issue.",
  };
}

/** Summarize every actor represented by one grouped table row or issue kind. */
export function describeMcpIssueActionOwners({
  issues,
  servers,
}: {
  issues: McpServerIssue[];
  servers: InstalledServer[];
}): McpIssueActionOwner {
  const owners = issues.map((issue) =>
    describeMcpIssueActionOwner({ issue, servers }),
  );
  const uniqueLabels = new Set(owners.map((owner) => owner.label));
  if (uniqueLabels.size <= 1 && owners[0]) return owners[0];
  return {
    label: "Multiple actors",
    fact: "Action by: multiple people or roles",
    sentence: "Multiple people or roles need to act.",
  };
}

/**
 * The facet names one owner only when every row points to the same visible
 * identity. Mixed or hidden actors stay truthful without exposing identity.
 */
export function waitingActionFacetLabel({
  issuesByCatalog,
  servers,
}: {
  issuesByCatalog: Map<string, McpServerIssue[]>;
  servers: InstalledServer[];
}): string {
  const owners: string[] = [];
  for (const issues of issuesByCatalog.values()) {
    for (const issue of facetIssues(issues, "others")) {
      const server = issue.serverId
        ? servers.find((candidate) => candidate.id === issue.serverId)
        : null;
      const owner = server?.ownerEmail?.trim();
      if (!owner) return WAITING_OTHER_USER_LABEL;
      owners.push(owner);
    }
  }
  const uniqueOwners = new Set(owners);
  return uniqueOwners.size === 1
    ? `Waiting action by ${owners[0]}`
    : WAITING_OTHER_USER_LABEL;
}

const WAITING_OTHER_USER_LABEL = "Waiting action by other user";
