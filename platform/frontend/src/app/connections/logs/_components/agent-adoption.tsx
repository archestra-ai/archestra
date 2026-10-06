"use client";

import {
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_DESKTOP_CLIENT_ID,
  CODEX_CLIENT_ID,
  COPILOT_CLI_CLIENT_ID,
  CURSOR_CLIENT_ID,
  OPENCODE_CLIENT_ID,
} from "@archestra/shared";
import {
  INSTALLER_CLIENT_IDS,
  INSTALLER_CLIENT_LABELS,
  type InstallerClientId,
} from "@archestra/shared/connection-setup";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import { ClientIcon } from "@/app/connection/client-icon";
import { CONNECT_CLIENTS } from "@/app/connection/clients";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
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
import {
  type AgentAdoption,
  type AgentAdoptionMember,
  type AgentAdoptionStatus,
  useAgentAdoption,
} from "@/lib/connected-client.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";

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

/** LLM proxy `external_agent_id` values the Connect page's agents send. */
const LLM_AGENT_CLIENT: Record<string, InstallerClientId> = {
  [CLAUDE_CODE_CLIENT_ID]: "claude-code",
  [CLAUDE_DESKTOP_CLIENT_ID]: "claude-desktop",
  [CODEX_CLIENT_ID]: "codex",
  [COPILOT_CLI_CLIENT_ID]: "copilot-cli",
  [CURSOR_CLIENT_ID]: "cursor",
  [OPENCODE_CLIENT_ID]: "opencode",
};

const CLIENTS_BY_ID = new Map(CONNECT_CLIENTS.map((c) => [c.id, c]));
const OTHER_AGENTS = "other";
const NO_AGENT = "none";

type StatusFilter = AgentAdoptionStatus | "all";

/**
 * Who has connected an agent and who is using it, judged by gateway and LLM
 * proxy traffic: summary tiles, members per agent, and the members themselves
 * (not connected first).
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
    <div className="flex flex-col gap-6">
      <SummaryTiles adoption={data} />
      <div className="grid gap-6 xl:grid-cols-3">
        <AgentChart adoption={data} />
        <MemberList adoption={data} className="xl:col-span-2" />
      </div>
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
          {`Agents set up from the Connect page or seen on the LLM proxy in the last ${adoption.lookbackDays} days. A member with two agents counts twice.`}
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
  className,
}: {
  adoption: AgentAdoption;
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
          {`When each member's agents last used the MCP gateway, the LLM proxy and a skill, over the last ${adoption.lookbackDays} days.`}
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
}: {
  member: AgentAdoptionMember;
  adoption: AgentAdoption;
}) {
  const agents = memberAgents(member);
  const never = `None in the last ${adoption.lookbackDays} days`;
  return (
    <TableRow>
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
              <div className="truncate text-sm font-medium">
                {member.name || member.email}
              </div>
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
            {agents.slice(0, 4).map((id) => {
              const client = CLIENTS_BY_ID.get(id);
              return client ? (
                <Tooltip key={id}>
                  <TooltipTrigger asChild>
                    <span className="rounded-[6px] ring-2 ring-card">
                      <ClientIcon client={client} size={22} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {INSTALLER_CLIENT_LABELS[id as InstallerClientId] ??
                      client.label}
                  </TooltipContent>
                </Tooltip>
              ) : null;
            })}
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
        <Skeleton className="h-72 w-full rounded-xl" />
        <Skeleton className="h-72 w-full rounded-xl xl:col-span-2" />
      </div>
    </div>
  );
}

// === helpers

/** Connect page agents a member set up or was seen using, in page order. */
function memberAgents(member: AgentAdoptionMember): string[] {
  const ids = new Set<string>(member.setUpAgents);
  for (const agent of member.llmAgents) {
    const client = LLM_AGENT_CLIENT[agent];
    if (client) ids.add(client);
  }
  return INSTALLER_CLIENT_IDS.filter((id) => ids.has(id));
}

/**
 * Members per agent, counting a member once per agent they set up or whose
 * LLM proxy calls came from it. Calls from agents the Connect page doesn't set
 * up are one "Other" row, and members who haven't connected are the last row.
 * Agents nobody uses are left out.
 */
export function agentChartData(adoption: AgentAdoption) {
  const counts = new Map<string, number>();
  const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const member of adoption.members) {
    const agents = memberAgents(member);
    const other = member.llmAgents.some((a) => !LLM_AGENT_CLIENT[a]);
    for (const id of agents) bump(id);
    if (other) bump(OTHER_AGENTS);
    if (member.status === "notConnected") bump(NO_AGENT);
  }
  const rows = [...INSTALLER_CLIENT_IDS, OTHER_AGENTS]
    .map((id) => ({
      id,
      label:
        id === OTHER_AGENTS
          ? "Other"
          : INSTALLER_CLIENT_LABELS[id as InstallerClientId],
      members: counts.get(id) ?? 0,
    }))
    .filter((row) => row.members > 0)
    .sort((a, b) => b.members - a.members);
  const none = counts.get(NO_AGENT) ?? 0;
  return none > 0
    ? [...rows, { id: NO_AGENT, label: "Not connected", members: none }]
    : rows;
}

function formatShare(part: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}
