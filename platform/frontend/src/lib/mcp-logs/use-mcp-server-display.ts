"use client";

import { useMemo } from "react";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
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
 */
export function useMcpServerDisplayByName() {
  const serversQuery = useMcpServers({ includeAssignedAgents: false });
  const { data: canReadMcpRegistry } = useHasPermissions({
    mcpRegistry: ["read"],
  });
  const { data: catalogItems } = useInternalMcpCatalog({
    enabled: canReadMcpRegistry === true,
  });
  const servers = serversQuery.data;

  const displayByName = useMemo(() => {
    const catalogById = new Map(
      catalogItems?.map((item) => [item.id, item]) ?? [],
    );
    const map = new Map<string, McpServerDisplay>();
    for (const server of servers ?? []) {
      const catalog = catalogById.get(server.catalogId);
      map.set(server.name, {
        name: server.catalogName ?? catalog?.name ?? server.name,
        icon: catalog?.icon ?? null,
        catalogId: server.catalogId,
      });
    }
    return map;
  }, [catalogItems, servers]);

  return { servers, displayByName };
}
