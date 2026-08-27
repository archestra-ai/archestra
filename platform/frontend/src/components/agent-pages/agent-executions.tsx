"use client";

import type {
  AgentRunAttachClosedMessage,
  AgentRunAttachErrorMessage,
  AgentRunAttachOutputMessage,
  AgentRunAttachStartedMessage,
  AgentRunLogsEndedMessage,
  AgentRunLogsErrorMessage,
  AgentRunLogsMessage,
} from "@archestra/shared";
import { formatDistanceToNow } from "date-fns";
import { TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  DeploymentConsoleTabs,
  DeploymentLogPanel,
  useDeploymentLogAutoScroll,
} from "@/components/deployment-console";
import {
  type ExecSessionTransport,
  ExecTerminal,
} from "@/components/exec/exec-terminal";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TabsContent } from "@/components/ui/tabs";
import {
  type AgentExecution,
  useAgentExecutions,
} from "@/lib/agent-background-execution.query";
import { useSession } from "@/lib/auth/auth.query";
import { cn } from "@/lib/utils";
import websocketService from "@/lib/websocket/websocket";

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
    <div className="grid min-h-[520px] gap-4 lg:h-[calc(100dvh-16rem)] lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Card className="min-h-0 py-0">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Execution history</h2>
          <p className="text-xs text-muted-foreground">{executionCount}</p>
        </div>
        <ScrollArea className="min-h-0 flex-1 p-2">
          <div className="space-y-1">
            {executions.map((execution) => {
              const status = getExecutionStatus(execution.state);
              const isSelected = execution.taskId === selected?.taskId;
              return (
                <Button
                  key={execution.id}
                  type="button"
                  variant="ghost"
                  className={cn(
                    "h-auto w-full justify-start rounded-md px-3 py-3 text-left",
                    isSelected && "bg-accent hover:bg-accent",
                  )}
                  onClick={() => setSelectedTaskId(execution.taskId)}
                >
                  <span className="min-w-0 flex-1 space-y-1.5">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs">
                        {shortTaskId(execution.taskId)}
                      </span>
                      <ExecutionStatusBadge status={status} />
                    </span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      Started{" "}
                      {formatDistanceToNow(new Date(execution.startedAt), {
                        addSuffix: true,
                      })}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
        </ScrollArea>
      </Card>

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
  const [tab, setTab] = useState("logs");
  const active = !execution.endedAt;
  const status = getExecutionStatus(execution.state);

  return (
    <Card className="min-h-0 py-0">
      <div className="flex h-full min-h-0 flex-col p-6">
        <div className="mb-4 flex flex-shrink-0 items-start justify-between gap-4 rounded-lg border border-border/60 bg-card px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-sm font-medium">
                {execution.taskId}
              </span>
              <ExecutionStatusBadge status={status} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Started {new Date(execution.startedAt).toLocaleString()}
            </p>
            {execution.statusReason && (
              <p className="mt-2 text-xs text-destructive">
                {execution.statusReason}
              </p>
            )}
          </div>
        </div>

        <DeploymentConsoleTabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: "logs", label: "Logs" },
            {
              value: "shell",
              label: "Shell",
              disabled: !active || !canAttach,
              disabledReason: !active
                ? "Execution must be running to start a shell session"
                : "Only the person who started this execution can open its shell",
            },
          ]}
        >
          <TabsContent
            value="logs"
            className="flex min-h-0 flex-1 flex-col pt-4"
          >
            <ExecutionLogs execution={execution} />
          </TabsContent>
          <TabsContent
            value="shell"
            className="flex min-h-0 flex-1 flex-col pt-4"
          >
            <ExecutionTerminal
              taskId={execution.taskId}
              active={tab === "shell" && active && canAttach}
            />
          </TabsContent>
        </DeploymentConsoleTabs>
      </div>
    </Card>
  );
}

