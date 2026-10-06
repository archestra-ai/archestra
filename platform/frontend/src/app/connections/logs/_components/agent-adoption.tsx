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
import { Users } from "lucide-react";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ClientIcon } from "@/app/connection/client-icon";
import { CONNECT_CLIENTS } from "@/app/connection/clients";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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

type StatusFilter = AgentAdoptionStatus | "all";

/**
 * Who has connected an agent and who is using it, judged by gateway and LLM
 * proxy traffic: a headline split of the organization's members, the members
 * themselves (not connected first), and how many use each agent.
 */
export function AgentAdoptionOverview() {
  const { data, isPending, isLoadingError, refetch } = useAgentAdoption();
  const [status, setStatus] = useState<StatusFilter>("notConnected");

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
      <StatusSummary adoption={data} status={status} onStatus={setStatus} />
      <div className="grid gap-6 xl:grid-cols-5">
        <MemberList
          adoption={data}
          status={status}
          onStatus={setStatus}
          className="xl:col-span-3"
        />
        <AgentChart adoption={data} className="xl:col-span-2" />
      </div>
    </div>
  );
}

function StatusSummary({
  adoption,
  status,
  onStatus,
}: {
  adoption: AgentAdoption;
  status: StatusFilter;
  onStatus: (status: StatusFilter) => void;
}) {
  const total = adoption.members.length;
  const counts = countByStatus(adoption.members);
  const connected = total - counts.notConnected;

  return (
    <section
      aria-labelledby="adoption-headline"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="adoption-headline" className="text-sm font-semibold">
          <span className="tabular-nums">{counts.notConnected}</span>
          <span>{` of ${total} ${total === 1 ? "member hasn't" : "members haven't"} connected an agent`}</span>
        </h2>
        <p className="text-xs text-muted-foreground tabular-nums">
          {`${formatShare(connected, total)} connected · ${formatShare(counts.active, total)} active in the last ${adoption.activeDays} days`}
        </p>
      </div>

      {/* One bar for the whole organization, worst share first. */}
      <div
        aria-hidden
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        {STATUS_ORDER.map((key) =>
          counts[key] > 0 ? (
            <div
              key={key}
              className={cn("h-full", STATUS_META[key].dot)}
              style={{ width: `${(counts[key] / Math.max(total, 1)) * 100}%` }}
            />
          ) : null,
        )}
      </div>

      <div className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-lg border sm:grid-cols-4 sm:divide-y-0">
        {STATUS_ORDER.map((key) => (
          <UnstyledButton
            key={key}
            type="button"
            onClick={() => onStatus(status === key ? "all" : key)}
            aria-pressed={status === key}
            className={cn(
              "flex flex-col-reverse px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              status === key && "bg-muted/60",
            )}
          >
            <span className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
              <span
                aria-hidden
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  STATUS_META[key].dot,
                )}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="truncate">{STATUS_META[key].label}</span>
                </TooltipTrigger>
                <TooltipContent>
                  {STATUS_META[key].describe(adoption)}
                </TooltipContent>
              </Tooltip>
            </span>
            <span className="text-2xl font-semibold tabular-nums">
              {counts[key].toLocaleString()}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                {formatShare(counts[key], total)}
              </span>
            </span>
          </UnstyledButton>
        ))}
      </div>
    </section>
  );
}

