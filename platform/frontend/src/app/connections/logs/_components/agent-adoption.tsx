"use client";

import { format, parseISO } from "date-fns";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  type AgentAdoption,
  type AgentAdoptionMember,
  type AgentAdoptionStatus,
  useAgentAdoption,
  useAgentAdoptionUsage,
} from "@/lib/connected-client.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { AgentIcon, agentLabel, connectClientFor } from "./agent-icon";

/** Worst first: the page exists to surface who hasn't connected. */
const STATUS_ORDER: AgentAdoptionStatus[] = [
  "notConnected",
  "setUp",
  "inactive",
  "active",
];

const STATUS_META: Record<
  AgentAdoptionStatus,
  { label: string; dot: string; describe: (a: AgentAdoption) => string }
> = {
  notConnected: {
    label: "Not connected",
    dot: "bg-destructive",
    describe: () => "No agent set up and no calls from one",
  },
  setUp: {
    label: "Set up, no calls",
    dot: "bg-amber-500",
    describe: (a) =>
      `Ran the setup, but no gateway or LLM proxy calls in the last ${a.lookbackDays} days`,
  },
  inactive: {
    label: "Inactive",
    dot: "bg-muted-foreground/60",
    describe: (a) =>
      `Calls in the last ${a.lookbackDays} days, none in the last ${a.activeDays}`,
  },
  active: {
    label: "Active",
    dot: "bg-emerald-500",
    describe: (a) =>
      `Gateway or LLM proxy calls in the last ${a.activeDays} days`,
  },
};

const NO_AGENT = "none";

type StatusFilter = AgentAdoptionStatus | "all";

/**
 * Who has connected an agent and who is using it, judged by gateway and LLM
 * proxy traffic: summary tiles, calls over time, members per agent, and the
 * members themselves (not connected first). Selecting a member narrows the
 * calls chart and, through the shared `userId` URL param, the connection log.
 */
export function AgentAdoptionOverview() {
  const { data, isPending, isLoadingError, refetch } = useAgentAdoption();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedUserId = searchParams.get("userId") ?? undefined;

  const selectMember = useCallback(
    (userId: string | undefined) => {
      const params = new URLSearchParams(searchParams.toString());
      if (userId) params.set("userId", userId);
      else params.delete("userId");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

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
    <div className="flex flex-col gap-6">
      <SummaryTiles adoption={data} />
      <div className="grid gap-6 xl:grid-cols-3">
        <UsageChart
          adoption={data}
          selectedUserId={selectedUserId}
          onSelect={selectMember}
          className="xl:col-span-2"
        />
        <AgentChart adoption={data} />
      </div>
      <MemberList
        adoption={data}
        selectedUserId={selectedUserId}
        onSelect={selectMember}
      />
    </div>
  );
}

function SummaryTiles({ adoption }: { adoption: AgentAdoption }) {
  const total = adoption.members.length;
  const notConnected = adoption.members.filter(
    (m) => m.status === "notConnected",
  ).length;
  const gateway = adoption.members.filter((m) => m.gatewayLastSeenAt).length;
  const llm = adoption.members.filter((m) => m.llmLastSeenAt).length;
  const window = `in the last ${adoption.lookbackDays} days`;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <SummaryTile
        label="Not connected"
        value={notConnected}
        total={total}
        description="No agent set up and no calls from one"
      />
      <SummaryTile
        label="Connected"
        value={total - notConnected}
        total={total}
        description="Set up an agent, or made gateway or LLM proxy calls"
      />
      <SummaryTile
        label="Used the MCP gateway"
        value={gateway}
        total={total}
        description={`Tool calls from an agent ${window}`}
      />
      <SummaryTile
        label="Used the LLM proxy"
        value={llm}
        total={total}
        description={`Model calls from an agent ${window}`}
      />
    </div>
  );
}

/** Same shape as the summary tiles on Costs & limits. */
function SummaryTile({
  label,
  value,
  total,
  description,
}: {
  label: string;
  value: number;
  total: number;
  description: string;
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
        <p className="text-muted-foreground text-xs">{description}</p>
      </CardHeader>
    </Card>
  );
}

