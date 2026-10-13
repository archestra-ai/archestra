"use client";

import { useMemo } from "react";
import { useProfile } from "@/lib/agent.query";
import {
  groupCatalogTools,
  useAllCatalogTools,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";

/** One MCP server a gateway exposes, most tools first. */
export interface GatewayServer {
  key: string;
  catalogId: string | null;
  /** The catalog entry's name; null when the tools have no catalog entry. */
  catalogName: string | null;
  icon: string | null;
  description: string | null;
  toolCount: number;
  /** Tool names (prefix stripped); filled only with `withTools`. */
  tools: { name: string; description: string | null }[];
}

/**
 * The MCP servers a gateway exposes. An "access all tools" gateway has no
 * tool list of its own, so every server in the org's catalog counts.
 */
export function useGatewayServers(
  gatewayId: string | undefined,
  params?: { withTools?: boolean },
) {
  const profileQuery = useProfile(gatewayId);
  const gateway = profileQuery.data;
  const { data: catalog } = useInternalMcpCatalog();
  const accessAll = gateway?.accessAllTools ?? false;
  const withTools = params?.withTools ?? false;
  const { data: catalogTools } = useAllCatalogTools({
    enabled: accessAll && withTools,
  });

  const servers = useMemo<GatewayServer[]>(() => {
    const byId = new Map((catalog ?? []).map((c) => [c.id, c]));
    if (accessAll) {
      const toolsByCatalog = withTools
        ? groupCatalogTools(catalogTools)
        : new Map();
      return (catalog ?? [])
        .map((c) => ({
          key: c.id,
          catalogId: c.id,
          catalogName: c.name,
          icon: c.icon,
          description: c.description,
          toolCount: c.toolCount,
          tools: (toolsByCatalog.get(c.id) ?? []).map(
            (t: { name: string }) => ({
              name: shortToolName(t.name),
              description: null,
            }),
          ),
        }))
        .sort((a, b) => b.toolCount - a.toolCount);
    }
    const groups = new Map<string | null, GatewayServer["tools"]>();
    for (const t of gateway?.tools ?? []) {
      const list = groups.get(t.catalogId) ?? [];
      list.push({ name: shortToolName(t.name), description: t.description });
      groups.set(t.catalogId, list);
    }
    return [...groups.entries()]
      .map(([catalogId, tools]) => {
        const item = catalogId ? byId.get(catalogId) : undefined;
        return {
          key: catalogId ?? "other",
          catalogId,
          catalogName: item?.name ?? null,
          icon: item?.icon ?? null,
          description: item?.description ?? null,
          toolCount: tools.length,
          tools: withTools ? tools : [],
        };
      })
      .sort((a, b) => b.toolCount - a.toolCount);
  }, [accessAll, gateway?.tools, catalog, catalogTools, withTools]);

  return { gateway, profileQuery, accessAll, servers };
}

function shortToolName(name: string) {
  const i = name.indexOf("__");
  return i === -1 ? name : name.slice(i + 2);
}
