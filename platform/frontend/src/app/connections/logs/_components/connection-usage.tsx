"use client";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronRight, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { QueryChip } from "@/app/llm/(costs)/costs/cost-explorer-parts";
import { CreatedByCell } from "@/components/created-by-cell";
import { LogTime } from "@/components/log-time";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { AgentAdoption } from "@/lib/connected-client.query";
import { AgentIcon } from "./agent-icon";
import {
  amount,
  type Dimension,
  type Fact,
  factsOf,
  filterFacts,
  type Group,
  groupsOf,
  type Metric,
  type Scope,
} from "./connection-usage-data";
import type { ConnectionsWindow } from "./connections-window";

const DIMENSIONS = [
  { id: "user", label: "User" },
  { id: "agent", label: "Agent" },
  { id: "service", label: "Gateway / proxy" },
  { id: "kind", label: "MCP / LLM" },
] as const;
const METRICS = [
  { id: "calls", label: "All calls" },
  { id: "mcp", label: "MCP calls" },
  { id: "llm", label: "LLM calls" },
] as const;
type Props = {
  adoption: AgentAdoption;
  window: ConnectionsWindow;
  initialGroup: Dimension;
};

export function ConnectionUsageExplorer(props: Props) {
  const explorer = useExplorer(props);
  const showCallPaths = Boolean(
    explorer.scope.user && explorer.scope.agent && explorer.scope.service,
  );
  return (
    <section
      aria-label="Connection usage explorer"
      className="min-w-0 overflow-hidden rounded-xl border bg-card"
    >
      <div className="border-b bg-muted/30 px-3 py-2.5">
        <QueryBar explorer={explorer} split={explorer.metric === "calls"} />
      </div>
      <div className="space-y-3 px-4 pt-3 pb-4">
        <ScopeTrail explorer={explorer} />
        <Headline explorer={explorer} />
        <p className="text-[11px] text-muted-foreground">
          Observed MCP gateway and LLM proxy calls for this range.
        </p>
        <Bars explorer={explorer} limit={6} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-3 py-2">
        <h2 className="text-xs font-medium">
          {showCallPaths ? "Call paths" : "Summary"}
        </h2>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {showCallPaths ? (
            <span>{explorer.facts.length.toLocaleString()} observed paths</span>
          ) : (
            <span>
              {explorer.rows.length.toLocaleString()} groups · select a row to
              explore
            </span>
          )}
        </span>
      </div>
      <div className="p-3">
        {showCallPaths ? (
          <FactsTable explorer={explorer} />
        ) : (
          <SummaryTable explorer={explorer} />
        )}
      </div>
    </section>
  );
}

