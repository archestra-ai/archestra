"use client";

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  Info,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TablePagination } from "@/components/ui/table-pagination";
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
  type AgentAdoptionUsage,
  useAgentAdoption,
  useAgentAdoptionUsage,
} from "@/lib/connected-client.query";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { AgentIcon, agentLabel } from "./agent-icon";
import type { ConnectionsWindow } from "./connections-window";

type AdoptionAgent = AgentAdoptionMember["agents"][number];

/** Fixed, whatever range is picked, so a user's state doesn't move with it. */
const ACTIVE_DAYS = 30;
const PAGE_SIZE = 25;
const MAX_AGENT_ICONS = 5;
const ALL = "all";

const STATES: Record<
  AgentAdoptionStatus,
  { label: string; color: string; help: string }
> = {
  active: {
    label: "Active",
    color: "var(--color-emerald-500)",
    help: `Used an agent to do something in the last ${ACTIVE_DAYS} days: a tool call through the MCP gateway or a call to the LLM proxy.`,
  },
  inactive: {
    label: "Inactive",
    color: "var(--color-amber-500)",
    help: `Has an agent connected, but it did nothing in the last ${ACTIVE_DAYS} days. Opening the agent doesn't count.`,
  },
  notConnected: {
    label: "Not connected",
    color:
      "color-mix(in oklch, var(--muted-foreground) 55%, var(--background))",
    help: "None of their connected agents has reached the MCP gateway or LLM proxy. Agents they disconnected don't count.",
  },
};

/** The same states for one agent; one that never reached anything says so. */
const AGENT_STATES: Record<
  AgentAdoptionStatus,
  { label: string; help: string }
