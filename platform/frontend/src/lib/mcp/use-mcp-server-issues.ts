"use client";

import type { McpDeploymentStatusEntry } from "@archestra/shared";
import { useMemo } from "react";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import {
  attentionCatalogIds,
  computeMcpServerIssues,
  type McpServerIssue,
} from "@/lib/mcp/mcp-server-issues";
import { useCanReauthenticate } from "@/lib/mcp/use-can-reauthenticate";

/**
 * How many catalog items sit in each facet. All three come out of
 * `attentionCatalogIds`, which is the point: the sidebar badge and the list's
 * own facet buttons are the same number computed once.
 */
export interface McpServerFacetCounts {
  /** Items the viewer can fix themselves. */
  you: number;
  /** Items owned by another visible actor or a role the viewer lacks. */
  others: number;
  /** Items the viewer has silenced; absent from both counts above. */
  muted: number;
}

/**
 * Issues across every MCP server the viewer can see, scoped to what they can
 * act on. Reads the same catalog + installed-server queries the registry page
 * uses (cached, so it costs nothing extra there).
 *
 * `deploymentStatuses` is required rather than defaulted: runtime faults
 * (Failed to start, Not running) are classified from the live feed, so a
 * caller that left it out counted a different fleet from the one next to it
 * on screen. Every caller takes it from `useMcpDeploymentStatuses`, whose
 * subscription `<McpDeploymentStatusFeed />` already holds open app-wide.
 */
export function useMcpServerIssues(
  deploymentStatuses: Record<string, McpDeploymentStatusEntry>,
): {
  issuesByCatalog: Map<string, McpServerIssue[]>;
  facetCounts: McpServerFacetCounts;
} {
  const { data: catalogItems } = useInternalMcpCatalog();
  const alertingEnabled = useFeature("mcpServerAlertingEnabled") === true;
  const { data: servers } = useMcpServers();
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;
  const canReauthenticate = useCanReauthenticate();
  const { data: canManageInstalls } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });

  const issuesByCatalog = useMemo(
    () =>
      alertingEnabled
        ? computeMcpServerIssues({
            items: catalogItems ?? [],
            servers: servers ?? [],
            deploymentStatuses,
            viewer: {
              userId,
              canReauthenticate,
              canManageInstalls: !!canManageInstalls,
            },
          })
        : new Map(),
    [
      catalogItems,
      servers,
      deploymentStatuses,
      userId,
      canReauthenticate,
      canManageInstalls,
      alertingEnabled,
    ],
  );
  const facetCounts = useMemo(
    () => ({
      you: attentionCatalogIds(issuesByCatalog, { audience: "you" }).length,
      others: attentionCatalogIds(issuesByCatalog, { audience: "others" })
        .length,
      muted: attentionCatalogIds(issuesByCatalog, { audience: "muted" }).length,
    }),
    [issuesByCatalog],
  );
  return { issuesByCatalog, facetCounts };
}
