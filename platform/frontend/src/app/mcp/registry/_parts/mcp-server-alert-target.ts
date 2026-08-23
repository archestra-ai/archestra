import type { DismissibleMcpAlert } from "@/lib/mcp/mcp-server.query";
import type { McpServerIssue } from "@/lib/mcp/mcp-server-issues";
import type { CatalogItem, InstalledServer } from "./mcp-server-card";

export function mcpServerAlertTarget({
  issue,
  item,
  servers,
}: {
  issue: McpServerIssue;
  item: CatalogItem | undefined;
  servers: InstalledServer[];
}): DismissibleMcpAlert {
  const server = issue.serverId
    ? servers.find((candidate) => candidate.id === issue.serverId)
    : null;
  return {
    catalogId: issue.catalogId,
    catalogName: item?.name ?? "MCP server",
    serverId: issue.serverId ?? null,
    serverName: server?.name,
    kind: issue.kind,
    issueFingerprint: issue.fingerprint,
  };
}

export function mcpServerAlertTargetKey(target: DismissibleMcpAlert): string {
  return `${target.catalogId}:${target.serverId ?? "catalog"}:${target.kind}:${target.issueFingerprint}`;
}