> = {
  active: {
    label: "Active",
    help: `Did something in the last ${ACTIVE_DAYS} days.`,
  },
  inactive: {
    label: "Inactive",
    help: `Connected, but did nothing in the last ${ACTIVE_DAYS} days.`,
  },
  notConnected: {
    label: "Never connected",
    help: "Set up, but has never reached the MCP gateway or LLM proxy.",
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
const DONUT_ORDER: AgentAdoptionStatus[] = [
  "active",
  "inactive",
  "notConnected",
];

/**
 * Who has an agent connected and who is using it: adoption, the agents in
 * use and their calls on top, then every user with their agents.
 */
export function AgentAdoptionOverview({
  window,
}: {
  window: ConnectionsWindow;
}) {
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
  if (isPending || !data) return <AdoptionSkeleton />;

  const showState = (state: AgentAdoptionStatus) => {
    setFilter({ state });
    document
      .getElementById("adoption-users")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="space-y-8">
      <div className="grid gap-4 lg:grid-cols-3">
        <AdoptionCard adoption={data} onPick={showState} />
        <AgentsInUseCard adoption={data} />
        <AgentCallsCard window={window} />
      </div>
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

// === Card 1: adoption donut ===

const RADIUS = 42;
/** The gap between two slices, as an arc length on the ring. */
const GAP = 1.5;
const point = (angle: number) =>
  `${50 + RADIUS * Math.sin(angle)} ${50 - RADIUS * Math.cos(angle)}`;
const share = (count: number, of: number) =>
  of ? Math.round((count / of) * 100) : 0;

/**
 * Users by state as a donut with its legend, built like the guardrail
 * coverage donut. Hovering a slice or row picks it out; clicking lists those
 * users in the table.
 */
function AdoptionCard({
  adoption,
  onPick,
}: {
  adoption: AgentAdoption;
  onPick: (state: AgentAdoptionStatus) => void;
}) {
  const [hovered, setHovered] = useState<AgentAdoptionStatus | null>(null);
  const total = adoption.members.length;
  const slices = DONUT_ORDER.map((state) => ({
    state,
    ...STATES[state],
    value: adoption.members.filter((m) => m.status === state).length,
  }));
  const shown = slices.filter((s) => s.value > 0);
  const focus = slices.find((s) => s.state === hovered) ?? slices[0];
  const hover = (state: AgentAdoptionStatus) => ({
    onPointerEnter: () => setHovered(state),
    onPointerLeave: () => setHovered(null),
  });
  // A sliver between slices, unless one slice is the whole ring.
  const gap = shown.length > 1 ? GAP / RADIUS : 0;
  let start = 0;
  const arcs = shown.map((slice) => {
    const sweep = (slice.value / total) * 2 * Math.PI;
    const from = start + gap / 2;
    const to = Math.max(start + sweep - gap / 2, from + 0.01);
    start += sweep;
    return { slice, from, to };
  });

  return (
    <Card className="gap-4 py-5">
      <CardHeader className="px-5">
        <CardTitle>{`Active users in the last ${ACTIVE_DAYS} days`}</CardTitle>
        <CardAction>
          <StatesLegend />
        </CardAction>
      </CardHeader>
      <CardContent className="@container flex flex-1 px-5">
        <div className="flex w-full flex-col items-center gap-x-2 gap-y-4 @xs:flex-row">
          <div className="relative size-36 shrink-0">
            <svg
              viewBox="0 0 100 100"
              className="size-full"
              role="img"
              aria-label={slices
                .map((s) => `${s.label}: ${s.value}`)
                .join(", ")}
            >
              <circle
                cx="50"
                cy="50"
                r={RADIUS}
                fill="none"
                strokeWidth="10"
                className="stroke-muted"
              />
              {arcs.map(({ slice, from, to }) =>
                shown.length === 1 ? (
                  // biome-ignore lint/a11y/noStaticElementInteractions: a shortcut; the legend rows are the buttons
                  <circle
                    key={slice.state}
                    cx="50"
                    cy="50"
                    r={RADIUS}
                    fill="none"
                    strokeWidth="10"
                    stroke={slice.color}
                    className="cursor-pointer"
                    onClick={() => onPick(slice.state)}
                    {...hover(slice.state)}
                  />
                ) : (
                  // biome-ignore lint/a11y/noStaticElementInteractions: a shortcut; the legend rows are the buttons
                  <path
                    key={slice.state}
                    d={`M ${point(from)} A ${RADIUS} ${RADIUS} 0 ${to - from > Math.PI ? 1 : 0} 1 ${point(to)}`}
                    fill="none"
                    strokeWidth={slice.state === hovered ? 12 : 10}
                    stroke={slice.color}
                    className={cn(
                      "cursor-pointer transition-[opacity,stroke-width] duration-150 motion-reduce:transition-none",
                      hovered && slice.state !== hovered && "opacity-40",
                    )}
                    onClick={() => onPick(slice.state)}
                    {...hover(slice.state)}
                  />
                ),
              )}
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-2xl font-semibold tabular-nums">
                {`${share(focus.value, total)}%`}
              </span>
              <span className="text-xs text-muted-foreground">
                {focus.label.toLowerCase()}
              </span>
            </div>
          </div>
          <div className="flex w-full min-w-0 flex-1 flex-col gap-0.5">
            {slices.map((slice) => (
              <UnstyledButton
                key={slice.state}
                type="button"
                onClick={() => onPick(slice.state)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-1 py-1 text-left text-sm transition-opacity duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none",
                  hovered && slice.state !== hovered && "opacity-50",
                )}
                {...hover(slice.state)}
              >
                <StateDot state={slice.state} />
                <span className="min-w-0 flex-1 whitespace-nowrap text-muted-foreground">
                  {slice.label}
                </span>
                <span className="font-medium tabular-nums">
                  {slice.value.toLocaleString()}
                </span>
                <span className="w-8 text-right text-xs text-muted-foreground tabular-nums">
                  {`${share(slice.value, total)}%`}
                </span>
              </UnstyledButton>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// === Card 2: agents in use ===

/** The agents active users have, by how many users have each, top five. */
function AgentsInUseCard({ adoption }: { adoption: AgentAdoption }) {
  const tally = new Map<string, { agent: AdoptionAgent; users: number }>();
  let tokenOnly = 0;
  for (const member of adoption.members) {
    if (member.status !== "active") continue;
    const active = member.agents.filter((a) => a.status === "active");
    const named = active.filter((a) => !a.viaToken || a.clientId);
    if (named.length === 0) tokenOnly += 1;
    for (const agent of named) {
      const key = agent.clientId ?? agent.name.toLowerCase();
      const entry = tally.get(key) ?? { agent, users: 0 };
      entry.users += 1;
      tally.set(key, entry);
    }
  }
  const rows = [...tally.values()]
    .sort((a, b) => b.users - a.users)
    .slice(0, 5);
  const max = rows[0]?.users ?? 1;

  return (
    <Card className="gap-4 py-5">
      <CardHeader className="gap-1 px-5">
        <CardTitle>{`Most used agents in the last ${ACTIVE_DAYS} days`}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5 px-5">
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No agent did anything yet.
          </p>
        ) : (
          rows.map(({ agent, users }) => (
            <div
              key={agent.clientId ?? agent.name}
              className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_2rem] items-center gap-2.5 text-sm"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <AgentIcon agent={agent} size={16} />
                <span className="truncate">{agentLabel(agent)}</span>
              </span>
              <span className="h-2 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{ width: `${(users / max) * 100}%` }}
                />
              </span>
              <span className="text-right font-medium tabular-nums">
                {users}
              </span>
            </div>
          ))
        )}
        {tokenOnly > 0 && (
          <p className="text-xs text-muted-foreground">
            {`${tokenOnly} more on a pasted token, agent unknown.`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// === Card 3: agent calls ===

/**
 * Gateway and LLM proxy calls from users' agents in the picked range, against
 * the same length of time just before it, with calls per day.
 */
function AgentCallsCard({ window }: { window: ConnectionsWindow }) {
  const current = useMemo(
    () => ({ startDate: window.startDate, endDate: window.endDate }),
    [window.startDate, window.endDate],
  );
  const before = useMemo(() => previousWindow(current), [current]);
  const now = useAgentAdoptionUsage(current);
  const prev = useAgentAdoptionUsage(before);
  const totals = sumCalls(now.data?.days);
  const prevTotal = sumCalls(prev.data?.days).all;
  // "last 30 days" becomes "the previous 30 days".
  const previousLabel = window.picked
    ? "the period before"
    : `the previous ${window.label.replace(/^last /, "")}`;

  return (
    <Card className="gap-4 py-5">
      <CardHeader className="gap-1 px-5">
        <CardTitle>
          {window.picked
            ? `Agent calls, ${window.label}`
            : `Agent calls in the ${window.label}`}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-5">
        {now.isLoadingError ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Couldn't load calls.
          </p>
        ) : now.isPending || !now.data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="space-y-0.5">
              <div className="flex items-baseline gap-1.5">
                <span className="text-3xl font-semibold tabular-nums">
                  {totals.all.toLocaleString()}
                </span>
                <span className="text-sm text-muted-foreground">
                  {totals.all === 1 ? "call" : "calls"}
                </span>
              </div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {`${totals.gateway.toLocaleString()} tool ${totals.gateway === 1 ? "call" : "calls"} · ${totals.llm.toLocaleString()} LLM ${totals.llm === 1 ? "call" : "calls"}`}
              </div>
              {/* Only a change against calls before; none before says nothing. */}
              {prevTotal > 0 && (
                <Change
                  now={totals.all}
                  before={prevTotal}
                  span={previousLabel}
                />
              )}
            </div>
            <div>
              <Sparkline days={now.data.days} />
              {now.data.days.length > 1 && (
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>{formatDay(now.data.days[0].date)}</span>
                  <span>Calls per day</span>
                  <span>{formatDay(now.data.days.at(-1)?.date ?? "")}</span>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Change({
  now,
  before,
  span,
}: {
  now: number;
  before: number;
  span: string;
}) {
  const percent = Math.round(((now - before) / before) * 100);
  const up = percent >= 0;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        "flex items-center gap-0.5 text-xs font-medium",
        up
          ? "text-emerald-600 dark:text-emerald-500"
          : "text-red-600 dark:text-red-500",
      )}
    >
      <Icon className="size-3" />
      {`${Math.abs(percent)}% vs ${span}`}
    </span>
  );
}

/** Calls per day as a filled line, oldest day first. */
function Sparkline({ days }: { days: AgentAdoptionUsage["days"] }) {
  const values = days.map((d) => d.gatewayCalls + d.llmCalls);
  const max = Math.max(1, ...values);
  const W = 100;
  const H = 36;
  const points = values
    .map((v, i) => {
      const x = values.length > 1 ? (i / (values.length - 1)) * W : W / 2;
      return `${x.toFixed(2)},${(H - (v / max) * (H - 2) - 1).toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-14 w-full"
      role="img"
      aria-label="Calls per day"
    >
      <polygon
        points={`0,${H} ${points} ${W},${H}`}
        className="fill-primary/10"
      />
      <polyline
        points={points}
        fill="none"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        className="stroke-primary"
      />
    </svg>
  );
}

/** A usage day (UTC, YYYY-MM-DD) as "Oct 7". */
function formatDay(date: string): string {
  return date
    ? formatDate({ date: `${date}T12:00:00Z`, dateFormat: "MMM d" })
    : "";
}

function sumCalls(days: AgentAdoptionUsage["days"] | undefined) {
  let gateway = 0;
  let llm = 0;
  for (const day of days ?? []) {
    gateway += day.gatewayCalls;
    llm += day.llmCalls;
  }
  return { gateway, llm, all: gateway + llm };
}

/** The same length of time, ending where the range starts. */
function previousWindow(window: { startDate?: string; endDate?: string }) {
  const start = window.startDate ? new Date(window.startDate).getTime() : 0;
  // Rounded to the minute, so a render reuses the same query.
  const end = window.endDate
    ? new Date(window.endDate).getTime()
    : Math.floor(Date.now() / 60_000) * 60_000;
  return {
    startDate: new Date(start - (end - start)).toISOString(),
    endDate: new Date(start).toISOString(),
  };
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
  const [open, setOpen] = useState<Set<string>>(new Set());
  const rangeStart = window.startDate ? new Date(window.startDate) : null;

  const rows = useMemo(() => {
    const needle = filter.q.trim().toLowerCase();
    const time = (at: string | null) => (at ? new Date(at).getTime() : 0);
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
      .filter((m) => filter.state === ALL || m.status === filter.state)
      .filter(
        (m) =>
          !needle ||
          m.name.toLowerCase().includes(needle) ||
          m.email.toLowerCase().includes(needle) ||
          m.agents.some((a) => agentLabel(a).toLowerCase().includes(needle)),
      )
      .sort((a, b) => compare[sort.key](a, b) * sort.dir);
  }, [adoption.members, filter.state, filter.q, sort]);

  const page = rows.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE);
  const changeFilter = (next: Partial<TableFilter>) => {
    setPageIndex(0);
    onFilterChange(next);
  };
  const toggle = (userId: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(userId)) next.add(userId);
      return next;
    });
  const sortBy = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 },
    );

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

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-9" />
              <TableHead className="w-40">
                <span className="flex items-center gap-1.5">
                  <SortButton sort={sort} sortKey="state" onSort={sortBy}>
                    State
                  </SortButton>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        role="img"
                        aria-label="What the states mean"
                        className="grid size-4 cursor-help place-items-center rounded-full border text-[10px]"
                      >
                        ?
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-72 space-y-1.5">
                      {DONUT_ORDER.map((state) => (
                        <p key={state}>
                          <span className="font-medium">
                            {`${STATES[state].label}:`}
                          </span>{" "}
                          {STATES[state].help}
                        </p>
                      ))}
                    </TooltipContent>
                  </Tooltip>
                </span>
              </TableHead>
              <TableHead>
                <SortButton sort={sort} sortKey="user" onSort={sortBy}>
                  User
                </SortButton>
              </TableHead>
              <TableHead>Agents</TableHead>
              <TableHead className="w-44">
                <SortButton sort={sort} sortKey="gateway" onSort={sortBy}>
                  Last MCP tool call
                </SortButton>
              </TableHead>
              <TableHead className="w-44">
                <SortButton sort={sort} sortKey="llm" onSort={sortBy}>
                  Last LLM proxy call
                </SortButton>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={6}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  {adoption.members.length === 0
                    ? "No users yet."
                    : "No users match your filters"}
                </TableCell>
              </TableRow>
            ) : (
              page.map((member) => (
                <UserRows
                  key={member.userId}
                  member={member}
                  open={open.has(member.userId)}
                  onToggle={() => toggle(member.userId)}
                  rangeStart={rangeStart}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {rows.length > PAGE_SIZE && (
        <TablePagination
          pageIndex={pageIndex}
          pageSize={PAGE_SIZE}
          total={rows.length}
          onPaginationChange={({ pageIndex: next }) => setPageIndex(next)}
          compact
        />
      )}
    </div>
  );
}

/** A user's row and, when open, a line for each of their agents. */
function UserRows({
  member,
  open,
  onToggle,
  rangeStart,
}: {
  member: AgentAdoptionMember;
  open: boolean;
  onToggle: () => void;
  rangeStart: Date | null;
}) {
  const expandable = member.agents.length > 0;
  return (
    <>
      <TableRow
        className={cn(expandable && "cursor-pointer")}
        onClick={expandable ? onToggle : undefined}
      >
        <TableCell className="pr-0">
          {expandable && (
            <UnstyledButton
              type="button"
              aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} ${member.name || member.email}'s agents`}
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className="grid size-6 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ChevronRight
                className={cn(
                  "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                  open && "rotate-90",
                )}
              />
            </UnstyledButton>
          )}
        </TableCell>
        <TableCell>
          <StatePill state={member.status} />
        </TableCell>
        <TableCell>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {member.name || member.email}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {member.email}
            </div>
          </div>
        </TableCell>
        <TableCell>
          <AgentChips agents={member.agents} />
        </TableCell>
        <TableCell>
          <LastCall at={member.gatewayLastSeenAt} rangeStart={rangeStart} />
        </TableCell>
        <TableCell>
          <LastCall at={member.llmLastSeenAt} rangeStart={rangeStart} />
        </TableCell>
      </TableRow>
      {open &&
        member.agents.map((agent) => (
          <TableRow
            key={agent.clientId ?? agent.name}
            className="bg-muted/30 hover:bg-muted/50"
          >
            <TableCell />
            <TableCell />
            <TableCell />
            <TableCell>
              <div className="flex min-w-0 items-start gap-2">
                <Hint
                  text={`${AGENT_STATES[agent.status].label}. ${AGENT_STATES[agent.status].help}`}
                  className="mt-1.5"
                >
                  <StateDot state={agent.status} />
                </Hint>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm">
                    <AgentIcon agent={agent} size={16} />
                    <span className="truncate font-medium">
                      {agentLabel(agent)}
                    </span>
                  </div>
                  <SetupLine agent={agent} />
                </div>
              </div>
            </TableCell>
            <TableCell>
              <LastCall at={agent.lastGatewayCallAt} rangeStart={rangeStart} />
            </TableCell>
            <TableCell>
              <LastCall at={agent.lastLlmCallAt} rangeStart={rangeStart} />
            </TableCell>
          </TableRow>
        ))}
    </>
  );
}

/** How an agent got there, under its name. */
function SetupLine({ agent }: { agent: AdoptionAgent }) {
  const muted = "block text-xs text-muted-foreground";
  if (agent.viaToken) {
    return (
      <Hint text="Calls on a pasted token. The agent didn't say what it is.">
        <span className={muted}>Calls on a pasted token</span>
      </Hint>
    );
  }
  if (agent.signedIn || !agent.setupAt) {
    return (
      <Hint text="Set up by hand. It showed up when it first signed in to the MCP gateway.">
        <span className={muted}>
          {agent.setupAt
            ? `Signed in by itself ${formatRelativeTimeFromNow(agent.setupAt)}`
            : "Signed in by itself"}
        </span>
      </Hint>
    );
  }
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
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("text-sm tabular-nums", old && "text-muted-foreground")}
        >
          {formatRelativeTimeFromNow(at)}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {formatDate({ date: at, dateFormat: "MMM d, yyyy · HH:mm" })}
        {old && <span> · before the picked range</span>}
      </TooltipContent>
    </Tooltip>
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
function StatesLegend() {
  const lines: Record<AgentAdoptionStatus, string> = {
    active: `Did something in the last ${ACTIVE_DAYS} days.`,
    inactive: `Connected, but idle for ${ACTIVE_DAYS} days.`,
    notConnected: "No agent connected.",
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <UnstyledButton
          type="button"
          aria-label="What the states mean"
          className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Info className="size-4" />
        </UnstyledButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-2 p-3 text-xs">
        {DONUT_ORDER.map((state) => (
          <div key={state} className="flex items-start gap-2">
            <span className="mt-1">
              <StateDot state={state} />
            </span>
            <p>
              <span className="font-medium">{STATES[state].label}</span>
              <span className="text-muted-foreground">{` · ${lines[state]}`}</span>
            </p>
          </div>
        ))}
        <p className="text-muted-foreground">
          A user counts by their most active connected agent.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function StatePill({ state }: { state: AgentAdoptionStatus }) {
  return (
    <Hint
      text={STATES[state].help}
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap"
    >
      <StateDot state={state} />
      {STATES[state].label}
    </Hint>
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

function AdoptionSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid gap-4 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-52 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
