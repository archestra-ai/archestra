"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { CreatedByCell } from "@/components/created-by-cell";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { LogTime } from "@/components/log-time";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { DataTable } from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  type AgentAdoption,
  type AgentAdoptionMember,
  type AgentAdoptionStatus,
  useAgentAdoption,
} from "@/lib/connected-client.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { AgentIcon, agentLabel } from "./agent-icon";
import type { ConnectionsWindow } from "./connections-window";

type AdoptionAgent = AgentAdoptionMember["agents"][number];

const PAGE_SIZE = 25;
const MAX_AGENT_ICONS = 5;
const ALL = "all";

const STATES: Record<AgentAdoptionStatus, { label: string; color: string }> = {
  active: {
    label: "Active",
    color: "var(--color-emerald-500)",
  },
  inactive: {
    label: "Inactive",
    color: "var(--color-amber-500)",
  },
  notConnected: {
    label: "Not connected",
    color:
      "color-mix(in oklch, var(--muted-foreground) 55%, var(--background))",
  },
};

/** The same states for one agent; one that never reached anything says so. */
const AGENT_STATES: Record<AgentAdoptionStatus, { label: string }> = {
  active: {
    label: "Active",
  },
  inactive: {
    label: "Inactive",
  },
  notConnected: {
    label: "Never connected",
  },
};

const STATE_OPTIONS = [
  { value: ALL, label: "All states" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "notConnected", label: "Not connected" },
];

/** The table lists users without an agent first. */
const STATE_ORDER: AgentAdoptionStatus[] = [
  "notConnected",
  "inactive",
  "active",
];

/**
 * Every user and their configured agents, including users with no calls.
 */
export function AgentAdoptionUsers({ window }: { window: ConnectionsWindow }) {
  const { data, isPending, isLoadingError, refetch } = useAgentAdoption({
    startDate: window.startDate,
    endDate: window.endDate,
  });
  const [filter, setFilter] = useTableFilter();

  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load agent adoption"
        onRetry={() => refetch()}
      />
    );
  }
  if (isPending || !data) return <Skeleton className="h-80 rounded-xl" />;

  return (
    <div>
      <section aria-labelledby="adoption-users" className="space-y-3">
        <div className="space-y-1">
          <h2
            id="adoption-users"
            className="scroll-mt-16 text-sm font-semibold"
          >
            User connections
          </h2>
          <p className="text-xs text-muted-foreground">
            Only agents users connect themselves count, like Claude Code or
            Cursor. Chat and built-in agents don't.
          </p>
        </div>
        <UserTable
          adoption={data}
          window={window}
          filter={filter}
          onFilterChange={setFilter}
        />
      </section>
    </div>
  );
}

// === Users table ===

type TableFilter = { state: AgentAdoptionStatus | typeof ALL; q: string };
type SortKey = "state" | "user" | "gateway" | "llm";

