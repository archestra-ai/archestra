"use client";

import { formatDistanceToNow } from "date-fns";
import { ScrollText, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { AgentExecutionLogs } from "@/components/agent-execution-logs";
import { AgentExecutionState } from "@/components/agent-execution-state";
import { AgentExecutionTerminal } from "@/components/agent-execution-terminal";
import { DeploymentConsoleTabList } from "@/components/deployment-console";
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
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
  type AgentExecution,
  useAgentExecutions,
} from "@/lib/agent-background-execution.query";
import { useSession } from "@/lib/auth/auth.query";
import { cn } from "@/lib/utils";

export function AgentExecutions({ agentId }: { agentId: string }) {
  const { data: session } = useSession();
  const {
    data: executions = [],
    isPending,
    isError,
    refetch,
  } = useAgentExecutions(agentId);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selected =
    executions.find((execution) => execution.taskId === selectedTaskId) ??
    executions[0];
  const executionCount = `${executions.length} execution${executions.length === 1 ? "" : "s"}`;

  if (isPending) {
    return <div className="h-48 animate-pulse rounded-lg border bg-muted/30" />;
  }
  if (isError) {
    return (
      <QueryLoadError
        className="border"
        title="Couldn't load executions"
        onRetry={() => refetch()}
      />
    );
  }
  if (executions.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TerminalSquare />
          </EmptyMedia>
          <EmptyTitle>No background executions yet</EmptyTitle>
          <EmptyDescription>
            An execution appears here when another Agent delegates a task to
            this Agent.
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
            {executionCount}
          </span>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-0.5 p-2">
            {executions.map((execution) => {
              const isSelected = execution.taskId === selected?.taskId;
              return (
                <Button
                  key={execution.id}
                  type="button"
                  variant="ghost"
                  className={cn(
                    "h-auto w-full min-w-0 justify-start overflow-hidden rounded-lg px-3 py-2.5 text-left hover:bg-muted/70",
                    isSelected &&
                      "bg-muted text-foreground ring-1 ring-inset ring-border hover:bg-muted",
                  )}
                  onClick={() => setSelectedTaskId(execution.taskId)}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden">
                    <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_1.25rem] items-center gap-1.5">
                      <span
                        className="truncate text-sm font-medium"
                        title={execution.title}
                      >
                        {execution.title}
                      </span>
                      <AgentExecutionState
                        state={execution.state}
                        compact
                        iconOnly
                      />
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] font-normal text-muted-foreground">
                      <span className="font-mono">
                        {shortTaskId(execution.taskId)}
                      </span>
                      <span aria-hidden>·</span>
                      <span className="min-w-0 truncate">
                        {formatDistanceToNow(new Date(execution.startedAt), {
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
        <ExecutionDetails
          key={selected.taskId}
          execution={selected}
          canAttach={selected.actorUserId === session?.user.id}
        />
      )}
    </div>
  );
}

function ExecutionDetails({
  execution,
  canAttach,
}: {
  execution: AgentExecution;
  canAttach: boolean;
}) {
  const active = !execution.endedAt;
  const defaultTab = active && canAttach ? "shell" : "logs";
  const [tab, setTab] = useState(defaultTab);

  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      className="flex min-h-0 flex-col gap-0"
    >
      <section className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b px-5 py-3.5">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-sm font-medium">
                {execution.title}
              </h2>
              <AgentExecutionState
                state={execution.state}
                statusReason={execution.statusReason}
                compact
              />
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
              <span className="font-mono">{shortTaskId(execution.taskId)}</span>
              <span aria-hidden>·</span>
              <span>{new Date(execution.startedAt).toLocaleString()}</span>
            </p>
          </div>
          <DeploymentConsoleTabList
            variant="compact"
            tabs={[
              {
                value: "logs",
                label: "Output",
                icon: <ScrollText className="size-3" />,
              },
              {
                value: "shell",
                label: "Terminal",
                icon: <TerminalSquare className="size-3" />,
                disabled: !active || !canAttach,
                disabledReason: !active
                  ? "The terminal is available only while the execution is running"
                  : "Only the person who started this execution can open its terminal",
              },
            ]}
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col p-4">
          <TabsContent value="logs" className="flex min-h-0 flex-1 flex-col">
            <AgentExecutionLogs execution={execution} title="" />
          </TabsContent>
          <TabsContent value="shell" className="flex min-h-0 flex-1 flex-col">
            <AgentExecutionTerminal
              taskId={execution.taskId}
              active={tab === "shell" && active && canAttach}
              title=""
            />
          </TabsContent>
        </div>
      </section>
    </Tabs>
  );
}

function shortTaskId(taskId: string): string {
  return taskId.slice(0, 8);
}
