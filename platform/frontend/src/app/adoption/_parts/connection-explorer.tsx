"use client";

import { useSearchParams } from "next/navigation";
import { KpiTile } from "@/app/llm/(costs)/costs/cost-overview";
import { QueryLoadError } from "@/components/query-load-error";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAgentAdoption,
  useAgentAdoptionUsage,
} from "@/lib/connected-client.query";
import { AgentAdoptionUsers } from "./agent-adoption";
import { ConnectionUsageExplorer } from "./connection-usage";
import type { Dimension } from "./connection-usage-data";
import type { ConnectionsWindow } from "./connections-window";

/**
 * The page's two views of one window, picked by the header tabs. Usage is the
 * call explorer (its "by" picks the user, agent or gateway grouping the old
 * per-grouping views preset), and Coverage is who has and hasn't connected.
 * Individual connection events are on the unified Logs page.
 */
export const ADOPTION_VIEWS = [
  { id: "usage", label: "Usage" },
  { id: "coverage", label: "Coverage" },
] as const;
type View = (typeof ADOPTION_VIEWS)[number]["id"];

/** Which view a URL means, including links from before the rename. */
export function resolveAdoptionView(params: URLSearchParams): View {
  const selected = params.get("view");
  if (selected === "coverage" || selected === "users") return "coverage";
  if (selected === "usage" || (selected && LEGACY_USAGE_VIEWS[selected]))
    return "usage";
  return params.has("state") || params.has("q") ? "coverage" : "usage";
}

/** Earlier links named a grouping as the view; they open Usage grouped so. */
const LEGACY_USAGE_VIEWS: Record<string, Dimension> = {
  user: "user",
  agent: "agent",
  service: "service",
};

export function ConnectionExplorer({ window }: { window: ConnectionsWindow }) {
  const params = useSearchParams();
  const selected = params.get("view");
  const legacyGroup = selected ? LEGACY_USAGE_VIEWS[selected] : undefined;
  const view = resolveAdoptionView(new URLSearchParams(params.toString()));
  const query = { startDate: window.startDate, endDate: window.endDate };
  const adoption = useAgentAdoption(query);
  const usage = useAgentAdoptionUsage(query);

  if (adoption.isLoadingError || usage.isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load adoption"
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
  // Members without an agent or traffic are only counted, not listed.
  const unconnected = adoption.data.memberCount - connected;
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
      {/* Summaries only: the header tabs pick the view, so no tile doubles
          as a selector. */}
      <section
        aria-label="Connection summary"
        className="grid gap-3 sm:grid-cols-3"
      >
        <KpiTile
          label="Users"
          value={adoption.data.memberCount.toLocaleString()}
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
      {view === "coverage" ? (
        <AgentAdoptionUsers window={window} />
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
