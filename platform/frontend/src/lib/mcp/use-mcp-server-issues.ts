"use client";

import type { McpDeploymentStatusEntry } from "@archestra/shared";
import { useMemo } from "react";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import {
  computeMcpServerIssues,
  type McpServerIssue,
  type McpServerIssueSummary,
  summarizeMcpServerIssues,
} from "@/lib/mcp/mcp-server-issues";
import { useCanReauthenticate } from "@/lib/mcp/use-can-reauthenticate";

const NO_STATUSES: Record<string, McpDeploymentStatusEntry> = {};

/**
 * Issues across every MCP server the viewer can see, scoped to what they can
 * act on. Reads the same catalog + installed-server queries the registry page
 * uses (cached, so it costs nothing extra there). Pass the live deployment
 * statuses when the caller subscribes to them (the registry page); without
 * them, runtime states (Not running, Starting) are simply not known.
 */
export function useMcpServerIssues(
  deploymentStatuses: Record<string, McpDeploymentStatusEntry> = NO_STATUSES,
): {
  issuesByCatalog: Map<string, McpServerIssue[]>;
  summary: McpServerIssueSummary;
} {
  const { data: catalogItems } = useInternalMcpCatalog();
  const { data: servers } = useMcpServers();
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;
  const canReauthenticate = useCanReauthenticate();
  const { data: canManageInstalls } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const { data: canEditCatalog } = useHasPermissions({
    mcpRegistry: ["update"],
  });

  const issuesByCatalog = useMemo(
    () =>
      computeMcpServerIssues({
        items: catalogItems ?? [],
        servers: servers ?? [],
        deploymentStatuses,
        viewer: {
          userId,
          canReauthenticate,
          canManageInstalls: !!canManageInstalls,
          canEditCatalog: !!canEditCatalog,
        },
      }),
    [
      catalogItems,
      servers,
      deploymentStatuses,
      userId,
      canReauthenticate,
      canManageInstalls,
      canEditCatalog,
    ],
  );
  const summary = useMemo(
    () => summarizeMcpServerIssues(issuesByCatalog),
    [issuesByCatalog],
  );
  return { issuesByCatalog, summary };
}
