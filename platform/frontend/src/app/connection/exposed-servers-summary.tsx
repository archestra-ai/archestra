"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { useProfile } from "@/lib/agent.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { cn } from "@/lib/utils";

interface ExposedServersSummaryProps {
  gatewayId?: string;
  className?: string;
}

interface ExposedServer {
  catalogId: string | null;
  name: string;
  icon: string | null;
  toolCount: number;
}

export function ExposedServersSummary({
  gatewayId,
  className,
}: ExposedServersSummaryProps) {
  const { data: gateway } = useProfile(gatewayId);
  const { data: catalog } = useInternalMcpCatalog();

  const servers = useMemo<ExposedServer[]>(() => {
    const tools = gateway?.tools ?? [];
    const counts = new Map<string | null, number>();
    for (const tool of tools) {
      counts.set(tool.catalogId, (counts.get(tool.catalogId) ?? 0) + 1);
    }
    const catalogById = new Map((catalog ?? []).map((c) => [c.id, c]));
    return [...counts.entries()]
      .map(([catalogId, toolCount]) => {
        const item = catalogId ? catalogById.get(catalogId) : undefined;
        return {
          catalogId,
          name: item?.name ?? deriveFallbackName(tools, catalogId),
          icon: item?.icon ?? null,
          toolCount,
        };
      })
      .sort((a, b) => b.toolCount - a.toolCount);
  }, [gateway?.tools, catalog]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const [activePage, setActivePage] = useState(0);

  const recalcPages = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pages = Math.max(
      1,
      Math.round(el.scrollWidth / Math.max(el.clientWidth, 1)),
    );
    setPageCount(pages);
    const idx = Math.round(el.scrollLeft / Math.max(el.clientWidth, 1));
    setActivePage(Math.min(pages - 1, Math.max(0, idx)));
  }, []);

  useLayoutEffect(() => {
    recalcPages();
  }, [recalcPages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const idx = Math.round(el.scrollLeft / Math.max(el.clientWidth, 1));
      setActivePage(Math.min(pageCount - 1, Math.max(0, idx)));
    };
    const onResize = () => recalcPages();
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [pageCount, recalcPages]);

  if (!gateway) {
    return (
      <div className={cn("flex items-center gap-3", className)} aria-hidden>
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            key={i}
            className="h-10 w-32 animate-pulse rounded-full bg-muted/70"
          />
        ))}
      </div>
    );
  }

  if (servers.length === 0) return null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div
        ref={scrollRef}
        className="flex items-center gap-3 overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {servers.map((server) => (
          <div
            key={server.catalogId ?? server.name}
            title={`${server.name} — ${server.toolCount} ${
              server.toolCount === 1 ? "tool" : "tools"
            }`}
            className="inline-flex shrink-0 items-center gap-2.5 rounded-full border border-border/70 bg-background py-1.5 pl-2 pr-4 text-[14px] font-medium text-foreground"
          >
            <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/60">
              <McpCatalogIcon
                icon={server.icon}
                catalogId={server.catalogId ?? undefined}
                size={20}
              />
            </span>
            <span className="truncate">{server.name}</span>
          </div>
        ))}
      </div>

      {pageCount > 1 && (
        <div className="flex items-center gap-1.5">
          {Array.from({ length: pageCount }).map((_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-order pagination dots
              key={i}
              className={cn(
                "h-1.5 rounded-full transition-all",
                i === activePage ? "w-4 bg-purple-500" : "w-1.5 bg-border",
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function deriveFallbackName(
  tools: { name: string; catalogId: string | null }[] | undefined,
  catalogId: string | null,
): string {
  if (!tools) return "Unknown";
  const tool = tools.find((t) => t.catalogId === catalogId);
  if (!tool) return "Unknown";
  const prefix = tool.name.split("__")[0];
  if (!prefix) return "Unknown";
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}
