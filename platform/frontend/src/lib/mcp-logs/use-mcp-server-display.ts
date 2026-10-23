"use client";

import {
  ARCHESTRA_MCP_CATALOG_ID,
  ARCHESTRA_MCP_SERVER_NAME,
} from "@archestra/shared";
import { useMemo } from "react";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useMcpRegistryIssueIndex } from "@/lib/mcp/mcp-registry.query";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";

export type McpServerDisplay = {
  name: string;
  icon: string | null;
  catalogId: string;
};

/**
 * Tool-call rows store the installed server's deployment name. This joins it
 * to the catalog metadata the registry already uses, so a log can show the
 * human-readable name and its icon without changing the logs API.
 *
 * The join reads the registry's issue index, which every page already loads
 * for the sidebar count, so the logs pages add no request for it. The full
 * install list (owner, team, status) is loaded only when a caller asks for
 * `installations`: the MCP logs filter needs it once it opens, nothing else
 * on the logs pages does.
 */
export function useMcpServerDisplayByName(options?: {
  installations?: boolean;
}) {
  const installationsQuery = useMcpServers({
    includeAssignedAgents: false,
    enabled: options?.installations === true,
  });
  const { data: canReadMcpRegistry } = useHasPermissions({
    mcpRegistry: ["read"],
  });
  const { data: issueIndex } = useMcpRegistryIssueIndex({
    enabled: canReadMcpRegistry === true,
  });

  const displayByName = useMemo(() => {
    const catalogById = new Map(
      issueIndex?.catalogItems.map((item) => [item.id, item]) ?? [],
    );
    const map = new Map<string, McpServerDisplay>();
    for (const server of issueIndex?.servers ?? []) {
      const catalog = catalogById.get(server.catalogId);
      map.set(server.name, {
        name: catalog?.name ?? server.name,
        icon: catalog?.iconUrl ?? catalog?.icon ?? null,
        catalogId: server.catalogId,
      });
    }
    // The built-in server has no installed row; point its calls at its
    // catalog entry so they show the platform's own logo.
    if (!map.has(ARCHESTRA_MCP_SERVER_NAME)) {
      const builtIn = catalogById.get(ARCHESTRA_MCP_CATALOG_ID);
      map.set(ARCHESTRA_MCP_SERVER_NAME, {
        name: builtIn?.name ?? ARCHESTRA_MCP_SERVER_NAME,
        icon: builtIn?.iconUrl ?? builtIn?.icon ?? null,
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
      });
    }
    return map;
  }, [issueIndex]);

  return { servers: installationsQuery.data, displayByName };
}
