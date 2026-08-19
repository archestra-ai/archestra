"use client";

import { useMcpServerIssues } from "@/lib/mcp/use-mcp-server-issues";

/**
 * Sidebar count of MCP servers the viewer must act on (failed to start, not
 * running, needs re-authentication, reinstall, image approval), so problems
 * are visible from any page. Reads the same cached registry queries the
 * registry page uses; renders nothing while the fleet is clean.
 */
export function McpRegistryAttentionBadge() {
  const { summary } = useMcpServerIssues();
  const count = summary.actionableServerCount;
  if (count === 0) return null;
  return (
    <span
      className="ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 text-[11px] font-semibold tabular-nums text-destructive-foreground group-data-[collapsible=icon]:hidden"
      data-testid="sidebar-mcp-registry-attention-count"
    >
      {count}
      <span className="sr-only">
        {count === 1 ? " MCP server needs" : " MCP servers need"} attention
      </span>
    </span>
  );
}
