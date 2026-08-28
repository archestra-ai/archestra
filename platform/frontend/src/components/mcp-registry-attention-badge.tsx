"use client";

import Link from "next/link";
import { SidebarMenuAction } from "@/components/ui/sidebar";
import { useMcpDeploymentStatuses } from "@/lib/mcp/mcp-server.query";
import { useMcpServerIssues } from "@/lib/mcp/use-mcp-server-issues";

/**
 * Sidebar count of MCP servers the viewer must act on (failed to start, not
 * running, needs re-authentication), so problems are visible from any page. Reads the same cached registry queries the
 * registry page uses; renders nothing while the fleet is clean.
 *
 * The count links to the rows it is counting. The registry's default Action
 * required ordering also puts them first instead of hiding them behind
 * pagination. It renders as a `SidebarMenuAction` — a sibling of the nav
 * item's own link, not a child of it — because an anchor may not contain
 * another anchor.
 *
 * It reads the same live deployment feed the registry page does. Runtime
 * faults (a crash-looping pod, an image that will not pull) exist only for a
 * caller holding those statuses, so a badge without them said "0" one click
 * away from a list saying "Action required (3)". The subscription is already
 * open app-wide from `<McpDeploymentStatusFeed />`, so this costs nothing.
 */
export function McpRegistryAttentionBadge() {
  const { statuses } = useMcpDeploymentStatuses();
  const { facetCounts } = useMcpServerIssues(statuses);
  const count = facetCounts.you;
  if (count === 0) return null;
  return (
    <SidebarMenuAction
      asChild
      // `SidebarMenuAction` is shadcn's square icon-button slot, so it arrives
      // `rounded-md` and `aspect-square`. Neither suits a count: badges in this
      // design system are circles (`Badge`, the collapsed-rail warning count,
      // the registry filter count), and a square-aspect box grows *taller* as
      // the number gets wider, so a three-digit count outgrew the 20px row.
      // Fixing the height and rounding it fully gives a circle at one digit and
      // a pill beyond that, which is what every other count here does.
      className="aspect-auto h-5 w-auto min-w-5 rounded-full bg-destructive px-1 text-[11px] font-semibold tabular-nums text-destructive-foreground hover:bg-destructive hover:text-destructive-foreground"
    >
      <Link
        href="/mcp/registry?status=needs-my-action"
        data-testid="sidebar-mcp-registry-attention-count"
      >
        {count}
        <span className="sr-only">
          {count === 1 ? " MCP server needs" : " MCP servers need"} attention,
          show them
        </span>
      </Link>
    </SidebarMenuAction>
  );
}
