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
import { useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "@/components/agent-icon";
import { AgentRunLiveness } from "@/components/agent-run-liveness";
import { AgentRunLogs } from "@/components/agent-run-logs";
import { AgentRunState } from "@/components/agent-run-state";
import { AgentRunTerminal } from "@/components/agent-run-terminal";
import { ShareAgentRunDialog } from "@/components/chat/share-agent-run-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExecTerminalStatus } from "@/components/exec/exec-terminal-progress";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCancelAgentRun, useMyAgentRun } from "@/lib/agent-runtime.query";
import { copyToClipboard } from "@/lib/clipboard";

export function AgentRunChatSession({ taskId }: { taskId: string }) {
  const query = useMyAgentRun(taskId);
  const cancelRun = useCancelAgentRun();
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
  const run = query.data;

  // Metadata and the log stream are readable by shared viewers, but attaching
  // to the live terminal runs a shell under the owner's own credentials — so it
  // stays owner-only. Everyone else gets the read-only output stream.
  const isOwner = run?.viewerRole === "owner";

  if (!query.isPending && !run) {
    // Sit in the same centered terminal-box placement the attach loader
    // ("Waiting for a node…") uses, but with only this access notice in place
    // of the loader's progress steps.
    return (
      <main className="flex h-full min-h-0 flex-col bg-background p-4 md:p-6">
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border bg-slate-950">
          <ExecTerminalStatus
            title="Terminal unavailable"
            detail="Only the person who started this run can attach to it."
          />
        </div>
      </main>
    );
  }

  const live = !run || run.endedAt === null;
  const preserveLiveTerminal = isOwner && liveTerminalTaskId === taskId;
  const showLiveTerminal =
    (!run && query.isPending) || (isOwner && live) || preserveLiveTerminal;

  return (
    <main className="flex h-full min-h-0 flex-col bg-background">
      {/* Keep this slot mounted while metadata loads so inserting the header
          cannot remount the terminal and restart its attach progress. */}
      <header
        className={
          run
            ? "flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3"
            : "hidden"
        }
      >
        {run ? (
          <>
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
                <AgentIcon icon={run.agent.icon} size={20} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-sm font-medium">{run.title}</h1>
                  <AgentRunState
                    state={run.state}
                    statusReason={run.statusReason}
                    lastModelActivityAt={run.lastModelActivityAt}
                    startedAt={run.startedAt}
                    endedAt={run.endedAt}
                    compact
                  />
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {run.agent.name}
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
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-8"
                      aria-label="More run actions"
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setShareDialogOpen(true)}>
                      <Share2 className="size-4" />
                      <span>Share</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link href={`/agents/${run.agent.id}?section=runs`}>
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

      <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 md:p-6">
        {run && live && <AgentRunLiveness run={run} />}
        {showLiveTerminal ? (
          <AgentRunTerminal
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
        ) : run ? (
          <>
            {live && (
              <div className="shrink-0 overflow-hidden rounded-md border bg-slate-950">
                <ExecTerminalStatus
                  title="Read-only terminal"
                  detail="Only the person who started this run can attach to it. You're viewing its terminal output in read-only mode."
                  compact
                />
              </div>
            )}
            <AgentRunLogs run={run} />
          </>
        ) : null}
      </section>
      <DeleteConfirmDialog
        open={stopDialogOpen}
        onOpenChange={setStopDialogOpen}
        title="Stop this run?"
        description="The Agent process will stop and its terminal output will be retained."
        isPending={cancelRun.isPending}
        confirmLabel="Stop run"
        pendingLabel="Stopping…"
        onConfirm={() =>
          cancelRun.mutate(taskId, {
            onSuccess: () => setStopDialogOpen(false),
          })
        }
      />
      <ShareAgentRunDialog
        taskId={taskId}
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
      />
      <StandardDialog
        open={connectionDialogOpen}
        onOpenChange={setConnectionDialogOpen}
        title="Terminal connection details"
        description="Attach to this run from a shell with access to its cluster."
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
