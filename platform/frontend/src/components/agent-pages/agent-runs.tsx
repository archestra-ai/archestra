"use client";

import type {
  AgentRunAttachClosedMessage,
  AgentRunAttachErrorMessage,
  AgentRunAttachOutputMessage,
  AgentRunAttachStartedMessage,
  AgentRunLogsErrorMessage,
  AgentRunLogsMessage,
} from "@archestra/shared";
import { formatDistanceToNow } from "date-fns";
import { ScrollText, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  type ExecSessionTransport,
  ExecTerminal,
} from "@/components/exec/exec-terminal";
import { LogConsole } from "@/components/log-console";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type AgentRun,
  useAgentRuns,
} from "@/lib/agent-background-execution.query";
import websocketService from "@/lib/websocket/websocket";

export function AgentRuns({ agentId }: { agentId: string }) {
  const {
    data: runs = [],
    isPending,
    isError,
    refetch,
  } = useAgentRuns(agentId);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selected = runs.find((run) => run.taskId === selectedTaskId) ?? runs[0];

  if (isPending)
    return <div className="h-48 animate-pulse rounded-lg border bg-muted/30" />;
  if (isError)
    return (
      <QueryLoadError
        className="border"
        title="Couldn't load runs"
        onRetry={() => refetch()}
      />
    );
  if (runs.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TerminalSquare />
          </EmptyMedia>
          <EmptyTitle>No background runs yet</EmptyTitle>
          <EmptyDescription>
            A run appears here when another Agent delegates a task to this
            Agent.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <div className="space-y-2">
        {runs.map((run) => (
          <Button
            key={run.id}
            type="button"
            variant={run.taskId === selected?.taskId ? "secondary" : "ghost"}
            className="h-auto w-full justify-start p-3 text-left"
            onClick={() => setSelectedTaskId(run.taskId)}
          >
            <span className="min-w-0 space-y-1">
              <span className="flex items-center gap-2">
                <span className="truncate font-mono text-xs">{run.taskId}</span>
                <Badge variant={run.endedAt ? "outline" : "default"}>
                  {run.endedAt ? "Finished" : "Running"}
                </Badge>
              </span>
              <span className="block text-xs text-muted-foreground">
                Started{" "}
                {formatDistanceToNow(new Date(run.startedAt), {
                  addSuffix: true,
                })}
              </span>
            </span>
          </Button>
        ))}
      </div>
      {selected && <RunDetails run={selected} />}
    </div>
  );
}

function RunDetails({ run }: { run: AgentRun }) {
  const [tab, setTab] = useState("logs");
  return (
    <Tabs value={tab} onValueChange={setTab} className="min-w-0">
      <TabsList>
        <TabsTrigger value="logs">
          <ScrollText className="h-4 w-4" /> Logs
        </TabsTrigger>
        <TabsTrigger value="shell" disabled={Boolean(run.endedAt)}>
          <TerminalSquare className="h-4 w-4" /> Shell
        </TabsTrigger>
      </TabsList>
      <TabsContent value="logs" className="mt-3">
        <RunLogs taskId={run.taskId} active={!run.endedAt} />
      </TabsContent>
      <TabsContent value="shell" className="mt-3">
        <RunTerminal taskId={run.taskId} active={tab === "shell"} />
      </TabsContent>
    </Tabs>
  );
}

function RunLogs({ taskId, active }: { taskId: string; active: boolean }) {
  const [content, setContent] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!active) return undefined;
    websocketService.connect();
    const unsubscribeLogs = websocketService.subscribe(
      "agent_run_logs",
      (message: AgentRunLogsMessage) => {
        if (message.payload.runId === taskId)
          setContent((value) => value + message.payload.logs);
      },
    );
    const unsubscribeError = websocketService.subscribe(
      "agent_run_logs_error",
      (message: AgentRunLogsErrorMessage) => {
        if (message.payload.runId === taskId) setError(message.payload.error);
      },
    );
    websocketService.send({
      type: "subscribe_agent_run_logs",
      payload: { runId: taskId },
    });
    return () => {
      unsubscribeLogs();
      unsubscribeError();
      websocketService.send({
        type: "unsubscribe_agent_run_logs",
        payload: { runId: taskId },
      });
    };
  }, [active, taskId]);

  return (
    <LogConsole
      content={content}
      error={error}
      emptyMessage={
        active
          ? "Waiting for logs…"
          : "Logs are available while a run is active."
      }
    />
  );
}

function RunTerminal({ taskId, active }: { taskId: string; active: boolean }) {
  const transport = useMemo<ExecSessionTransport>(
    () => ({
      open: (handlers) => {
        websocketService.connect();
        const subscriptions = [
          websocketService.subscribe(
            "agent_run_attach_started",
            (message: AgentRunAttachStartedMessage) => {
              if (message.payload.runId === taskId)
                handlers.onStarted(message.payload.command);
            },
          ),
          websocketService.subscribe(
            "agent_run_attach_output",
            (message: AgentRunAttachOutputMessage) => {
              if (message.payload.runId === taskId)
                handlers.onOutput(message.payload.data);
            },
          ),
          websocketService.subscribe(
            "agent_run_attach_error",
            (message: AgentRunAttachErrorMessage) => {
              if (message.payload.runId === taskId)
                handlers.onError(message.payload.error);
            },
          ),
          websocketService.subscribe(
            "agent_run_attach_closed",
            (message: AgentRunAttachClosedMessage) => {
              if (message.payload.runId === taskId)
                handlers.onClosed(message.payload.reason ?? null);
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
