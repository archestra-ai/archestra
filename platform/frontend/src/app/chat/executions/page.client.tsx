"use client";

import {
  Bot,
  Copy,
  MoreHorizontal,
  Share2,
  Square,
  TerminalSquare,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { AgentExecutionLogs } from "@/components/agent-execution-logs";
import { AgentExecutionState } from "@/components/agent-execution-state";
import { AgentExecutionTerminal } from "@/components/agent-execution-terminal";
import { AgentIcon } from "@/components/agent-icon";
import { ShareAgentExecutionDialog } from "@/components/chat/share-agent-execution-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
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
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [connectionCommand, setConnectionCommand] = useState<string | null>(
    null,
  );
  const [liveTerminalTaskId, setLiveTerminalTaskId] = useState<string | null>(
    null,
  );
  const [commandCopied, setCommandCopied] = useState(false);
  const execution = query.data;

  // Metadata and the log stream are readable by shared viewers, but attaching
  // to the live terminal runs a shell under the owner's own credentials — so it
  // stays owner-only. Everyone else gets the read-only output stream.
  const isOwner = execution?.viewerRole === "owner";

  if (!query.isPending && !execution) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-lg">
          <TerminalNotice>
            Only the person who started this run can attach to it.
          </TerminalNotice>
        </div>
      </div>
    );
  }

  const live = !execution || execution.endedAt === null;
  const preserveLiveTerminal = isOwner && liveTerminalTaskId === taskId;
  const showLiveTerminal =
    (!execution && query.isPending) || (isOwner && live) || preserveLiveTerminal;

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
              {isOwner && live && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setStopDialogOpen(true)}
                >
                  <Square className="size-3.5 fill-current" />
                  <span>Stop</span>
                </Button>
              )}
              {isOwner && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShareDialogOpen(true)}
                >
                  <Share2 className="size-3.5" />
                  <span>Share</span>
                </Button>
              )}
              {isOwner && (
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
              )}
            </div>
          </>
        ) : null}
      </header>

      <section className="flex min-h-0 flex-1 flex-col p-4 md:p-6">
        {showLiveTerminal ? (
          <AgentExecutionTerminal
            taskId={taskId}
            active
            title={live ? "Live terminal" : "Output"}
            showManualCommand={false}
            showDisconnectedStatus={false}
            onCommandChange={(command) => {
              setConnectionCommand(command);
              if (command) setLiveTerminalTaskId(taskId);
            }}
            onClosed={() => void query.refetch()}
          />
        ) : execution ? (
          <>
            {live && (
              <TerminalNotice>
                Only the person who started this run can attach to it. You're
                viewing its terminal output in read-only mode.
              </TerminalNotice>
            )}
            <AgentExecutionLogs execution={execution} />
          </>
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
      <ShareAgentExecutionDialog
        taskId={taskId}
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
      />
      <StandardDialog
        open={connectionDialogOpen}
        onOpenChange={setConnectionDialogOpen}
        title="Terminal connection details"
        description="Attach to this execution from a shell with access to its cluster."
        className="max-w-3xl"
        bodyClassName="space-y-2"
      >
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
      </StandardDialog>
    </main>
  );
}

/**
 * An info line styled like the terminal box's own error/status messages
 * (`rounded-md border bg-slate-950`, red monospace) so access notices read as
 * part of the terminal surface instead of a mismatched page-level card.
 */
function TerminalNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-center rounded-md border bg-slate-950 p-4 text-center font-mono text-sm text-red-400">
      {children}
    </div>
  );
}