const usageChartConfig = {
  gatewayCalls: { label: "MCP gateway", color: "var(--chart-1)" },
  llmCalls: { label: "LLM proxy", color: "var(--chart-2)" },
} satisfies ChartConfig;

function UsageChart({
  adoption,
  selectedUserId,
  onSelect,
  className,
}: {
  adoption: AgentAdoption;
  selectedUserId: string | undefined;
  onSelect: (userId: string | undefined) => void;
  className?: string;
}) {
  const { data, isPending, isLoadingError } =
    useAgentAdoptionUsage(selectedUserId);
  const selected = adoption.members.find((m) => m.userId === selectedUserId);
  const who = selected ? selected.name || selected.email : "all members";
  const totals = (data?.days ?? []).reduce(
    (sum, day) => ({
      gateway: sum.gateway + day.gatewayCalls,
      llm: sum.llm + day.llmCalls,
    }),
    { gateway: 0, llm: 0 },
  );

  return (
    <Card className={cn("min-w-0", className)}>
      <CardHeader>
        <CardTitle>Calls from agents</CardTitle>
        <CardDescription>
          {`MCP gateway and LLM proxy calls per day from ${selected ? `${who}'s agents` : "all members' agents"}, last ${adoption.lookbackDays} days.`}
          {data ? (
            <span className="ml-1 tabular-nums">
              {`${totals.gateway.toLocaleString()} gateway · ${totals.llm.toLocaleString()} LLM proxy.`}
            </span>
          ) : null}
        </CardDescription>
        {selected ? (
          <CardAction>
            <UnstyledButton
              type="button"
              onClick={() => onSelect(undefined)}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Show all members
            </UnstyledButton>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {isLoadingError ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            Couldn't load calls.
          </p>
        ) : isPending || !data ? (
          <Skeleton className="h-56 w-full" />
        ) : (
          <ChartContainer
            config={usageChartConfig}
            className="aspect-auto h-56 w-full"
          >
            <LineChart
              accessibilityLayer
              data={data.days}
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
        )}
      </CardContent>
    </Card>
  );
}

const chartConfig = {
  members: { label: "Members", color: "var(--chart-1)" },
} satisfies ChartConfig;

function AgentChart({ adoption }: { adoption: AgentAdoption }) {
  const data = useMemo(() => agentChartData(adoption), [adoption]);
  const height = Math.max(160, data.length * 36 + 24);

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Members per agent</CardTitle>
        <CardDescription>
          {`Agents set up from the Connect page, signed in to the gateway, or seen on the gateway or LLM proxy in the last ${adoption.lookbackDays} days. A member with two agents counts twice.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={chartConfig}
          className="aspect-auto w-full"
          style={{ height }}
        >
          <BarChart
            accessibilityLayer
            data={data}
            layout="vertical"
            margin={{ left: 0, right: 12 }}
          >
            <CartesianGrid horizontal={false} />
            <XAxis
              type="number"
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              type="category"
              dataKey="label"
              tickLine={false}
              axisLine={false}
              width={104}
            />
            <ChartTooltip
              cursor={{ fill: "var(--muted)", fillOpacity: 0.6 }}
              content={<ChartTooltipContent indicator="dot" hideLabel />}
            />
            <Bar dataKey="members" radius={3} isAnimationActive={false}>
              {data.map((row) => (
                <Cell
                  key={row.id}
                  fill={
                    row.id === NO_AGENT
                      ? "var(--destructive)"
                      : "var(--color-members)"
                  }
                />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function MemberList({
  adoption,
  selectedUserId,
  onSelect,
  className,
}: {
  adoption: AgentAdoption;
  selectedUserId: string | undefined;
  onSelect: (userId: string | undefined) => void;
  className?: string;
}) {
  const [status, setStatus] = useState<StatusFilter>("notConnected");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return adoption.members
      .filter((m) => status === "all" || m.status === status)
      .filter(
        (m) =>
          !needle ||
          m.name.toLowerCase().includes(needle) ||
          m.email.toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
          a.name.localeCompare(b.name),
      );
  }, [adoption.members, status, query]);

  return (
    <Card className={cn("min-w-0", className)}>
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <CardDescription>
          {`When each member's agents last used the MCP gateway, the LLM proxy and a skill, over the last ${adoption.lookbackDays} days. Select a member to see their calls per day and their connection log.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={status}
            onValueChange={(value) => setStatus(value as StatusFilter)}
          >
            <SelectTrigger
              aria-label="Filter members by status"
              className="w-48"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All members</SelectItem>
              {STATUS_ORDER.map((key) => (
                <SelectItem key={key} value={key}>
                  {STATUS_META[key].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <SearchInput
            placeholder="Search members..."
            className="w-full sm:w-56"
            syncQueryParams={false}
            value={query}
            debounceMs={150}
            onSearchChange={setQuery}
          />
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {`${rows.length.toLocaleString()} ${rows.length === 1 ? "member" : "members"}`}
          </span>
        </div>

        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            {query.trim()
              ? `No members match “${query.trim()}”.`
              : status === "notConnected"
                ? "Everyone has connected an agent."
                : "No members here."}
          </p>
        ) : (
          // Long lists scroll inside the card; see SkillUsagePanel for why the
          // cap sits on the table's container.
          <div className="overflow-hidden rounded-md border [&_[data-slot=table-container]]:max-h-[28rem] [&_[data-slot=table-container]]:overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead className="w-28">Agents</TableHead>
                  <TableHead className="hidden w-28 md:table-cell">
                    MCP gateway
                  </TableHead>
                  <TableHead className="hidden w-28 md:table-cell">
                    LLM proxy
                  </TableHead>
                  <TableHead className="hidden w-24 lg:table-cell">
                    Skills
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((member) => (
                  <MemberRow
                    key={member.userId}
                    member={member}
                    adoption={adoption}
                    selected={member.userId === selectedUserId}
                    onSelect={onSelect}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MemberRow({
  member,
  adoption,
  selected,
  onSelect,
}: {
  member: AgentAdoptionMember;
  adoption: AgentAdoption;
  selected: boolean;
  onSelect: (userId: string | undefined) => void;
}) {
  const agents = memberAgents(member);
  const never = `None in the last ${adoption.lookbackDays} days`;
  const toggle = () => onSelect(selected ? undefined : member.userId);
  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      onClick={toggle}
      className="cursor-pointer"
    >
      <TableCell className="py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="img"
                aria-label={STATUS_META[member.status].label}
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  STATUS_META[member.status].dot,
                )}
              />
            </TooltipTrigger>
            <TooltipContent>
              {`${STATUS_META[member.status].label}: ${STATUS_META[member.status].describe(adoption)}`}
            </TooltipContent>
          </Tooltip>
          <div className="min-w-0">
            <TruncatedTooltip content={member.name || member.email}>
              <UnstyledButton
                type="button"
                aria-pressed={selected}
                onClick={(event) => {
                  event.stopPropagation();
                  toggle();
                }}
                className="block max-w-full truncate text-left text-sm font-medium focus-visible:underline focus-visible:outline-none"
              >
                {member.name || member.email}
              </UnstyledButton>
            </TruncatedTooltip>
            <div className="truncate text-xs text-muted-foreground">
              {member.email}
            </div>
          </div>
        </div>
      </TableCell>
      <TableCell className="py-2">
        {agents.length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <div className="flex items-center -space-x-1">
            {agents.slice(0, 4).map((agent) => (
              <Tooltip key={agentKey(agent)}>
                <TooltipTrigger asChild>
                  <span className="rounded-[6px] ring-2 ring-card">
                    <AgentIcon agent={agent} />
                  </span>
                </TooltipTrigger>
                <TooltipContent className="flex flex-col gap-0.5">
                  <span className="font-medium">{agentLabel(agent)}</span>
                  {agentDetails(agent).map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </TooltipContent>
              </Tooltip>
            ))}
            {agents.length > 4 ? (
              <span className="pl-2 text-xs text-muted-foreground">
                +{agents.length - 4}
              </span>
            ) : null}
          </div>
        )}
      </TableCell>
      <LastSeenCell at={member.gatewayLastSeenAt} never={never} />
      <LastSeenCell at={member.llmLastSeenAt} never={never} />
      <LastSeenCell
        at={member.skillLastUsedAt}
        never={never}
        className="hidden lg:table-cell"
        muted
      />
    </TableRow>
  );
}

function LastSeenCell({
  at,
  never,
  className = "hidden md:table-cell",
  muted = false,
}: {
  at: string | null;
  never: string;
  className?: string;
  muted?: boolean;
}) {
  return (
    <TableCell
      className={cn(
        "py-2 text-xs tabular-nums",
        (muted || !at) && "text-muted-foreground",
        className,
      )}
      title={at ? new Date(at).toLocaleString() : never}
    >
      {at ? formatRelativeTimeFromNow(at) : "—"}
    </TableCell>
  );
}

function AdoptionSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[106px] w-full rounded-xl" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <Skeleton className="h-72 w-full rounded-xl xl:col-span-2" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  );
}

// === helpers

type Agent = AgentAdoptionMember["agents"][number];

/** One entry per app, whichever way the agent was recognised. */
function agentKey(agent: Agent): string {
  return connectClientFor(agent)?.id ?? `name:${agent.name.toLowerCase()}`;
}

/**
 * The member's agents, one per app: an app can arrive under several entries,
 * such as one Amp sign-in per Amp install.
 */
function memberAgents(member: AgentAdoptionMember): Agent[] {
  const byKey = new Map<string, Agent>();
  const newest = (a: string | null, b: string | null) =>
    !a ? b : !b ? a : a > b ? a : b;
  const oldest = (a: string | null, b: string | null) =>
    !a ? b : !b ? a : a < b ? a : b;
  for (const agent of member.agents) {
    const key = agentKey(agent);
    const known = byKey.get(key);
    byKey.set(
      key,
      known
        ? {
            ...known,
            setUpAt: newest(known.setUpAt, agent.setUpAt),
            signedInAt: oldest(known.signedInAt, agent.signedInAt),
            gatewayLastSeenAt: newest(
              known.gatewayLastSeenAt,
              agent.gatewayLastSeenAt,
            ),
            llmLastSeenAt: newest(known.llmLastSeenAt, agent.llmLastSeenAt),
          }
        : { ...agent, clientId: connectClientFor(agent)?.id ?? agent.clientId },
    );
  }
  return [...byKey.values()];
}

/** How the agent was connected and when it was last seen, one per line. */
function agentDetails(agent: Agent): string[] {
  const when = (at: string | null) =>
    at ? formatRelativeTimeFromNow(at) : "none";
  return [
    agent.setUpAt ? `Set up ${formatRelativeTimeFromNow(agent.setUpAt)}` : null,
    agent.signedInAt
      ? `Signed in to the gateway ${formatRelativeTimeFromNow(agent.signedInAt)}`
      : null,
    `MCP gateway: ${when(agent.gatewayLastSeenAt)}`,
    `LLM proxy: ${when(agent.llmLastSeenAt)}`,
  ].filter((line): line is string => line !== null);
}

/**
 * Members per agent, counting a member once per agent they set up, signed in
 * or were seen using; members who haven't connected are the last row. Agents
 * nobody uses are left out.
 */
export function agentChartData(adoption: AgentAdoption) {
  const rows = new Map<
    string,
    { id: string; label: string; members: number }
  >();
  let notConnected = 0;
  for (const member of adoption.members) {
    if (member.status === "notConnected") notConnected += 1;
    for (const agent of memberAgents(member)) {
      const id = agentKey(agent);
      const row = rows.get(id) ?? { id, label: agentLabel(agent), members: 0 };
      row.members += 1;
      rows.set(id, row);
    }
  }
  const sorted = [...rows.values()].sort(
    (a, b) => b.members - a.members || a.label.localeCompare(b.label),
  );
  return notConnected > 0
    ? [
        ...sorted,
        { id: NO_AGENT, label: "Not connected", members: notConnected },
      ]
    : sorted;
}

function formatDay(date: string): string {
  return date ? format(parseISO(date), "MMM d") : "";
}

function formatShare(part: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}