/** The table's state filter and search, kept in the URL. */
function useTableFilter(): [TableFilter, (next: Partial<TableFilter>) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const state = searchParams.get("state");
  const filter: TableFilter = {
    state:
      state === "active" || state === "inactive" || state === "notConnected"
        ? state
        : ALL,
    q: searchParams.get("q") ?? "",
  };
  const set = useCallback(
    (next: Partial<TableFilter>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(next)) {
        if (!value || value === ALL) params.delete(key);
        else params.set(key, value);
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );
  return [filter, set];
}

function UserTable({
  adoption,
  window,
  filter,
  onFilterChange,
}: {
  adoption: AgentAdoption;
  window: ConnectionsWindow;
  filter: TableFilter;
  onFilterChange: (next: Partial<TableFilter>) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({
    key: "state",
    dir: 1,
  });
  const [pageIndex, setPageIndex] = useState(0);
  const rangeStart = window.startDate ? new Date(window.startDate) : null;
  const rows = useMemo(() => {
    const needle = filter.q.trim().toLowerCase();
    const time = (at: string | null) => (at ? Date.parse(at) : 0);
    const byName = (a: AgentAdoptionMember, b: AgentAdoptionMember) =>
      (a.name || a.email).localeCompare(b.name || b.email);
    const compare: Record<
      SortKey,
      (a: AgentAdoptionMember, b: AgentAdoptionMember) => number
    > = {
      state: (a, b) =>
        STATE_ORDER.indexOf(a.status) - STATE_ORDER.indexOf(b.status) ||
        byName(a, b),
      user: byName,
      gateway: (a, b) =>
        time(b.gatewayLastSeenAt) - time(a.gatewayLastSeenAt) || byName(a, b),
      llm: (a, b) =>
        time(b.llmLastSeenAt) - time(a.llmLastSeenAt) || byName(a, b),
    };
    return adoption.members
      .filter(
        (member) =>
          (filter.state === ALL || member.status === filter.state) &&
          (!needle ||
            [member.name, member.email, ...member.agents.map(agentLabel)]
              .join(" ")
              .toLowerCase()
              .includes(needle)),
      )
      .sort((a, b) => compare[sort.key](a, b) * sort.dir);
  }, [adoption.members, filter.state, filter.q, sort]);
  function changeFilter(next: Partial<TableFilter>) {
    setPageIndex(0);
    onFilterChange(next);
  }
  function sortBy(key: SortKey) {
    setPageIndex(0);
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === 1 ? -1 : 1 }
        : { key, dir: 1 },
    );
  }
  const columns: ColumnDef<AgentAdoptionMember>[] = [
    {
      id: "icon",
      size: 40,
      minSize: 40,
      header: "",
      cell: ({ row }) =>
        row.original.agents.length > 0 ? (
          <UnstyledButton
            type="button"
            aria-expanded={row.getIsExpanded()}
            aria-label={`${row.getIsExpanded() ? "Hide" : "Show"} ${row.original.name || row.original.email}'s agents`}
            onClick={row.getToggleExpandedHandler()}
            className="grid size-6 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronRight
              className={cn(
                "size-3.5 transition-transform motion-reduce:transition-none",
                row.getIsExpanded() && "rotate-90",
              )}
            />
          </UnstyledButton>
        ) : null,
    },
    {
      id: "user",
      size: 260,
      minSize: 180,
      header: () => (
        <SortButton sort={sort} sortKey="user" onSort={sortBy}>
          User
        </SortButton>
      ),
      cell: ({ row }) => (
        <CreatedByCell
          showTooltip={false}
          createdBy={{
            id: row.original.userId,
            name: row.original.name,
            email: row.original.email,
          }}
          secondaryText={row.original.email}
          className="text-xs"
        />
      ),
    },
    {
      id: "agents",
      size: 220,
      minSize: 180,
      header: "Agents",
      cell: ({ row }) => <AgentChips agents={row.original.agents} />,
    },
    {
      id: "state",
      size: 160,
      minSize: 160,
      header: () => (
        <SortButton sort={sort} sortKey="state" onSort={sortBy}>
          State
        </SortButton>
      ),
      cell: ({ row }) => <StatePill state={row.original.status} />,
    },
    {
      id: "gateway",
      size: 170,
      minSize: 170,
      header: () => (
        <SortButton sort={sort} sortKey="gateway" onSort={sortBy}>
          Last MCP tool call
        </SortButton>
      ),
      cell: ({ row }) => (
        <LastCall at={row.original.gatewayLastSeenAt} rangeStart={rangeStart} />
      ),
    },
    {
      id: "llm",
      size: 170,
      minSize: 170,
      header: () => (
        <SortButton sort={sort} sortKey="llm" onSort={sortBy}>
          Last LLM proxy call
        </SortButton>
      ),
      cell: ({ row }) => (
        <LastCall at={row.original.llmLastSeenAt} rangeStart={rangeStart} />
      ),
    },
  ];
  return (
    <div>
      <CollectionFilters>
        <FilterBar
          onClearFilters={
            filter.state !== ALL || filter.q
              ? () => changeFilter({ state: ALL, q: "" })
              : undefined
          }
          search={
            <SearchInput
              placeholder="Search users or agents..."
              className={filterSearchClass}
              syncQueryParams={false}
              value={filter.q}
              debounceMs={150}
              onSearchChange={(q) => changeFilter({ q })}
            />
          }
        >
          <FilterSelect
            value={filter.state}
            onValueChange={(state) =>
              changeFilter({ state: state as TableFilter["state"] })
            }
            placeholder="Filter by state"
            items={STATE_OPTIONS}
            inactiveValue={ALL}
          />
        </FilterBar>
      </CollectionFilters>
      <DataTable
        data={rows.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE)}
        columns={columns}
        getRowId={(member) => member.userId}
        hideSelectedCount
        hidePaginationWhenSinglePage
        manualPagination
        pagination={{ pageIndex, pageSize: PAGE_SIZE, total: rows.length }}
        onPaginationChange={({ pageIndex: next }) => setPageIndex(next)}
        fixedWidthColumnIds={["icon", "state", "gateway", "llm"]}
        flexibleColumnIds={["user", "agents"]}
        emptyMessage={
          adoption.members.length === 0
            ? "No users yet."
            : "No users match your filters"
        }
        renderSubComponent={({ row }) => (
          <div className="divide-y bg-muted/20">
            {row.original.agents.map((agent) => (
              <div
                key={agent.clientId ?? agent.name}
                className="grid min-w-[700px] grid-cols-[minmax(240px,1fr)_170px_170px] items-center gap-3 px-4 py-3"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <span className="mt-1.5">
                    <StateDot state={agent.status} />
                    <span className="sr-only">
                      {AGENT_STATES[agent.status].label}
                    </span>
                  </span>
                  <div className="min-w-0">
                    <span className="flex items-center gap-1.5 text-xs font-medium">
                      <AgentIcon agent={agent} size={16} />
                      <span className="truncate">{agentLabel(agent)}</span>
                    </span>
                    <SetupLine agent={agent} />
                  </div>
                </div>
                <LastCall
                  at={agent.lastGatewayCallAt}
                  rangeStart={rangeStart}
                />
                <LastCall at={agent.lastLlmCallAt} rangeStart={rangeStart} />
              </div>
            ))}
          </div>
        )}
      />
    </div>
  );
}