function ExecutionLogs({ execution }: { execution: AgentExecution }) {
  const [content, setContent] = useState("");
  const [error, setError] = useState<string>();
  const [isStreaming, setIsStreaming] = useState(!execution.endedAt);
  const {
    scrollAreaRef,
    showScrollToBottom,
    scrollToBottom,
    followNewOutput,
    reset: resetAutoScroll,
  } = useDeploymentLogAutoScroll();

  useEffect(() => {
    setContent("");
    setError(undefined);
    setIsStreaming(!execution.endedAt);
    resetAutoScroll();
    websocketService.connect();
    const subscriptions = [
      websocketService.subscribe(
        "agent_run_logs",
        (message: AgentRunLogsMessage) => {
          if (message.payload.runId === execution.taskId) {
            setContent((value) => value + message.payload.logs);
            followNewOutput();
          }
        },
      ),
      websocketService.subscribe(
        "agent_run_logs_error",
        (message: AgentRunLogsErrorMessage) => {
          if (message.payload.runId === execution.taskId) {
            setError(message.payload.error);
            setIsStreaming(false);
          }
        },
      ),
      websocketService.subscribe(
        "agent_run_logs_ended",
        (message: AgentRunLogsEndedMessage) => {
          if (message.payload.runId === execution.taskId) {
            setIsStreaming(false);
          }
        },
      ),
    ];
    websocketService.send({
      type: "subscribe_agent_run_logs",
      payload: { runId: execution.taskId },
    });
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
      websocketService.send({
        type: "unsubscribe_agent_run_logs",
        payload: { runId: execution.taskId },
      });
    };
  }, [execution.endedAt, execution.taskId, followNewOutput, resetAutoScroll]);

  return (
    <DeploymentLogPanel
      title="Container Logs"
      detail={execution.deploymentName}
      content={content}
      error={error}
      scrollAreaRef={scrollAreaRef}
      showScrollToBottom={showScrollToBottom}
      onScrollToBottom={scrollToBottom}
      emptyMessage={
        execution.endedAt
          ? "No container output was recorded for this execution."
          : "Waiting for container output…"
      }
      status={
        isStreaming ? (
          <div className="flex items-center gap-1.5 font-mono text-xs text-red-400">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>
            Streaming
          </div>
        ) : content ? (
          <div className="flex items-center gap-1.5 font-mono text-xs text-slate-500">
            <span className="relative inline-flex h-2 w-2 rounded-full bg-slate-600" />
            Retained
          </div>
        ) : null
      }
    />
  );
}

function ExecutionTerminal({
  taskId,
  active,
}: {
  taskId: string;
  active: boolean;
}) {
  const transport = useMemo<ExecSessionTransport>(
    () => ({
      open: (handlers) => {
        websocketService.connect();
        const subscriptions = [
          websocketService.subscribe(
            "agent_run_attach_started",
            (message: AgentRunAttachStartedMessage) => {
              if (message.payload.runId === taskId) {
                handlers.onStarted(message.payload.command);
              }
            },
          ),
          websocketService.subscribe(
            "agent_run_attach_output",
            (message: AgentRunAttachOutputMessage) => {
              if (message.payload.runId === taskId) {
                handlers.onOutput(message.payload.data);
              }
            },
          ),
          websocketService.subscribe(
            "agent_run_attach_error",
            (message: AgentRunAttachErrorMessage) => {
              if (message.payload.runId === taskId) {
                handlers.onError(message.payload.error);
              }
            },
          ),
          websocketService.subscribe(
            "agent_run_attach_closed",
            (message: AgentRunAttachClosedMessage) => {
              if (message.payload.runId === taskId) {
                handlers.onClosed(message.payload.reason ?? null);
              }
            },
          ),
        ];
        websocketService.send({
          type: "subscribe_agent_run_attach",
          payload: { runId: taskId },
        });
        return () => {
          for (const unsubscribe of subscriptions) unsubscribe();
          websocketService.send({
            type: "unsubscribe_agent_run_attach",
            payload: { runId: taskId },
          });
        };
      },
      sendInput: (data) =>
        websocketService.send({
          type: "agent_run_attach_input",
          payload: { runId: taskId, data },
        }),
      sendResize: (cols, rows) =>
        websocketService.send({
          type: "agent_run_attach_resize",
          payload: { runId: taskId, cols, rows },
        }),
    }),
    [taskId],
  );

  return (
    <ExecTerminal sessionKey={taskId} transport={transport} isActive={active} />
  );
}

function getExecutionStatus(state: AgentExecution["state"]): {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} {
  switch (state) {
    case "TASK_STATE_COMPLETED":
      return { label: "Completed", variant: "outline" };
    case "TASK_STATE_FAILED":
      return { label: "Failed", variant: "destructive" };
    case "TASK_STATE_CANCELED":
      return { label: "Canceled", variant: "secondary" };
    case "TASK_STATE_REJECTED":
      return { label: "Rejected", variant: "destructive" };
    case "TASK_STATE_INPUT_REQUIRED":
      return { label: "Needs input", variant: "secondary" };
    case "TASK_STATE_AUTH_REQUIRED":
      return { label: "Needs auth", variant: "secondary" };
    case "TASK_STATE_WORKING":
      return { label: "Running", variant: "default" };
    case "TASK_STATE_SUBMITTED":
      return { label: "Queued", variant: "secondary" };
    default:
      return { label: "Pending", variant: "secondary" };
  }
}

function ExecutionStatusBadge({
  status,
}: {
  status: ReturnType<typeof getExecutionStatus>;
}) {
  return <Badge variant={status.variant}>{status.label}</Badge>;
}

function shortTaskId(taskId: string): string {
  return taskId.slice(0, 8);
}
