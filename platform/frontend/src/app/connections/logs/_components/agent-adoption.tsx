"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { format, parseISO } from "date-fns";
import { Users } from "lucide-react";
import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
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
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type AgentAdoption,
  type AgentAdoptionMember,
  type AgentAdoptionUsage,
  useAgentAdoption,
  useAgentAdoptionUsage,
} from "@/lib/connected-client.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { AgentIcon, agentLabel, connectClientFor } from "./agent-icon";

const ALL_VALUE = "all";

const STATUS_OPTIONS = [
  { value: ALL_VALUE, label: "All members" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

/**
 * Who uses Archestra through an agent, judged by gateway and LLM proxy
 * traffic: summary tiles, calls over time, members per agent, and the members
 * themselves. Every filter applies only to the chart or table it sits on.
 */
export function AgentAdoptionOverview() {
  const { data, isPending, isLoadingError, refetch } = useAgentAdoption();

  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load agent adoption"
        onRetry={() => refetch()}
      />
    );
  }
  if (isPending || !data) return <AdoptionSkeleton />;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-6">
        <SummaryTiles adoption={data} />
        <UsageChart adoption={data} />
      </div>
      <section aria-labelledby="adoption-members" className="space-y-3">
        <div className="space-y-1">
          <h2 id="adoption-members" className="text-sm font-semibold">
            Members
          </h2>
          <p className="text-xs text-muted-foreground">
            {`Each member's agents, and when they last used the MCP gateway and the LLM proxy or synced skills, over the last ${data.lookbackDays} days.`}
          </p>
        </div>
        <MemberTable adoption={data} />
      </section>
    </div>
  );
}

function SummaryTiles({ adoption }: { adoption: AgentAdoption }) {
  const total = adoption.members.length;
  const active = adoption.members.filter((m) => m.status === "active").length;
  const gateway = adoption.members.filter((m) => m.gatewayLastSeenAt).length;
  const llm = adoption.members.filter((m) => m.llmLastSeenAt).length;
  const window = `last ${adoption.lookbackDays} days`;

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <SummaryTile
        label={`Active members, ${window}`}
        value={active}
        total={total}
      />
      <SummaryTile
        label={`Members using MCP gateway, ${window}`}
        value={gateway}
        total={total}
      />
      <SummaryTile
        label={`Members using LLM proxy, ${window}`}
        value={llm}
        total={total}
      />
    </div>
  );
}

/** Same shape as the summary tiles on Costs & limits. */
function SummaryTile({
  label,
  value,
  total,
}: {
  label: string;
  value: number;
  total: number;
}) {
  return (
    <Card>
      <CardHeader className="gap-1">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">
          {value.toLocaleString()}
          <span className="ml-1.5 text-sm font-normal text-muted-foreground">
            {`of ${total.toLocaleString()} · ${formatShare(value, total)}`}
          </span>
        </CardTitle>
      </CardHeader>
    </Card>
  );
}

const usageChartConfig = {
  gatewayCalls: { label: "MCP gateway", color: "var(--chart-1)" },
  llmCalls: { label: "LLM proxy", color: "var(--chart-2)" },
} satisfies ChartConfig;

function UsageChart({ adoption }: { adoption: AgentAdoption }) {
  const [userId, setUserId] = useState(ALL_VALUE);
  const selected = adoption.members.find((m) => m.userId === userId);
  const { data, isPending, isLoadingError } = useAgentAdoptionUsage(
    selected?.userId,
  );
  const memberOptions = useMemo(
    () =>
      [...adoption.members]
        .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))
        .map((m) => ({
          value: m.userId,
          label: m.name || m.email,
          description: m.name ? m.email : undefined,
        })),
    [adoption.members],
  );
  const totals = (data?.days ?? []).reduce(
    (sum, day) => ({
      gateway: sum.gateway + day.gatewayCalls,
      llm: sum.llm + day.llmCalls,
    }),
    { gateway: 0, llm: 0 },
  );

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Calls from agents</CardTitle>
        <CardDescription>
          {`MCP gateway and LLM proxy calls per day, last ${adoption.lookbackDays} days.`}
          {data ? (
            <span className="ml-1 tabular-nums">
              {`${totals.gateway.toLocaleString()} gateway · ${totals.llm.toLocaleString()} LLM proxy.`}
            </span>
          ) : null}
        </CardDescription>
        <CardAction>
          <FilterSelect
            value={userId}
            onValueChange={setUserId}
            placeholder="Filter by member"
            items={memberOptions}
            pinnedItems={[{ value: ALL_VALUE, label: "All members" }]}
            inactiveValue={ALL_VALUE}
          />
        </CardAction>
      </CardHeader>
      <CardContent>
        {isLoadingError ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            Couldn't load calls.
          </p>
        ) : isPending || !data ? (
          <Skeleton className="h-56 w-full" />
        ) : (
          <CallsPerDayChart days={data.days} />
        )}
      </CardContent>
    </Card>
  );
}