/** How an agent got there, under its name. */
function SetupLine({ agent }: { agent: AdoptionAgent }) {
  const muted = "block text-xs text-muted-foreground";
  if (agent.viaToken)
    return <span className={muted}>Calls on a pasted token</span>;
  if (agent.signedIn || !agent.setupAt)
    return (
      <span className={muted}>
        {agent.setupAt
          ? `Signed in by itself ${formatRelativeTimeFromNow(agent.setupAt)}`
          : "Signed in by itself"}
      </span>
    );
  return (
    <span className={muted}>
      {`Set up ${formatRelativeTimeFromNow(agent.setupAt)}`}
    </span>
  );
}

function Hint({
  text,
  className,
  children,
}: {
  text: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("cursor-help", className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{text}</TooltipContent>
    </Tooltip>
  );
}

/** The user's connected agents as icons, named on hover. */
function AgentChips({ agents }: { agents: AdoptionAgent[] }) {
  if (agents.length === 0) {
    return <span className="text-xs text-muted-foreground">None</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {agents.slice(0, MAX_AGENT_ICONS).map((agent) => (
        <Hint key={agent.clientId ?? agent.name} text={agentLabel(agent)}>
          <AgentIcon agent={agent} size={20} />
        </Hint>
      ))}
      {agents.length > MAX_AGENT_ICONS && (
        <span className="text-xs text-muted-foreground">
          {`+${agents.length - MAX_AGENT_ICONS}`}
        </span>
      )}
    </div>
  );
}

/** The last call ever, muted when it is older than the picked range. */
function LastCall({
  at,
  rangeStart,
}: {
  at: string | null;
  rangeStart: Date | null;
}) {
  if (!at) return <span className="text-xs text-muted-foreground">Never</span>;
  const old = rangeStart !== null && new Date(at) < rangeStart;
  return (
    <span className={cn(old && "text-muted-foreground")}>
      <LogTime showTooltip={false} timestamp={at} />
    </span>
  );
}

function SortButton({
  sort,
  sortKey,
  onSort,
  children,
}: {
  sort: { key: SortKey; dir: 1 | -1 };
  sortKey: SortKey;
  onSort: (key: SortKey) => void;
  children: ReactNode;
}) {
  const on = sort.key === sortKey;
  const Icon = !on ? ArrowUpDown : sort.dir === 1 ? ArrowDown : ArrowUp;
  return (
    <UnstyledButton
      type="button"
      onClick={() => onSort(sortKey)}
      className="flex items-center gap-1 rounded-sm whitespace-nowrap hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
      <Icon className={cn("size-3", !on && "opacity-40")} />
    </UnstyledButton>
  );
}

/** What each state means, in a line each, behind an icon on the card. */
function StatePill({ state }: { state: AgentAdoptionStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap">
      <StateDot state={state} />
      <span>{STATES[state].label}</span>
    </span>
  );
}

function StateDot({ state }: { state: AgentAdoptionStatus }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ backgroundColor: STATES[state].color }}
    />
  );
}
