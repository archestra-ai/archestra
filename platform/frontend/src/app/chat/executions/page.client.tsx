"use client";

import { Loader2, Square, TerminalSquare } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AgentExecutionLogs } from "@/components/agent-execution-logs";
import { AgentExecutionState } from "@/components/agent-execution-state";
import { AgentExecutionTerminal } from "@/components/agent-execution-terminal";
import { AgentIcon } from "@/components/agent-icon";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import {
  useCancelAgentExecution,
  useMyAgentExecution,
} from "@/lib/agent-background-execution.query";

export function BackgroundExecutionChatSession({ taskId }: { taskId: string }) {
  const query = useMyAgentExecution(taskId);
  const cancelExecution = useCancelAgentExecution();
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const execution = query.data;

  if (query.isPending && !execution) {
    return <ExecutionBooting />;
  }
  if (!execution) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <QueryLoadError
          className="max-w-lg border"
          title="Couldn't load this execution"
          description={executionLoadErrorDescription(query.error)}
          onRetry={() => query.refetch()}
        />
      </div>
    );
  }

  const live = execution.endedAt === null;
  const terminalReady =
    live &&
    (execution.state === "TASK_STATE_WORKING" ||
      execution.state === "TASK_STATE_INPUT_REQUIRED");

  return (
    <main className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
            <AgentIcon icon={execution.agent.icon} size={20} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-medium">
                {execution.title}
              </h1>
              <AgentExecutionState
                state={execution.state}
                statusReason={execution.statusReason}
                compact
              />
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {execution.agent.name}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {live && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStopDialogOpen(true)}
            >
              <Square className="size-3.5 fill-current" />
              Stop
            </Button>
          )}
          <Button variant="outline" size="sm" asChild>
            <Link href={`/agents/${execution.agent.id}?tab=executions`}>
              Agent details
            </Link>
          </Button>
        </div>
      </header>

      <section className="flex min-h-0 flex-1 flex-col p-4 md:p-6">
        {terminalReady ? (
          <AgentExecutionTerminal
            taskId={taskId}
            active
            title="Live terminal"
            onClosed={() => void query.refetch()}
          />
        ) : live ? (
          <ExecutionBooting inline agentName={execution.agent.name} />
        ) : (
          <AgentExecutionLogs execution={execution} />
        )}
      </section>
      <DeleteConfirmDialog
        open={stopDialogOpen}
        onOpenChange={setStopDialogOpen}
        title="Stop this execution?"
        description="The Agent process will stop and its terminal output will be retained."
        isPending={cancelExecution.isPending}
        confirmLabel="Stop execution"
        pendingLabel="Stopping…"
        onConfirm={() =>
          cancelExecution.mutate(taskId, {
            onSuccess: () => setStopDialogOpen(false),
          })
        }
      />
    </main>
  );
}

function executionLoadErrorDescription(error: unknown): string | undefined {
  if (error instanceof Error && error.message === "Execution not found") {
    return "This execution no longer exists, or you no longer have access to it.";
  }
  return undefined;
}

function ExecutionBooting({
  inline = false,
  agentName,
}: {
  inline?: boolean;
  agentName?: string;
}) {
  return (
    <div
      className={
        inline
          ? "flex min-h-0 flex-1 items-center justify-center rounded-lg border bg-slate-950"
          : "flex h-full items-center justify-center p-6"
      }
    >
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <div className="relative flex size-12 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
          <TerminalSquare className="size-5" />
          <Loader2 className="absolute -right-1 -top-1 size-4 animate-spin rounded-full bg-background" />
        </div>
        <div>
          <p className="text-sm font-medium">
            Starting {agentName ?? "execution"}…
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Scheduling the workload and preparing its terminal. You can leave
            this page and come back.
          </p>
        </div>
      </div>
    </div>
  );
}
