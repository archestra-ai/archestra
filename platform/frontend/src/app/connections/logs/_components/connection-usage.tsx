"use client";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowLeft, ChevronRight, Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { QueryChip } from "@/app/llm/(costs)/costs/cost-explorer-parts";
import { CreatedByCell } from "@/components/created-by-cell";
import { LogTime } from "@/components/log-time";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { AgentAdoption } from "@/lib/connected-client.query";
import { cn } from "@/lib/utils/tailwind";
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
  /** The grouping an older `?view=` link named, until `by` is set. */
  legacyGroup?: Dimension;
};
/**
 * The explorer's state, kept in the URL so a drilldown can be linked and
 * Back steps out of it: `by` and `show` pick the grouping and metric, and
 * each drilled-into value is its own parameter.
 */
const SCOPE_PARAMS: Record<Dimension, string> = {
  user: "user",
  agent: "agent",
  service: "gateway",
  kind: "kind",
};
/** Deepest first: what Back steps out of. */
const DRILL_ORDER: Dimension[] = ["kind", "service", "agent", "user"];
const DEFAULT_GROUP: Dimension = "user";

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
        <QueryBar explorer={explorer} />
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
              {explorer.rows.length.toLocaleString()}{" "}
              {explorer.rows.length === 1 ? "group" : "groups"}
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
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const group: Dimension =
    DIMENSIONS.find((item) => item.id === params.get("by"))?.id ??
    props.legacyGroup ??
    DEFAULT_GROUP;
  const metric: Metric =
    METRICS.find((item) => item.id === params.get("show"))?.id ?? "calls";
  // The search params object only changes on navigation.
  const scope = useMemo(() => {
    const next: Scope = {};
    for (const dimension of DRILL_ORDER) {
      const value = params.get(SCOPE_PARAMS[dimension]);
      if (value) next[dimension] = value;
    }
    return next;
  }, [params]);
  const [search, setSearch] = useState("");

  const navigate = (next: {
    group?: Dimension;
    metric?: Metric;
    scope?: Scope;
  }) => {
    const updated = new URLSearchParams(params.toString());
    // An older `?view=user` named the grouping; `by` says it now.
    if (props.legacyGroup) updated.delete("view");
    const nextGroup = next.group ?? group;
    if (nextGroup === DEFAULT_GROUP) updated.delete("by");
    else updated.set("by", nextGroup);
    const nextMetric = next.metric ?? metric;
    if (nextMetric === "calls") updated.delete("show");
    else updated.set("show", nextMetric);
    const nextScope = next.scope ?? scope;
    for (const dimension of DRILL_ORDER) {
      const value = nextScope[dimension];
      if (value) updated.set(SCOPE_PARAMS[dimension], value);
      else updated.delete(SCOPE_PARAMS[dimension]);
    }
    const query = updated.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

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
  const drill = (row: Group) => {
    setSearch("");
    navigate({
      scope: { ...scope, [row.dimension]: row.key },
      group: NEXT_GROUP[row.dimension],
    });
  };
  /** Drill into one row's MCP or LLM calls. */
  const drillKind = (row: Group, kind: "mcp" | "llm") =>
    navigate({
      scope: { ...scope, [row.dimension]: row.key, kind },
      group: row.dimension === "user" ? "agent" : "user",
    });
  // Dropping a value goes back to grouping by it, so clearing every value
  // returns the explorer to where it started rather than leaving it on the
  // deepest grouping the drilldown reached.
  const removeScope = (dimension: Dimension) => {
    const next = { ...scope };
    delete next[dimension];
    navigate({ scope: next, group: dimension === "kind" ? group : dimension });
  };
  const back = () => {
    const deepest = DRILL_ORDER.find((dimension) => scope[dimension]);
    if (deepest) removeScope(deepest);
  };
  const reset = () => {
    setSearch("");
    navigate({ scope: {}, group: DEFAULT_GROUP });
  };
  return {
    props,
    allFacts,
    facts,
    rows,
    total: amount(facts),
    group,
    setGroup: (next: Dimension) => navigate({ group: next }),
    metric,
    setMetric: (next: Metric) => navigate({ metric: next }),
    scope,
    search,
    setSearch,
    drill,
    drillKind,
    removeScope,
    back,
    reset,
  };
}

/** Where a click on a row of each grouping leads. */
const NEXT_GROUP: Record<Dimension, Dimension> = {
  user: "agent",
  agent: "service",
  service: "kind",
  kind: "user",
};
type Explorer = ReturnType<typeof useExplorer>;
function QueryBar({ explorer }: { explorer: Explorer }) {
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
      {entries.length > 0 ? (
        <Button
          variant="outline"
          size="xs"
          className="mr-1"
          onClick={explorer.back}
        >
          <ArrowLeft aria-hidden="true" />
          <span>Back</span>
        </Button>
      ) : null}
      <UnstyledButton
        onClick={explorer.reset}
        className={cn(
          entries.length > 0
            ? "text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            : "font-medium text-foreground",
        )}
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
              onClick={() => explorer.removeScope(dim)}
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
        showTooltip={false}
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
            explorer.drillKind(row.original, "mcp");
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
            explorer.drillKind(row.original, "llm");
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
          <LogTime showTooltip={false} timestamp={row.original.lastSeenAt} />
        ) : null,
    },
    {
      // A row opens the next level down; the chevron says so.
      id: "open",
      header: () => <span className="sr-only">Open</span>,
      size: 36,
      minSize: 36,
      cell: () => (
        <ChevronRight
          aria-hidden="true"
          className="ml-auto size-4 text-muted-foreground"
        />
      ),
    },
  ];
  return (
    <DataTable
      data={rows}
      columns={columns}
      hideSelectedCount
      hidePaginationWhenSinglePage
      fixedWidthColumnIds={["users", "mcp", "llm", "calls", "last", "open"]}
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
        <span className="ml-auto">Select a bar or row to see what's in it</span>
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
          showTooltip={false}
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
      cell: ({ row }) => (
        <LogTime showTooltip={false} timestamp={row.original.lastSeenAt} />
      ),
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
