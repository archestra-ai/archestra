"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  ArrowLeft,
  Bot,
  Building2,
  ChevronLeft,
  ChevronRight,
  Ghost,
  Search,
  Users,
} from "lucide-react";
import Link from "next/link";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentIcon } from "@/components/agent-icon";
import {
  agentDetailHref,
  agentPageKindForType,
} from "@/components/agent-pages/agent-page-config";
import { QueryLoadError } from "@/components/query-load-error";
import { scopeLabel } from "@/components/scope-vocabulary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type AgentOwner, describeAgentOwner } from "@/lib/agent-owner-label";
import { useSession } from "@/lib/auth/auth.query";
import {
  useMcpAutoAgents,
  useMcpUsageSummary,
} from "@/lib/mcp/mcp-agent-usage.query";
import { cn } from "@/lib/utils/tailwind";
import { type AgentUsage, deriveAgentUsage } from "./mcp-server-agent-usage";

type McpServerFromApi = archestraApiTypes.GetMcpServersResponses["200"][number];

/**
 * Read-only view of everything that can reach this MCP server. Deliberately
 * not editable: access is granted from the agent side (tool assignment or
 * auto mode), so this is the inverse index of that.
 *
 * The agents that picked this server's tools are the interesting ones, so
 * they ride in a strip of cards at the top. Everything with All tools reaches
 * every server alike, and is a quiet paged list below; "View all" swaps that
 * list to the picked set when the strip overflows.
 */
