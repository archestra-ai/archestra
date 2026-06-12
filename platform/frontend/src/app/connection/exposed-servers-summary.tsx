"use client";

import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { useProfile } from "@/lib/agent.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { cn } from "@/lib/utils";

interface ExposedServersSummaryProps {
  gatewayId?: string;
  canManage?: boolean;
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
  canManage = false,
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
  const leftFadeRef = useRef<HTMLDivElement | null>(null);
  const rightFadeRef = useRef<HTMLDivElement | null>(null);
  const leftBtnRef = useRef<HTMLButtonElement | null>(null);
  const rightBtnRef = useRef<HTMLButtonElement | null>(null);

  // Use refs + direct DOM mutation so scroll events don't trigger React renders.
  const recalcEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    const toggle = (node: HTMLElement | null, on: boolean) => {
      if (!node) return;
      node.classList.toggle("opacity-0", !on);
      node.classList.toggle("pointer-events-none", !on);
    };
    toggle(leftFadeRef.current, left);
    toggle(rightFadeRef.current, right);
    toggle(leftBtnRef.current, left);
    toggle(rightBtnRef.current, right);
  }, []);

  useLayoutEffect(() => {
    recalcEdges();
  }, [recalcEdges]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => recalcEdges();
    const onResize = () => recalcEdges();
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [recalcEdges]);

  // Trigger an edge recalc once the server list changes (DOM width shifts).
  useLayoutEffect(() => {
    recalcEdges();
  }, [recalcEdges]);

  const scrollByDir = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };

  // Mouse-wheel: convert vertical wheel to horizontal scroll on the rail.
  const onWheel = useCallback((e: WheelEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    if (e.deltaY === 0 || e.shiftKey) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    el.scrollLeft += e.deltaY;
    e.preventDefault();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // Click-drag panning.
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startScroll: number;
    moved: boolean;
  } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Don't hijack drags that originate on a pill/link — let clicks through.
    if (target.closest("a,button")) return;
    const el = scrollRef.current;
    if (!el) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startScroll: el.scrollLeft,
      moved: false,
    };
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const el = scrollRef.current;
    if (!drag || !el || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    if (Math.abs(dx) > 3) drag.moved = true;
    el.scrollLeft = drag.startScroll - dx;
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const el = scrollRef.current;
    if (!drag || !el || drag.pointerId !== e.pointerId) return;
    if (el.hasPointerCapture(e.pointerId))
      el.releasePointerCapture(e.pointerId);
    dragRef.current = null;
  };

  // Arrow keys move focus between pills when the rail has focus.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const el = scrollRef.current;
    if (!el) return;
    const focusables = Array.from(
      el.querySelectorAll<HTMLElement>('[data-pill="true"]'),
    );
    if (focusables.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? focusables.indexOf(active) : -1;
    const next =
      e.key === "ArrowRight"
        ? Math.min(focusables.length - 1, idx + 1)
        : Math.max(0, idx - 1);
    if (next !== idx && focusables[next]) {
      focusables[next].focus();
      focusables[next].scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
      e.preventDefault();
    }
  };

  if (!gateway) {
    return (
      <div
        className={cn("flex items-center gap-3 overflow-hidden", className)}
        aria-hidden
      >
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

  const addPill =
    gatewayId && canManage ? (
      <Link
        href={`/mcp/gateways?edit=${encodeURIComponent(gatewayId)}&openTools=true`}
        data-pill="true"
        className="inline-flex shrink-0 items-center gap-2 rounded-full border border-dashed border-primary/40 bg-primary/[0.04] py-1 pl-1.5 pr-4 text-[13.5px] font-medium text-primary transition-colors hover:border-primary/60 hover:bg-primary/[0.08]"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <Plus className="size-3.5" strokeWidth={2.4} />
        </span>
        <span>Add MCP server</span>
      </Link>
    ) : null;

  const askAdminPill =
    gatewayId && !canManage ? (
      <div
        className="inline-flex shrink-0 items-center gap-2 rounded-full border border-dashed border-muted-foreground/30 bg-muted/40 px-4 py-1 text-[13.5px] font-medium italic text-muted-foreground/80"
        title="You don't have permission to add MCP servers to this gateway"
      >
        <span className="flex h-7 items-center">
          Ask your admin to add more MCPs
        </span>
      </div>
    ) : null;

  return (
    <div className={cn("relative flex items-center gap-3", className)}>
      {addPill}

      <div className="relative min-w-0 flex-1">
        {/** biome-ignore lint/a11y/useSemanticElements: a fieldset would inject a visible legend; this is a pure visual rail */}
        <div
          ref={scrollRef}
          role="group"
          aria-label="Connected MCP servers"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
          className="flex select-none items-center gap-3 overflow-x-auto scroll-smooth py-2 pl-0.5 pr-11 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {servers.length === 0
            ? null
            : servers.map((server) => (
                <button
                  key={server.catalogId ?? server.name}
                  type="button"
                  data-pill="true"
                  title={`${server.name} — ${server.toolCount} ${
                    server.toolCount === 1 ? "tool" : "tools"
                  }`}
                  className="inline-flex shrink-0 !cursor-default items-center gap-2 rounded-full bg-background py-1 pl-1.5 pr-4 text-[13.5px] font-medium text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.04),0_1px_3px_rgba(15,23,42,0.06)] outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full">
                    <McpCatalogIcon
                      icon={server.icon}
                      catalogId={server.catalogId ?? undefined}
                      size={18}
                    />
                  </span>
                  <span className="truncate">{server.name}</span>
                </button>
              ))}
          {askAdminPill}
        </div>

        <div
          ref={leftFadeRef}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-background to-transparent opacity-0 transition-opacity"
        />
        <div
          ref={rightFadeRef}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-background to-transparent opacity-0 transition-opacity"
        />

        <button
          ref={leftBtnRef}
          type="button"
          aria-label="Scroll pills left"
          onClick={() => scrollByDir(-1)}
          className="pointer-events-none absolute left-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-background text-muted-foreground opacity-0 shadow-sm ring-1 ring-black/[0.04] transition-opacity hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          ref={rightBtnRef}
          type="button"
          aria-label="Scroll pills right"
          onClick={() => scrollByDir(1)}
          className="pointer-events-none absolute right-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-background text-muted-foreground opacity-0 shadow-sm ring-1 ring-black/[0.04] transition-opacity hover:text-foreground"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
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
