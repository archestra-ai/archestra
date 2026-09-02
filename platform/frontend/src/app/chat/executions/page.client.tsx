"use client";

import {
  Bot,
  Copy,
  MoreHorizontal,
  Square,
  TerminalSquare,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { AgentExecutionLogs } from "@/components/agent-execution-logs";
import { AgentExecutionState } from "@/components/agent-execution-state";
import { AgentExecutionTerminal } from "@/components/agent-execution-terminal";
import { AgentIcon } from "@/components/agent-icon";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useCancelAgentExecution,
  useMyAgentExecution,
} from "@/lib/agent-background-execution.query";
import { copyToClipboard } from "@/lib/clipboard";

export function BackgroundExecutionChatSession({ taskId }: { taskId: string }) {
  const query = useMyAgentExecution(taskId);
  const cancelExecution = useCancelAgentExecution();
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [connectionCommand, setConnectionCommand] = useState<string | null>(
    null,
  );
  const [commandCopied, setCommandCopied] = useState(false);
  const execution = query.data;

  if (!query.isPending && !execution) {
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

  const live = !execution || execution.endedAt === null;

  return (
    <main className="flex h-full min-h-0 flex-col bg-background">
      {/* Keep this slot mounted while metadata loads so inserting the header
          cannot remount the terminal and restart its attach progress. */}
      <header
        className={
          execution
            ? "flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3"
            : "hidden"
        }
      >
        {execution ? (
          <>
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
                  <span>Stop</span>
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    aria-label="More execution actions"
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <Link
                      href={`/agents/${execution.agent.id}?section=executions`}
                    >
                      <Bot className="size-4" />
                      <span>View Agent</span>
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!connectionCommand}
                    onSelect={() => setConnectionDialogOpen(true)}
                  >
                    <TerminalSquare className="size-4" />
                    <span>View connection details</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        ) : null}
      </header>

      <section className="flex min-h-0 flex-1 flex-col p-4 md:p-6">
        {live ? (
          <AgentExecutionTerminal
            taskId={taskId}
            active
            title="Live terminal"
            showManualCommand={false}
            showDisconnectedStatus={false}
            onCommandChange={setConnectionCommand}
            onClosed={() => void query.refetch()}
          />
        ) : execution ? (
          <AgentExecutionLogs execution={execution} />
        ) : null}
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
      <Dialog
        open={connectionDialogOpen}
        onOpenChange={setConnectionDialogOpen}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Terminal connection details</DialogTitle>
            <DialogDescription>
              Attach to this execution from a shell with access to its cluster.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-2">
            <p className="text-sm font-medium">Manual attach command</p>
            <div className="flex flex-col gap-3 rounded-md border bg-slate-950 p-3 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 break-all font-mono text-xs text-emerald-400">
                {connectionCommand}
              </code>
              <Button
                className="shrink-0 self-end sm:self-auto"
                variant="outline"
                size="sm"
                aria-label="Copy terminal command"
                onClick={async () => {
                  if (!connectionCommand) return;
                  try {
                    await copyToClipboard(connectionCommand);
                    setCommandCopied(true);
                    toast.success("Terminal command copied");
                    setTimeout(() => setCommandCopied(false), 2000);
                  } catch {
                    toast.error("Failed to copy terminal command");
                  }
                }}
              >
                <Copy className="size-3.5" />
                <span>{commandCopied ? "Copied!" : "Copy"}</span>
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function executionLoadErrorDescription(error: unknown): string | undefined {
  if (error instanceof Error && error.message === "Execution not found") {
    return "This execution no longer exists, or you no longer have access to it.";
  }
  return undefined;
}
