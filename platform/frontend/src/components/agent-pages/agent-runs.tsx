"use client";

import { formatDistanceToNow } from "date-fns";
import { TerminalSquare } from "lucide-react";
import { useState } from "react";
import { AgentRunLiveness } from "@/components/agent-run-liveness";
import { AgentRunLogs } from "@/components/agent-run-logs";
import { AgentRunState } from "@/components/agent-run-state";
import { AgentRunTerminal } from "@/components/agent-run-terminal";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { type AgentRun, useAgentRuns } from "@/lib/agent-runtime.query";
import { useSession } from "@/lib/auth/auth.query";
import { cn } from "@/lib/utils";

export function AgentRuns({ agentId }: { agentId: string }) {
  const { data: session } = useSession();
  const {
    data: runs = [],
    isPending,
    isError,
    refetch,
  } = useAgentRuns(agentId);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selected = runs.find((run) => run.taskId === selectedTaskId) ?? runs[0];
  const runCount = `${runs.length} run${runs.length === 1 ? "" : "s"}`;

  if (isPending) {
    return <div className="h-48 animate-pulse rounded-lg border bg-muted/30" />;
  }
  if (isError) {
    return (
      <QueryLoadError
        className="border"
        title="Couldn't load runs"
        onRetry={() => refetch()}
      />
    );
  }
  if (runs.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TerminalSquare />
          </EmptyMedia>
          <EmptyTitle>No Agent Runtime runs yet</EmptyTitle>
          <EmptyDescription>
            A run appears here when another Agent delegates a task to this
            Agent.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="grid min-h-[520px] overflow-hidden rounded-xl border bg-card/30 lg:h-[calc(100dvh-16rem)] lg:grid-cols-[15.5rem_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col border-b bg-muted/10 lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-medium">History</h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {runCount}
          </span>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-0.5 p-2">
            {runs.map((run) => {
              const isSelected = run.taskId === selected?.taskId;
              return (
                <Button
                  key={run.id}
                  type="button"
                  variant="ghost"
                  className={cn(
                    "h-auto w-full min-w-0 justify-start overflow-hidden rounded-lg px-3 py-2.5 text-left hover:bg-muted/70",
                    isSelected &&
                      "bg-muted text-foreground ring-1 ring-inset ring-border hover:bg-muted",
                  )}
                  onClick={() => setSelectedTaskId(run.taskId)}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden">
                    <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_1.25rem] items-center gap-1.5">
                      <span
                        className="truncate text-sm font-medium"
                        title={run.title}
                      >
                        {run.title}
                      </span>
                      <AgentRunState
                        state={run.state}
                        lastModelActivityAt={run.lastModelActivityAt}
                        startedAt={run.startedAt}
                        endedAt={run.endedAt}
                        compact
                        iconOnly
                      />
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] font-normal text-muted-foreground">
                      <span className="font-mono">
                        {shortTaskId(run.taskId)}
                      </span>
                      <span aria-hidden>·</span>
                      <span className="min-w-0 truncate">
                        {formatDistanceToNow(new Date(run.startedAt), {
                          addSuffix: true,
                        })}
                      </span>
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
        </ScrollArea>
      </aside>

      {selected && (
        <RunDetails
          key={selected.taskId}
          run={selected}
          canAttach={selected.actorUserId === session?.user.id}
          onClosed={() => void refetch()}
        />
      )}
    </div>
  );
}

function RunDetails({
  run,
  canAttach,
  onClosed,
}: {
  run: AgentRun;
  canAttach: boolean;
  onClosed: () => void;
}) {
  const active = !run.endedAt;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 items-center gap-4 border-b px-5 py-3.5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-medium">{run.title}</h2>
            <AgentRunState
              state={run.state}
              statusReason={run.statusReason}
              lastModelActivityAt={run.lastModelActivityAt}
              startedAt={run.startedAt}
              endedAt={run.endedAt}
              compact
            />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
            <span className="font-mono">{shortTaskId(run.taskId)}</span>
            <span aria-hidden>·</span>
            <span>{new Date(run.startedAt).toLocaleString()}</span>
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {active && <AgentRunLiveness run={run} />}
        {active && canAttach ? (
          <AgentRunTerminal
            taskId={run.taskId}
            active
            title=""
            showDisconnectedStatus={false}
            onError={onClosed}
            onClosed={onClosed}
          />
        ) : (
          <AgentRunLogs run={run} title="" />
        )}
      </div>
    </section>
  );
}

function shortTaskId(taskId: string): string {
  return taskId.slice(0, 8);
}
