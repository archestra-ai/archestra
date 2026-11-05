import type { McpServerIssue } from "@/lib/mcp/mcp-server-issues";
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
