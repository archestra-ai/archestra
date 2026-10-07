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
  /**
   * The catalog entry's name, else one made from its tools' `<server>__`
   * prefix; null when neither is known.
   */
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
  // Apps are catalog entries too; without them an app's tools have no name.
  // The backend leaves them out for callers who can't read apps.
  const { data: catalog } = useInternalMcpCatalog({ includeApps: true });
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
      // An "access all tools" gateway covers the MCP registry, not apps.
      return (catalog ?? [])
        .filter((c) => c.serverType !== "app")
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
          catalogName: item?.name ?? nameFromPrefix(gateway?.tools, catalogId),
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

/** "linear__create_ticket" names its server "Linear". */
function nameFromPrefix(
  tools: { name: string; catalogId: string | null }[] | undefined,
  catalogId: string | null,
): string | null {
  const tool = tools?.find((t) => t.catalogId === catalogId);
  const i = tool?.name.indexOf("__") ?? -1;
  if (!tool || i <= 0) return null;
  return tool.name.charAt(0).toUpperCase() + tool.name.slice(1, i);
}

function shortToolName(name: string) {
  const i = name.indexOf("__");
  return i === -1 ? name : name.slice(i + 2);
}