/** MCP gateway and LLM proxy calls per day, as two lines. */
function CallsPerDayChart({ days }: { days: AgentAdoptionUsage["days"] }) {
  return (
    <ChartContainer
      config={usageChartConfig}
      className="aspect-auto h-56 w-full"
    >
      <LineChart
        accessibilityLayer
        data={days}
        margin={{ top: 8, left: 0, right: 12 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={formatDay}
        />
        <YAxis
          allowDecimals={false}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="dot"
              labelFormatter={(_, payload) =>
                formatDay(String(payload?.[0]?.payload?.date ?? ""))
              }
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Line
          dataKey="gatewayCalls"
          type="monotone"
          stroke="var(--color-gatewayCalls)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          dataKey="llmCalls"
          type="monotone"
          stroke="var(--color-llmCalls)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}

function MemberTable({ adoption }: { adoption: AgentAdoption }) {
  const [status, setStatus] = useState(ALL_VALUE);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState({ pageIndex: 0, pageSize: 10 });
  const [openUserId, setOpenUserId] = useState<string | null>(null);
  const openMember = adoption.members.find((m) => m.userId === openUserId);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return adoption.members
      .filter((m) => status === ALL_VALUE || m.status === status)
      .filter(
        (m) =>
          !needle ||
          m.name.toLowerCase().includes(needle) ||
          m.email.toLowerCase().includes(needle),
      )
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  }, [adoption.members, status, query]);
  const columns = useMemo(() => memberColumns(adoption), [adoption]);

  const hasFilters = status !== ALL_VALUE || query.trim() !== "";
  const clearFilters = () => {
    setStatus(ALL_VALUE);
    setQuery("");
    setPage((p) => ({ ...p, pageIndex: 0 }));
  };

  return (
    <div>
      <CollectionFilters>
        <FilterBar
          onClearFilters={hasFilters ? clearFilters : undefined}
          search={
            <SearchInput
              placeholder="Search members..."
              className={filterSearchClass}
              syncQueryParams={false}
              value={query}
              debounceMs={150}
              onSearchChange={(value) => {
                setQuery(value);
                setPage((p) => ({ ...p, pageIndex: 0 }));
              }}
            />
          }
        >
          <FilterSelect
            value={status}
            onValueChange={(value) => {
              setStatus(value);
              setPage((p) => ({ ...p, pageIndex: 0 }));
            }}
            placeholder="Filter by status"
            items={STATUS_OPTIONS}
            inactiveValue={ALL_VALUE}
          />
        </FilterBar>
      </CollectionFilters>

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.userId}
        onRowClick={(member) => setOpenUserId(member.userId)}
        hideSelectedCount
        pagination={{ ...page, total: rows.length }}
        onPaginationChange={setPage}
        hasActiveFilters={hasFilters}
        emptyIcon={Users}
        emptyMessage="No members yet."
        filteredEmptyMessage="No members match your filters"
        onClearFilters={clearFilters}
      />
      <MemberCallsDialog
        member={openMember}
        adoption={adoption}
        onClose={() => setOpenUserId(null)}
      />
    </div>
  );
}

function memberColumns(
  adoption: AgentAdoption,
): ColumnDef<AgentAdoptionMember>[] {
  const never = `None in the last ${adoption.lookbackDays} days`;
  return [
    {
      id: "member",
      header: "Member",
      size: 300,
      minSize: 200,
      cell: ({ row }) => {
        const member = row.original;
        return (
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {member.name || member.email}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {member.email}
              {member.status === "inactive"
                ? ` · No calls in ${adoption.lookbackDays} days`
                : ""}
            </div>
          </div>
        );
      },
    },
    {
      id: "gateway",
      header: "MCP gateway",
      size: 180,
      minSize: 130,
      cell: ({ row }) => (
        <UsesCell
          lastSeenAt={row.original.gatewayLastSeenAt}
          uses={row.original.gatewayUses}
          never={never}
        />
      ),
    },
    {
      id: "llm",
      header: "LLM proxy",
      size: 180,
      minSize: 130,
      cell: ({ row }) => (
        <UsesCell
          lastSeenAt={row.original.llmLastSeenAt}
          uses={row.original.llmUses}
          never={never}
        />
      ),
    },
    {
      id: "skills",
      header: "Skills synced",
      size: 180,
      minSize: 130,
      cell: ({ row }) => (
        <SkillSyncsCell syncs={row.original.skillSyncs} never={never} />
      ),
    },
  ];
}

type Use = AgentAdoptionMember["gatewayUses"][number];

/**
 * When the member last used a gateway or the proxy; hovering lists which one
 * and which agents made the calls.
 */
function UsesCell({
  lastSeenAt,
  uses,
  never,
}: {
  lastSeenAt: string | null;
  uses: Use[];
  never: string;
}) {
  if (!lastSeenAt || uses.length === 0) {
    return <LastSeen at={lastSeenAt} never={never} />;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default">
          <LastSeen at={lastSeenAt} never={never} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="flex flex-col gap-0.5">
        {uses.map((use) => (
          <span key={keyOfUse(use)}>
            {`${agentLabel(use.agent)} via ${use.via.name}: ${callCount(use.calls)}, ${formatRelativeTimeFromNow(use.lastSeenAt)}`}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * When the member's agents last pulled the skills marketplace; hovering lists
 * each agent. Agents run skills locally, so a sync is all Archestra sees.
 */
function SkillSyncsCell({
  syncs,
  never,
}: {
  syncs: AgentAdoptionMember["skillSyncs"];
  never: string;
}) {
  const last = syncs[0]?.lastSyncedAt ?? null;
  if (!last) return <LastSeen at={null} never={never} />;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default">
          <LastSeen at={last} never={never} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="flex flex-col gap-0.5">
        {syncs.map((sync) => (
          <span key={`${sync.agent.clientId}:${sync.agent.name}`}>
            {`${agentLabel(sync.agent)}: ${formatRelativeTimeFromNow(sync.lastSyncedAt)}`}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One member's calls for an audit: per day, and which agent used which
 * gateway or LLM proxy, how often and when last.
 */
function MemberCallsDialog({
  member,
  adoption,
  onClose,
}: {
  member: AgentAdoptionMember | undefined;
  adoption: AgentAdoption;
  onClose: () => void;
}) {
  const { data } = useAgentAdoptionUsage(member?.userId, {
    enabled: Boolean(member),
  });
  const rows = member
    ? [
        ...member.gatewayUses.map((use) => ({ kind: "MCP gateway", use })),
        ...member.llmUses.map((use) => ({ kind: "LLM proxy", use })),
      ].sort((a, b) => b.use.lastSeenAt.localeCompare(a.use.lastSeenAt))
    : [];

  return (
    <Dialog open={Boolean(member)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{member ? member.name || member.email : ""}</DialogTitle>
          <DialogDescription>
            {`${member?.email ?? ""} · calls from their agents, last ${adoption.lookbackDays} days`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4">
          {data ? (
            <CallsPerDayChart days={data.days} />
          ) : (
            <Skeleton className="h-56 w-full" />
          )}
          {rows.length === 0 ? (
            <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              {`No MCP gateway or LLM proxy calls in the last ${adoption.lookbackDays} days.`}
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Called</TableHead>
                    <TableHead className="w-24 text-right">Calls</TableHead>
                    <TableHead className="w-32">Last call</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(({ kind, use }) => (
                    <TableRow key={`${kind}|${keyOfUse(use)}`}>
                      <TableCell className="py-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <AgentIcon agent={use.agent} />
                          <span className="truncate text-sm">
                            {agentLabel(use.agent)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="py-2">
                        <div className="truncate text-sm">{use.via.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {kind}
                        </div>
                      </TableCell>
                      <TableCell className="py-2 text-right text-sm tabular-nums">
                        {use.calls.toLocaleString()}
                      </TableCell>
                      <TableCell className="py-2">
                        <LastSeen at={use.lastSeenAt} never="" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LastSeen({ at, never }: { at: string | null; never: string }) {
  return (
    <span
      className={cn("text-xs tabular-nums", !at && "text-muted-foreground")}
      title={at ? new Date(at).toLocaleString() : never}
    >
      {at ? formatRelativeTimeFromNow(at) : "—"}
    </span>
  );
}

function AdoptionSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[106px] w-full rounded-xl" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <Skeleton className="h-72 w-full rounded-xl xl:col-span-2" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

// === helpers

/** One entry per app, whichever way the agent was recognised. */
function agentKey(agent: Use["agent"]): string {
  return connectClientFor(agent)?.id ?? `name:${agent.name.toLowerCase()}`;
}

function keyOfUse(use: Use): string {
  return `${use.via.id}|${agentKey(use.agent)}`;
}

function callCount(calls: number): string {
  return `${calls.toLocaleString()} ${calls === 1 ? "call" : "calls"}`;
}

function formatDay(date: string): string {
  return date ? format(parseISO(date), "MMM d") : "";
}

function formatShare(part: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}
