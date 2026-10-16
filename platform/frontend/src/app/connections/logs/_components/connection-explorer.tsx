"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { KpiTile } from "@/app/llm/(costs)/costs/cost-overview";
import { QueryLoadError } from "@/components/query-load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  useAgentAdoption,
  useAgentAdoptionUsage,
} from "@/lib/connected-client.query";
import { cn } from "@/lib/utils/tailwind";
import { AgentAdoptionUsers } from "./agent-adoption";
import { ConnectionLogTable } from "./connection-log-table";
import { ConnectionUsageExplorer } from "./connection-usage";
import type { ConnectionsWindow } from "./connections-window";

const VIEWS = [
  { id: "user", label: "Calls by user" },
  { id: "agent", label: "Agent usage" },
  { id: "service", label: "Gateways & proxies" },
  { id: "users", label: "User connections" },
  { id: "activity", label: "Recent activity" },
] as const;
type View = (typeof VIEWS)[number]["id"];

export function ConnectionExplorer({ window }: { window: ConnectionsWindow }) {
  const [viewRevision, setViewRevision] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params.get("view");
  const view: View =
    VIEWS.find((item) => item.id === selected)?.id ??
    (params.has("state") || params.has("q")
      ? "users"
      : params.has("action") || params.has("userId")
        ? "activity"
        : "user");
  const query = { startDate: window.startDate, endDate: window.endDate };
  const adoption = useAgentAdoption(query);
  const usage = useAgentAdoptionUsage(query);

  function pickView(next: View, state?: string) {
    setViewRevision((current) => current + 1);
    const updated = new URLSearchParams(params.toString());
    updated.set("view", next);
    for (const key of ["state", "q", "userId", "action"]) updated.delete(key);
    if (state) updated.set("state", state);
    router.replace(`${pathname}?${updated.toString()}`, { scroll: false });
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
  const active = members.filter((member) => member.status === "active").length;
  const inactive = members.filter(
    (member) => member.status === "inactive",
  ).length;
  const unconnected = members.length - active - inactive;
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
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile
          label="Users"
          value={members.length.toLocaleString()}
          caption={`${agents.toLocaleString()} agents configured`}
          onClick={() => pickView("users")}
          active={view === "users" && !params.has("state")}
        />
        <KpiTile
          label="Active users"
          value={active.toLocaleString()}
          caption="Used an agent in the last 30 days"
          onClick={() => pickView("users", "active")}
          active={view === "users" && params.get("state") === "active"}
          extra={
            <div className="flex h-6 items-center gap-3 text-[11px] text-muted-foreground">
              <span>{inactive.toLocaleString()} inactive</span>
              <span>{unconnected.toLocaleString()} not connected</span>
            </div>
          }
        />
        <KpiTile
          label="Calls"
          value={(mcp + llm).toLocaleString()}
          caption={`${mcp.toLocaleString()} MCP · ${llm.toLocaleString()} LLM · ${window.label}`}
          series={usage.data.days.map((day) => day.gatewayCalls + day.llmCalls)}
          onClick={() => pickView("user")}
        />
      </div>
      <nav aria-label="Connection views" className="flex flex-wrap gap-1.5">
        {VIEWS.map((item) => (
          <UnstyledButton
            key={item.id}
            aria-pressed={view === item.id}
            onClick={() => pickView(item.id)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors",
              view === item.id
                ? "border-foreground bg-foreground text-background"
                : "bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground dark:bg-input/30",
            )}
          >
            <span>{item.label}</span>
          </UnstyledButton>
        ))}
      </nav>
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
          key={`${view}:${viewRevision}`}
          adoption={adoption.data}
          window={window}
          initialGroup={view}
        />
      )}
    </div>
  );
}
