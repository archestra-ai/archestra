"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { KpiTile } from "@/app/llm/(costs)/costs/cost-overview";
import { QueryLoadError } from "@/components/query-load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useAgentAdoption,
  useAgentAdoptionUsage,
} from "@/lib/connected-client.query";
import { AgentAdoptionUsers } from "./agent-adoption";
import { ConnectionLogTable } from "./connection-log-table";
import { ConnectionUsageExplorer } from "./connection-usage";
import type { Dimension } from "./connection-usage-data";
import type { ConnectionsWindow } from "./connections-window";

/**
 * Three views of one window. Usage is the call explorer (its "by" picks the
 * user, agent or gateway grouping the old per-grouping views preset), User
 * connections is who has and hasn't connected, and Activity is setup and
 * sign-in events.
 */
const VIEWS = [
  { id: "usage", label: "Usage" },
  { id: "users", label: "User connections" },
  { id: "activity", label: "Activity" },
] as const;
type View = (typeof VIEWS)[number]["id"];
/** Earlier links named a grouping as the view; they open Usage grouped so. */
const LEGACY_USAGE_VIEWS: Record<string, Dimension> = {
  user: "user",
  agent: "agent",
  service: "service",
};

export function ConnectionExplorer({ window }: { window: ConnectionsWindow }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params.get("view");
  const legacyGroup = selected ? LEGACY_USAGE_VIEWS[selected] : undefined;
  const view: View =
    VIEWS.find((item) => item.id === selected)?.id ??
    (legacyGroup
      ? "usage"
      : params.has("state") || params.has("q")
        ? "users"
        : params.has("action") || params.has("userId")
          ? "activity"
          : "usage");
  const query = { startDate: window.startDate, endDate: window.endDate };
  const adoption = useAgentAdoption(query);
  const usage = useAgentAdoptionUsage(query);

  function pickView(next: View) {
    const updated = new URLSearchParams();
    // The range carries over; every view keeps its own filters.
    for (const key of ["startDate", "endDate"]) {
      const value = params.get(key);
      if (value) updated.set(key, value);
    }
    if (next !== "usage") updated.set("view", next);
    const search = updated.toString();
    router.push(search ? `${pathname}?${search}` : pathname, { scroll: false });
  }

  if (adoption.isLoadingError || usage.isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load agent connections"
        onRetry={() => {
          adoption.refetch();
          usage.refetch();
        }}
      />
    );
  }
  if (!adoption.data || !usage.data) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-36 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-80 rounded-xl" />
      </div>
    );
  }
  const members = adoption.data.members;
  // Read off the window's own calls, so every tile follows the range.
  const usedInRange = members.filter((member) =>
    [...member.gatewayUses, ...member.llmUses].some((use) => use.calls > 0),
  ).length;
  const connected = members.filter((member) => member.agents.length > 0).length;
  const idle = connected - usedInRange;
  const unconnected = members.length - connected;
  const agents = members.reduce(
    (count, member) => count + member.agents.length,
    0,
  );
  const mcp = usage.data.days.reduce(
    (count, day) => count + day.gatewayCalls,
    0,
  );
  const llm = usage.data.days.reduce((count, day) => count + day.llmCalls, 0);
  return (
    <div className="min-w-0 space-y-4">
      {/* Summaries only: the tabs below pick the view, so no tile doubles
          as a selector. */}
      <section
        aria-label="Connection summary"
        className="grid gap-3 sm:grid-cols-3"
      >
        <KpiTile
          label="Users"
          value={members.length.toLocaleString()}
          caption={`${agents.toLocaleString()} agents connected`}
        />
        <KpiTile
          label="Active users"
          value={usedInRange.toLocaleString()}
          caption={`Used an agent ${duringRange(window.label)}`}
          extra={
            <div className="flex h-6 items-center gap-3 text-[11px] text-muted-foreground">
              <span>{Math.max(0, idle).toLocaleString()} connected, idle</span>
              <span>{unconnected.toLocaleString()} not connected</span>
            </div>
          }
        />
        <KpiTile
          label="Calls"
          value={(mcp + llm).toLocaleString()}
          caption={`${mcp.toLocaleString()} MCP · ${llm.toLocaleString()} LLM · ${window.label}`}
          series={usage.data.days.map((day) => day.gatewayCalls + day.llmCalls)}
        />
      </section>
      <Tabs value={view} onValueChange={(next) => pickView(next as View)}>
        <TabsList size="sm" aria-label="Connection views">
          {VIEWS.map((item) => (
            <TabsTrigger key={item.id} value={item.id}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {view === "users" ? (
        <AgentAdoptionUsers window={window} />
      ) : view === "activity" ? (
        <section className="space-y-3" aria-label="Recent connection activity">
          <div className="space-y-1">
            <h2 className="text-sm font-medium">Recent activity</h2>
            <p className="text-xs text-muted-foreground">
              Setup downloads, agent sign-ins, and disconnects.
            </p>
          </div>
          <ConnectionLogTable window={window} />
        </section>
      ) : (
        <ConnectionUsageExplorer
          adoption={adoption.data}
          window={window}
          legacyGroup={legacyGroup}
        />
      )}
    </div>
  );
}

/** "last 30 days" reads "in the last 30 days"; a picked span, "in Oct 1 – 3". */
function duringRange(label: string): string {
  return /^last /i.test(label)
    ? `in the ${label.toLowerCase()}`
    : `in ${label}`;
}
