"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { useProfile } from "@/lib/agent.query";
import { useCanManageGateway } from "@/lib/auth/use-can-manage-gateway";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { cn } from "@/lib/utils";

interface GatewayServersSummaryProps {
  gatewayId: string;
}

interface ServerRow {
  /** Catalog id when known — powers the icon and the "see its tools" link. */
  catalogId: string | null;
  name: string;
  icon: string | null;
  description: string | null;
  toolCount: number;
}

/**
 * "What do I actually get?" under the gateway review line: the MCP servers the
 * selected gateway exposes, each navigable to its catalog page (where all its
 * tools live). Which tools/servers a gateway exposes is a property of the
 * gateway, not something the connection command can subset — so this is a
 * read-only, navigable summary with a link to edit the gateway itself.
 *
 * The list is bounded (scrolls past a handful of servers) so a gateway with
 * dozens of servers never pushes the rest of the wizard off-screen.
 */
export function GatewayServersSummary({
  gatewayId,
}: GatewayServersSummaryProps) {
  const { data: gateway } = useProfile(gatewayId);
  const { data: catalog } = useInternalMcpCatalog();
  const { canManage } = useCanManageGateway(gateway);
  // Collapsed by default — the header summary ("N servers · M tools") is the
  // at-a-glance answer; the full list only unfolds when the user asks for it,
  // so it never pushes the rest of the wizard down unprompted.
  const [expanded, setExpanded] = useState(false);

  // "Access all tools" gateways grant every tool in the org dynamically, so the
  // profile's own tool list is empty. There is no endpoint for the resolved
  // set, so we enumerate the org's MCP catalog — the faithful list of "every
  // MCP server in your organization" — and label it as dynamic.
  const accessAll = gateway?.accessAllTools ?? false;

  const servers = useMemo<ServerRow[]>(() => {
    const catalogById = new Map((catalog ?? []).map((c) => [c.id, c]));

    if (accessAll) {
      return (catalog ?? [])
        .map((item) => ({
          catalogId: item.id,
          name: item.name,
          icon: item.icon,
          description: item.description,
          toolCount: item.toolCount,
        }))
        .sort((a, b) => b.toolCount - a.toolCount);
    }

    const tools = gateway?.tools ?? [];
    const counts = new Map<string | null, number>();
    for (const tool of tools) {
      counts.set(tool.catalogId, (counts.get(tool.catalogId) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([catalogId, toolCount]) => {
        const item = catalogId ? catalogById.get(catalogId) : undefined;
        return {
          catalogId,
          name: item?.name ?? deriveFallbackName(tools, catalogId),
          icon: item?.icon ?? null,
          description: item?.description ?? null,
          toolCount,
        };
      })
      .sort((a, b) => b.toolCount - a.toolCount);
  }, [accessAll, gateway?.tools, catalog]);

  // Loading (or gateway unreadable): the review line already names the gateway,
  // so render nothing rather than a skeleton for a detail row.
  if (!gateway) return null;

  const totalTools = accessAll
    ? servers.reduce((sum, s) => sum + s.toolCount, 0)
    : (gateway.tools?.length ?? 0);

  const editLink =
    canManage && gatewayId ? (
      // Just open the gateway's edit form (same tab, matching the page's other
      // links) — don't force-open the tool picker; the user curates from there.
      <Link
        href={`/mcp/gateways?edit=${encodeURIComponent(gatewayId)}`}
        className="text-muted-foreground/80 underline decoration-muted-foreground/30 underline-offset-2 hover:text-foreground"
      >
        Edit on gateway
      </Link>
    ) : null;

  // accessAll with an empty/loading catalog: keep the honest headline without a
  // list to expand.
  if (accessAll && servers.length === 0) {
    return (
      <p className="text-xs text-muted-foreground/80">
        Exposes every tool in your organization, including servers added later.{" "}
        {editLink}
      </p>
    );
  }

  if (servers.length === 0) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground/80">
        This gateway doesn't expose any MCP servers yet. {editLink}
      </p>
    );
  }

  return (
    <div className="text-xs" data-testid="connect-gateway-servers">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            className={cn(
              "size-3 transition-transform",
              !expanded && "-rotate-90",
            )}
          />
          {accessAll ? "All " : ""}
          {servers.length} MCP server{servers.length === 1 ? "" : "s"}
          {" · "}
          {totalTools} tool{totalTools === 1 ? "" : "s"}
        </button>
        {accessAll && (
          <span className="text-muted-foreground/70">
            in your organization — new servers included automatically
          </span>
        )}
        {editLink}
      </div>

      {expanded && (
        <ul className="mt-1.5 grid max-h-56 gap-0.5 overflow-y-auto pr-1">
          {servers.map((server) => (
            <ServerRowItem
              // Catalog-less tools all collapse into one null-catalogId group,
              // so there is only ever one such row; namespace its key anyway to
              // keep it out of the real-catalogId key space.
              key={server.catalogId ?? `catalogless-${server.name}`}
              server={server}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ===================================================================
// Internal pieces
// ===================================================================

/** One server line — links to its catalog page (where all its tools live). */
function ServerRowItem({ server }: { server: ServerRow }) {
  const inner = (
    <>
      <McpCatalogIcon
        icon={server.icon}
        catalogId={server.catalogId ?? undefined}
        size={16}
      />
      <span className="shrink-0 font-medium text-foreground">
        {server.name}
      </span>
      <span className="shrink-0 text-muted-foreground">
        {server.toolCount} tool{server.toolCount === 1 ? "" : "s"}
      </span>
      {server.description && (
        <span className="min-w-0 truncate text-muted-foreground/70">
          {server.description}
        </span>
      )}
    </>
  );

  // Catalog-less servers (tools with no catalog entry) have no detail page, so
  // render them as a plain, unlinked row.
  if (!server.catalogId) {
    return (
      <li className="flex items-center gap-2 rounded-md px-1.5 py-1">
        {inner}
      </li>
    );
  }

  return (
    <li>
      <Link
        href={`/mcp/registry/beta/${server.catalogId}`}
        className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/60"
      >
        {inner}
      </Link>
    </li>
  );
}

/** Tools without a catalog entry: derive a name from the tool-name prefix. */
function deriveFallbackName(
  tools: { name: string; catalogId: string | null }[],
  catalogId: string | null,
): string {
  const tool = tools.find((t) => t.catalogId === catalogId);
  const prefix = tool?.name.split("__")[0];
  if (!prefix) return "Unknown";
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}