function useExplorer(props: Props) {
  const [group, setGroup] = useState<Dimension>(props.initialGroup);
  const [metric, setMetric] = useState<Metric>("calls");
  const [scope, setScope] = useState<Scope>({});
  const [search, setSearch] = useState("");
  const allFacts = useMemo(() => factsOf(props.adoption), [props.adoption]);
  const facts = useMemo(
    () => filterFacts({ facts: allFacts, scope, search, metric }),
    [allFacts, scope, search, metric],
  );
  const rows = useMemo(
    () =>
      groupsOf({
        facts,
        dimension: group,
        members: props.adoption.members,
        scope,
        search,
      }),
    [facts, group, props.adoption.members, scope, search],
  );
  const focus = (dimension: Dimension, key: string) => {
    setScope((previous) => ({ ...previous, [dimension]: key }));
    setSearch("");
    setGroup(
      dimension === "user"
        ? "agent"
        : dimension === "agent"
          ? "service"
          : dimension === "service"
            ? "kind"
            : "user",
    );
  };
  const drill = (row: Group) => focus(row.dimension, row.key);
  const reset = () => {
    setScope({});
    setSearch("");
  };
  return {
    props,
    allFacts,
    facts,
    rows,
    total: amount(facts),
    group,
    setGroup,
    metric,
    setMetric,
    scope,
    setScope,
    search,
    setSearch,
    drill,
    reset,
  };
}
type Explorer = ReturnType<typeof useExplorer>;
function QueryBar({
  explorer,
  split = true,
}: {
  explorer: Explorer;
  split?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <QueryChip
        label="Show"
        value={explorer.metric}
        options={[...METRICS]}
        onChange={explorer.setMetric}
      />
      <QueryChip
        label="by"
        value={explorer.group}
        options={[...DIMENSIONS]}
        onChange={explorer.setGroup}
      />
      {split && (
        <span className="text-[11px] text-muted-foreground">
          MCP / LLM split
        </span>
      )}
      <div className="relative ml-auto w-full sm:w-60">
        <Search className="pointer-events-none absolute left-2 top-2.5 size-3.5 text-muted-foreground" />
        <Input
          aria-label="Search connections"
          placeholder="Search users, agents, gateways…"
          value={explorer.search}
          onChange={(e) => explorer.setSearch(e.target.value)}
          className="h-8 pl-7 text-xs"
        />
      </div>
    </div>
  );
}
function ScopeTrail({ explorer }: { explorer: Explorer }) {
  const entries = Object.entries(explorer.scope) as [Dimension, string][];
  return (
    <div className="flex min-h-7 flex-wrap items-center gap-1.5 text-xs">
      <UnstyledButton
        onClick={explorer.reset}
        className="text-muted-foreground hover:text-foreground"
      >
        <span>All connections</span>
      </UnstyledButton>
      {entries.map(([dim, key]) => {
        const f = explorer.allFacts.find((f) => f[dim] === key);
        const label =
          dim === "user"
            ? (f?.userName ??
              explorer.props.adoption.members.find((m) => m.userId === key)
                ?.name)
            : dim === "agent"
              ? f?.agentName
              : dim === "service"
                ? f?.serviceName
                : key.toUpperCase();
        return (
          <span key={dim} className="inline-flex items-center gap-1">
            <ChevronRight className="size-3 text-muted-foreground" />
            <UnstyledButton
              aria-label={`Remove ${label ?? key} filter`}
              onClick={() =>
                explorer.setScope((previous) => {
                  const next = { ...previous };
                  delete next[dim];
                  return next;
                })
              }
              className="inline-flex items-center gap-1 rounded border bg-muted/30 px-1.5 py-0.5"
            >
              <span>{label ?? key}</span>
              <X className="size-2.5 text-muted-foreground" />
            </UnstyledButton>
          </span>
        );
      })}
    </div>
  );
}
function Headline({ explorer }: { explorer: Explorer }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="text-3xl font-semibold tabular-nums">
        {explorer.total.toLocaleString()}
      </span>
      <span className="text-sm text-muted-foreground">
        {METRICS.find((m) => m.id === explorer.metric)?.label.toLowerCase()} by{" "}
        {DIMENSIONS.find((d) => d.id === explorer.group)?.label.toLowerCase()}
      </span>
      <span className="ml-auto text-[11px] text-muted-foreground">
        {explorer.props.window.label}
      </span>
    </div>
  );
}
function GroupIdentity({
  row,
  showDetail = false,
}: {
  row: Group;
  showDetail?: boolean;
}) {
  const fact = row.facts[0];
  if (row.dimension === "user")
    return (
      <CreatedByCell
        createdBy={{ id: row.key, name: row.label, email: row.detail }}
        secondaryText={showDetail ? row.detail : undefined}
        className="text-xs"
      />
    );
  return (
    <span className="flex min-w-0 items-center gap-2">
      {row.dimension === "agent" && fact && (
        <AgentIcon
          agent={{ clientId: fact.clientId, name: fact.agentName }}
          size={18}
        />
      )}
      <span className="min-w-0">
        <span className="block truncate text-xs">{row.label}</span>
        {showDetail && (
          <span className="block truncate text-[11px] leading-4 text-muted-foreground">
            {row.detail}
          </span>
        )}
      </span>
    </span>
  );
}
function SummaryTable({
  explorer,
  rows = explorer.rows,
}: {
  explorer: Explorer;
  rows?: Group[];
}) {
  const columns: ColumnDef<Group>[] = [
    {
      id: "name",
      header: DIMENSIONS.find((d) => d.id === explorer.group)?.label ?? "Group",
      size: 260,
      minSize: 180,
      cell: ({ row }) => <GroupIdentity row={row.original} showDetail />,
    },
    {
      id: "users",
      header: () => (
        <span className="block whitespace-nowrap text-right">
          {explorer.group === "user" ? "Agents" : "Users"}
        </span>
      ),
      size: 110,
      minSize: 110,
      cell: ({ row }) => (
        <span className="block text-right text-xs tabular-nums">
          {explorer.group === "user" ? row.original.agents : row.original.users}
        </span>
      ),
    },
    {
      id: "mcp",
      header: () => (
        <span className="block whitespace-nowrap text-right">MCP</span>
      ),
      size: 100,
      minSize: 100,
      cell: ({ row }) => (
        <UnstyledButton
          disabled={!row.original.mcp}
          onClick={(e) => {
            e.stopPropagation();
            explorer.setScope((previous) => ({
              ...previous,
              [row.original.dimension]: row.original.key,
              kind: "mcp",
            }));
            explorer.setGroup(
              row.original.dimension === "user" ? "agent" : "user",
            );
          }}
          className="block w-full text-right text-xs tabular-nums hover:underline disabled:cursor-default disabled:no-underline"
        >
          <span>{row.original.mcp.toLocaleString()}</span>
        </UnstyledButton>
      ),
    },
    {
      id: "llm",
      header: () => (
        <span className="block whitespace-nowrap text-right">LLM</span>
      ),
      size: 100,
      minSize: 100,
      cell: ({ row }) => (
        <UnstyledButton
          disabled={!row.original.llm}
          onClick={(e) => {
            e.stopPropagation();
            explorer.setScope((previous) => ({
              ...previous,
              [row.original.dimension]: row.original.key,
              kind: "llm",
            }));
            explorer.setGroup(
              row.original.dimension === "user" ? "agent" : "user",
            );
          }}
          className="block w-full text-right text-xs tabular-nums hover:underline disabled:cursor-default disabled:no-underline"
        >
          <span>{row.original.llm.toLocaleString()}</span>
        </UnstyledButton>
      ),
    },
    {
      id: "calls",
      header: () => (
        <span className="block whitespace-nowrap text-right">Calls</span>
      ),
      size: 100,
      minSize: 100,
      cell: ({ row }) => (
        <span className="block text-right text-xs font-medium tabular-nums">
          {row.original.calls.toLocaleString()}
        </span>
      ),
    },
    {
      id: "last",
      header: "Last call",
      size: 154,
      minSize: 154,
      cell: ({ row }) =>
        row.original.lastSeenAt ? (
          <LogTime timestamp={row.original.lastSeenAt} />
        ) : null,
    },
  ];
  return (
    <DataTable
      data={rows}
      columns={columns}
      hideSelectedCount
      hidePaginationWhenSinglePage
      fixedWidthColumnIds={["users", "mcp", "llm", "calls", "last"]}
      flexibleColumnIds={["name"]}
      onRowClick={explorer.drill}
      emptyMessage="No calls match this view"
    />
  );
}
function Bars({
  explorer,
  rows = explorer.rows,
  limit = 8,
}: {
  explorer: Explorer;
  rows?: Group[];
  limit?: number;
}) {
  const shown = rows.slice(0, limit);
  const max = Math.max(
    1,
    ...shown.map((row) =>
      explorer.metric === "calls" ? row.calls : row[explorer.metric],
    ),
  );
  return (
    <div className="space-y-2">
      {shown.length === 0 && (
        <p className="py-4 text-xs text-muted-foreground">
          No recorded calls in this view.
        </p>
      )}
      {shown.map((row) => {
        const value =
          explorer.metric === "calls" ? row.calls : row[explorer.metric];
        return (
          <UnstyledButton
            key={row.key}
            aria-label={`${row.label}${row.dimension === "service" ? ` (${row.detail})` : ""}: ${value.toLocaleString()} ${explorer.metric === "calls" ? "calls" : `${explorer.metric.toUpperCase()} calls`}`}
            onClick={() => explorer.drill(row)}
            className="grid w-full grid-cols-[minmax(100px,180px)_minmax(0,1fr)_60px] items-center gap-3 rounded px-1 py-1 text-left hover:bg-muted/40"
          >
            <GroupIdentity row={row} />
            <span
              className="flex h-5 min-w-0 overflow-hidden rounded-sm"
              style={{ width: `${(value / max) * 100}%` }}
            >
              {explorer.metric !== "llm" && (
                <span className="bg-chart-1/70" style={{ flex: row.mcp }} />
              )}
              {explorer.metric !== "mcp" && (
                <span className="bg-chart-2/70" style={{ flex: row.llm }} />
              )}
            </span>
            <span className="text-right text-xs font-medium tabular-nums">
              {value.toLocaleString()}
            </span>
          </UnstyledButton>
        );
      })}
      <div className="flex items-center gap-3 pt-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="size-1.5 rounded-sm bg-chart-1" />
          MCP
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-1.5 rounded-sm bg-chart-2" />
          LLM
        </span>
        <span className="ml-auto">Select a row to drill down</span>
      </div>
    </div>
  );
}
function FactsTable({ explorer }: { explorer: Explorer }) {
  const columns: ColumnDef<Fact>[] = [
    {
      id: "user",
      header: "User",
      size: 190,
      cell: ({ row }) => (
        <CreatedByCell
          createdBy={{
            id: row.original.user,
            name: row.original.userName,
            email: row.original.email,
          }}
          className="text-xs"
        />
      ),
    },
    {
      id: "agent",
      header: "Agent",
      size: 170,
      cell: ({ row }) => (
        <span className="flex items-center gap-1.5 text-xs">
          <AgentIcon
            agent={{
              clientId: row.original.clientId,
              name: row.original.agentName,
            }}
            size={16}
          />
          {row.original.agentName}
        </span>
      ),
    },
    {
      id: "service",
      header: "Gateway / proxy",
      size: 200,
      cell: ({ row }) => (
        <div className="text-xs">
          {row.original.serviceName}
          <span className="block text-[11px] text-muted-foreground">
            {row.original.kind === "mcp" ? "MCP gateway" : "LLM proxy"}
          </span>
        </div>
      ),
    },
    {
      id: "calls",
      header: () => (
        <span className="block whitespace-nowrap text-right">Calls</span>
      ),
      size: 100,
      minSize: 100,
      cell: ({ row }) => (
        <span className="block text-right text-xs tabular-nums">
          {row.original.calls.toLocaleString()}
        </span>
      ),
    },
    {
      id: "last",
      header: "Last call",
      size: 154,
      minSize: 154,
      cell: ({ row }) => <LogTime timestamp={row.original.lastSeenAt} />,
    },
  ];
  return (
    <DataTable
      data={explorer.facts}
      columns={columns}
      hideSelectedCount
      hidePaginationWhenSinglePage
      fixedWidthColumnIds={["agent", "service", "calls", "last"]}
      flexibleColumnIds={["user"]}
      emptyMessage="No calls match this selection"
    />
  );
}