export function McpServerPagedUsageTab({
  catalogId,
  serversForCatalog,
}: {
  catalogId: string;
  serversForCatalog: Array<Pick<McpServerFromApi, "assignedAgents">>;
}) {
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"all" | "picked">("all");
  // Cursor boundaries of the All-tools pages: the last agent of each page
  // already seen. The picked view pages locally.
  const [boundaries, setBoundaries] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const [pickedPage, setPickedPage] = useState(0);
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const assignedAll = useMemo(
    () =>
      deriveAgentUsage({ serversForCatalog, autoModeAgents: undefined })
        .assigned,
    [serversForCatalog],
  );
  const picked = useMemo(() => {
    const term = search.trim().toLowerCase();
    return assignedAll
      .filter(
        (agent) =>
          !term ||
          agent.name.toLowerCase().includes(term) ||
          (agent.ownerEmail ?? "").toLowerCase().includes(term),
      )
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
  }, [assignedAll, search]);
  const pickedIds = useMemo(
    () => new Set(assignedAll.map((agent) => agent.id)),
    [assignedAll],
  );

  const summary = useMcpUsageSummary({
    catalogId,
    assignedAgents: picked,
    search,
    previews: false,
  });
  const autoCount = summary.data?.autoCount ?? 0;
  const automatic = useMcpAutoAgents({
    catalogId,
    limit: PAGE_SIZE,
    afterAgentId: boundaries[boundaries.length - 1],
    search,
    sortDirection: "asc",
    enabled: view === "all" && summary.isSuccess && autoCount > 0,
  });
  const total = summary.data?.pagination.total ?? picked.length + autoCount;

  const resetPaging = () => {
    setBoundaries([undefined]);
    setPickedPage(0);
  };
  const switchView = (next: "all" | "picked") => {
    setView(next);
    resetPaging();
  };

  if (summary.isError || (view === "all" && automatic.isError)) {
    return (
      <QueryLoadError
        title="Could not load agent usage"
        onRetry={() => {
          summary.refetch();
          automatic.refetch();
        }}
      />
    );
  }

  if (summary.isSuccess && !search && total === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-12 text-center">
        <Bot className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium">
          No agents or MCP gateways use this server yet
        </p>
        <p className="max-w-md text-sm text-muted-foreground">
          Agents and MCP gateways reach a server when their tool access is All,
          or Manual with some of this server's tools picked.
        </p>
      </div>
    );
  }

  // The list below: All-tools agents from the server cursor, or the picked
  // set paged locally after "View all".
  const pageIndex =
    view === "picked"
      ? Math.min(
          pickedPage,
          Math.max(0, Math.ceil(picked.length / PAGE_SIZE) - 1),
        )
      : boundaries.length - 1;
  const rows: UsageRow[] =
    view === "picked"
      ? picked.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE)
      : autoCount === 0
        ? []
        : (automatic.data?.data ?? []).filter(
            (agent) => !pickedIds.has(agent.id),
          );
  const listTotal = view === "picked" ? picked.length : autoCount;
  const hasNext =
    view === "picked"
      ? (pageIndex + 1) * PAGE_SIZE < picked.length
      : !!automatic.data?.pagination.hasNext;
  const listLoading =
    summary.isPending ||
    (view === "all" && autoCount > 0 && automatic.isPending);
  const from = rows.length === 0 ? 0 : pageIndex * PAGE_SIZE + 1;
  const to = pageIndex * PAGE_SIZE + rows.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-6">
        <p className="min-w-0 truncate text-sm text-muted-foreground">
          <span className="text-base font-semibold tabular-nums text-foreground">
            {formatCount(total)}
          </span>{" "}
          {total === 1 ? "agent or MCP gateway" : "agents and MCP gateways"} can
          reach this server
        </p>
        <div className="relative w-64 shrink-0">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              resetPaging();
            }}
            placeholder="Filter by name or owner"
            aria-label="Filter by name or owner"
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>

      {view === "all" && picked.length > 0 && (
        <PickedStrip
          agents={picked}
          total={assignedAll.length}
          searching={!!search.trim()}
          currentUserId={currentUserId}
          onViewAll={() => switchView("picked")}
        />
      )}

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex h-9 items-center gap-2 border-b bg-muted/40 px-4 text-xs">
          {view === "picked" ? (
            <>
              <Button
                variant="ghost"
                size="xs"
                className="-ml-2 h-6 text-muted-foreground"
                onClick={() => switchView("all")}
              >
                <ArrowLeft className="size-3.5" />
                All
              </Button>
              <span className="text-muted-foreground/50">/</span>
              <span className="font-medium text-foreground">
                Picked tools from this server
              </span>
            </>
          ) : (
            <span className="font-medium text-foreground">All tools</span>
          )}
          <span className="text-muted-foreground">·</span>
          <span className="tabular-nums text-muted-foreground">
            {formatCount(listTotal)}
          </span>
          <span className="ml-auto truncate text-muted-foreground/70">
            {view === "picked"
              ? "Manual tool access"
              : "Auto mode reaches every server"}
          </span>
        </div>

        {listLoading ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            Loading agent usage…
          </p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {search.trim()
              ? view === "all" && picked.length > 0
                ? `Only the picked ones above match “${search.trim()}”.`
                : `Nothing matches “${search.trim()}”.`
              : "No agents or MCP gateways with All tools."}
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {rows.map((agent) => (
              <li key={agent.id}>
                <UsageLine agent={agent} currentUserId={currentUserId} />
              </li>
            ))}
          </ul>
        )}

        {rows.length > 0 && (
          <div className="flex h-11 items-center justify-between border-t px-4 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {formatCount(from)}–{formatCount(to)} of {formatCount(listTotal)}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Go to previous page"
                disabled={pageIndex === 0}
                onClick={() =>
                  view === "picked"
                    ? setPickedPage(pageIndex - 1)
                    : setBoundaries((current) => current.slice(0, -1))
                }
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Go to next page"
                disabled={!hasNext}
                onClick={() =>
                  view === "picked"
                    ? setPickedPage(pageIndex + 1)
                    : setBoundaries((current) => [
                        ...current,
                        automatic.data?.data.at(-1)?.id,
                      ])
                }
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ===

/** The fields a row needs; picked and All-tools agents both carry them. */
type UsageRow = Pick<
  AgentUsage,
  "id" | "name" | "agentType" | "scope" | "ownerId" | "ownerEmail"
>;

const PAGE_SIZE = 20;
/** Width of the edge fade that tells the strip scrolls. */
const FADE_PX = 56;

const countFormat = new Intl.NumberFormat("en-US");
function formatCount(value: number) {
  return countFormat.format(value);
}

function PickedStrip({
  agents,
  total,
  searching,
  currentUserId,
  onViewAll,
}: {
  agents: UsageRow[];
  total: number;
  searching: boolean;
  currentUserId: string | undefined;
  onViewAll: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const { atStart, atEnd, update } = useScrollEdges(scroller, agents.length);
  const overflowing = !(atStart && atEnd);

  const nudge = (direction: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({
      left: direction * el.clientWidth * 0.8,
      behavior: "smooth",
    });
  };

  const mask = overflowing
    ? `linear-gradient(to right, ${atStart ? "#000" : "transparent"}, #000 ${FADE_PX}px, #000 calc(100% - ${FADE_PX}px), ${atEnd ? "#000" : "transparent"})`
    : undefined;

  return (
    <section className="space-y-2.5">
      <div className="flex h-7 items-center gap-2 text-sm">
        <h3 className="font-medium">Picked tools from this server</h3>
        <span className="tabular-nums text-muted-foreground">
          {searching
            ? `${formatCount(agents.length)} of ${formatCount(total)}`
            : formatCount(total)}
        </span>
        {overflowing && (
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Scroll left"
              disabled={atStart}
              onClick={() => nudge(-1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Scroll right"
              disabled={atEnd}
              onClick={() => nudge(1)}
            >
              <ChevronRight className="size-4" />
            </Button>
            <span className="mx-1.5 h-4 w-px bg-border" />
            <Button
              variant="link"
              size="xs"
              className="px-0 text-muted-foreground hover:text-foreground"
              onClick={onViewAll}
            >
              View all {formatCount(agents.length)}
            </Button>
          </div>
        )}
      </div>
      <div
        ref={scroller}
        onScroll={update}
        className="grid gap-2 overflow-x-auto"
        style={{
          // Four cards fill the row; past four, a slim peek of the fifth says
          // there is more to scroll.
          gridAutoFlow: "column",
          scrollSnapType: "x mandatory",
          scrollbarWidth: "none",
          gridAutoColumns:
            agents.length > 4
              ? "calc((100% - 2rem) / 4.35)"
              : "calc((100% - 1.5rem) / 4)",
          maskImage: mask,
          WebkitMaskImage: mask,
        }}
      >
        {agents.map((agent) => (
          <PickedCard
            key={agent.id}
            agent={agent}
            currentUserId={currentUserId}
          />
        ))}
      </div>
    </section>
  );
}

function PickedCard({
  agent,
  currentUserId,
}: {
  agent: UsageRow;
  currentUserId: string | undefined;
}) {
  const owner = describeAgentOwner(agent, currentUserId);
  return (
    <div
      className="relative flex h-14 min-w-0 items-center gap-3 rounded-lg border bg-card px-3 transition-colors hover:border-foreground/25 hover:bg-muted/30"
      style={{ scrollSnapAlign: "start" }}
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <AgentIcon
          // Legacy profiles render as gateways, matching their routes.
          fallbackType={
            agent.agentType === "profile" ? "mcp_gateway" : agent.agentType
          }
          size={16}
        />
      </div>
      <div className="min-w-0">
        {/* The whole card is the link's hit area. */}
        <Link
          href={agentDetailHref(
            agentPageKindForType(agent.agentType),
            agent.id,
          )}
          title={agent.name}
          className="block truncate text-sm font-medium decoration-muted-foreground/50 underline-offset-4 after:absolute after:inset-0 hover:underline"
        >
          {agent.name}
        </Link>
        <OwnerText
          owner={owner}
          className="block truncate text-xs text-muted-foreground"
        />
      </div>
    </div>
  );
}

function UsageLine({
  agent,
  currentUserId,
}: {
  agent: UsageRow;
  currentUserId: string | undefined;
}) {
  const owner = describeAgentOwner(agent, currentUserId);
  return (
    <div className="flex h-11 items-center gap-3 px-4 transition-colors hover:bg-muted/30">
      <OwnerAvatar owner={owner} />
      <div className="flex min-w-0 flex-1 items-baseline gap-2 text-sm">
        <Link
          href={agentDetailHref(
            agentPageKindForType(agent.agentType),
            agent.id,
          )}
          title={agent.name}
          className="max-w-[60%] shrink-0 truncate font-medium text-foreground decoration-muted-foreground/50 underline-offset-4 hover:underline"
        >
          {agent.name}
        </Link>
        <OwnerText
          owner={owner}
          className="min-w-0 truncate text-muted-foreground"
        />
      </div>
    </div>
  );
}

/**
 * Whose agent this is. The viewer's own reads "You" (their email stays
 * reachable in the tooltip), a team- or org-scoped agent names its scope, and
 * a personal agent whose author's account is gone says so instead of looking
 * ownerless.
 */
function OwnerText({
  owner,
  className,
}: {
  owner: AgentOwner;
  className?: string;
}) {
  const label = ownerLabel(owner);
  return (
    <span
      className={cn(className, owner.kind === "deleted" && "italic")}
      title={
        owner.kind === "self"
          ? (owner.email ?? undefined)
          : owner.kind === "deleted"
            ? "The account that owned this agent has been deleted."
            : label
      }
    >
      {label}
    </span>
  );
}

function OwnerAvatar({ owner }: { owner: AgentOwner }) {
  const base =
    "flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium";
  if (owner.kind === "scope") {
    const Icon = owner.scope === "org" ? Building2 : Users;
    return (
      <span
        className={cn(base, "rounded-md bg-muted text-muted-foreground")}
        aria-hidden
      >
        <Icon className="size-3.5" />
      </span>
    );
  }
  if (owner.kind === "deleted") {
    return (
      <span
        className={cn(
          base,
          "border border-dashed border-muted-foreground/40 text-muted-foreground/70",
        )}
        aria-hidden
      >
        <Ghost className="size-3.5" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        base,
        owner.kind === "self"
          ? "bg-primary/15 text-primary"
          : "bg-muted text-foreground/70",
      )}
      aria-hidden
    >
      {initials(owner.email ?? "")}
    </span>
  );
}

function useScrollEdges(
  ref: RefObject<HTMLDivElement | null>,
  contentKey: number,
) {
  const [edges, setEdges] = useState({ atStart: true, atEnd: true });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const atStart = el.scrollLeft <= 1;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    setEdges((prev) =>
      prev.atStart === atStart && prev.atEnd === atEnd
        ? prev
        : { atStart, atEnd },
    );
  }, [ref]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the card count changes
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, update, contentKey]);
  return { ...edges, update };
}

function ownerLabel(owner: AgentOwner): string {
  switch (owner.kind) {
    case "self":
      return "You";
    case "user":
      return owner.email;
    case "deleted":
      return "Deleted user";
    case "scope":
      // Spelled the way every scope pill spells it, never the raw `org` enum.
      return scopeLabel(owner.scope);
  }
}

function initials(email: string) {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]+/).filter((part) => /[a-z]/i.test(part));
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase() || "?";
}