function MemberList({
  adoption,
  status,
  onStatus,
  className,
}: {
  adoption: AgentAdoption;
  status: StatusFilter;
  onStatus: (status: StatusFilter) => void;
  className?: string;
}) {
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

  const title = status === "all" ? "All members" : STATUS_META[status].label;

  return (
    <section
      aria-labelledby="adoption-members"
      className={cn("flex min-w-0 flex-col gap-3", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="adoption-members" className="text-sm font-semibold">
          <span>{title}</span>
          <span className="ml-2 font-normal text-muted-foreground tabular-nums">
            {rows.length.toLocaleString()}
          </span>
          {status !== "all" ? (
            <UnstyledButton
              type="button"
              onClick={() => onStatus("all")}
              className="ml-3 text-xs font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Show all
            </UnstyledButton>
          ) : null}
        </h3>
        <SearchInput
          placeholder="Search members..."
          className="w-full sm:w-56"
          syncQueryParams={false}
          value={query}
          debounceMs={150}
          onSearchChange={setQuery}
        />
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {query.trim()
            ? `No members match “${query.trim()}”.`
            : status === "notConnected"
              ? "Everyone has connected an agent."
              : "No members here."}
        </p>
      ) : (
        // Long lists scroll inside the section so the chart stays in view;
        // see SkillUsagePanel for why the cap sits on the table's container.
        <div className="rounded-lg border [&_[data-slot=table-container]]:max-h-[28rem] [&_[data-slot=table-container]]:overflow-y-auto">
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
    </section>
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
            <TooltipContent>{STATUS_META[member.status].label}</TooltipContent>
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

const chartConfig = {
  setUp: { label: "Set up", color: "var(--chart-1)" },
  llm: { label: "Used the LLM proxy", color: "var(--chart-2)" },
} satisfies ChartConfig;

function AgentChart({
  adoption,
  className,
}: {
  adoption: AgentAdoption;
  className?: string;
}) {
  const data = useMemo(() => agentChartData(adoption), [adoption]);
  const height = Math.max(160, data.length * 36 + 40);

  return (
    <section
      aria-labelledby="adoption-agents"
      className={cn("flex min-w-0 flex-col gap-3", className)}
    >
      <div className="flex flex-col gap-0.5">
        <h3 id="adoption-agents" className="text-sm font-semibold">
          Members per agent
        </h3>
        <p className="text-xs text-muted-foreground">
          {`Set up from the Connect page, and seen on the LLM proxy in the last ${adoption.lookbackDays} days. Gateway calls are counted per member, not per agent.`}
        </p>
      </div>
      {data.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Users />
            </EmptyMedia>
            <EmptyTitle>No agents yet</EmptyTitle>
            <EmptyDescription>
              Agents appear here once members connect one.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="rounded-lg border px-3 pt-3 pb-1">
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
              barGap={2}
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
                width={96}
              />
              <ChartTooltip
                cursor={{ fill: "var(--muted)", fillOpacity: 0.6 }}
                content={<ChartTooltipContent indicator="dot" />}
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar
                dataKey="setUp"
                fill="var(--color-setUp)"
                radius={2}
                isAnimationActive={false}
              />
              <Bar
                dataKey="llm"
                fill="var(--color-llm)"
                radius={2}
                isAnimationActive={false}
              />
            </BarChart>
          </ChartContainer>
        </div>
      )}
    </section>
  );
}

function AdoptionSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-[110px] w-full" />
      <div className="grid gap-6 xl:grid-cols-5">
        <Skeleton className="h-72 w-full xl:col-span-3" />
        <Skeleton className="h-72 w-full xl:col-span-2" />
      </div>
    </div>
  );
}

// === helpers

function countByStatus(
  members: AgentAdoptionMember[],
): Record<AgentAdoptionStatus, number> {
  const counts = { notConnected: 0, setUp: 0, inactive: 0, active: 0 };
  for (const member of members) counts[member.status] += 1;
  return counts;
}

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
 * Per agent: members who set it up, and members whose LLM proxy calls came
 * from it. Calls from agents the Connect page doesn't set up are one "Other"
 * row. Agents nobody uses are left out.
 */
export function agentChartData(adoption: AgentAdoption) {
  const setUp = new Map<string, Set<string>>();
  const llm = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, user: string) => {
    const users = map.get(key) ?? new Set<string>();
    users.add(user);
    map.set(key, users);
  };
  for (const member of adoption.members) {
    for (const id of member.setUpAgents) add(setUp, id, member.userId);
    for (const agent of member.llmAgents) {
      add(llm, LLM_AGENT_CLIENT[agent] ?? OTHER_AGENTS, member.userId);
    }
  }
  return [...INSTALLER_CLIENT_IDS, OTHER_AGENTS]
    .map((id) => ({
      id,
      label:
        id === OTHER_AGENTS
          ? "Other"
          : INSTALLER_CLIENT_LABELS[id as InstallerClientId],
      setUp: setUp.get(id)?.size ?? 0,
      llm: llm.get(id)?.size ?? 0,
    }))
    .filter((row) => row.setUp > 0 || row.llm > 0)
    .sort((a, b) => b.setUp + b.llm - (a.setUp + a.llm));
}

function formatShare(part: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}
