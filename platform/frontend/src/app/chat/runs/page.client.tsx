"use client";

import {
  Bot,
  Copy,
  Info,
  MoreHorizontal,
  Share2,
  Square,
  TerminalSquare,
  Trash2,
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
import { ContinueAgentRunDialog } from "@/components/continue-agent-run-dialog";
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
import { WorkspaceRetention } from "@/components/workspace-retention";
import {
  useCancelAgentRun,
  useDeleteAgentWorkspace,
  useMyAgentRun,
} from "@/lib/agent-runtime.query";
import { useRuntimeClock } from "@/lib/agent-runtime-time";
import { copyToClipboard } from "@/lib/clipboard";
import { usePageTitle } from "@/lib/hooks/use-page-title";

export function AgentRunChatSession({ taskId }: { taskId: string }) {
  const query = useMyAgentRun(taskId);
  const cancelRun = useCancelAgentRun();
  const deleteWorkspace = useDeleteAgentWorkspace();
  const [deleteWorkspaceDialogOpen, setDeleteWorkspaceDialogOpen] =
    useState(false);
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const [continueDialogOpen, setContinueDialogOpen] = useState(false);
  const [reattachedTaskId, setReattachedTaskId] = useState<string | null>(null);
  const reattached = reattachedTaskId === taskId;
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [connectionCommand, setConnectionCommand] = useState<string | null>(
    null,
  );
  const [commandCopied, setCommandCopied] = useState(false);
  const run = query.data;
  usePageTitle(run?.title ?? "Agent Runtime");
  const now = useRuntimeClock(Boolean(run?.workspace));

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
  const availableConnectionCommand = live
    ? connectionCommand
    : run?.workspace?.connection?.shellCommand;
  const canReattach = Boolean(isOwner && run?.workspace?.terminalAvailable);
  const showLiveTerminal =
    (!run && query.isPending) ||
    (isOwner && (live || (reattached && canReattach)));
  const canContinue =
    isOwner &&
    !live &&
    run?.workspace &&
    ["idle", "suspended"].includes(run.workspace.state) &&
    new Date(run.workspace.expiresAt).getTime() > now;

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
              {canContinue && !showLiveTerminal && (
                <Button
                  size="sm"
                  onClick={() =>
                    canReattach
                      ? setReattachedTaskId(taskId)
                      : setContinueDialogOpen(true)
                  }
                >
                  <span>
                    {canReattach ? "Continue" : "Resume conversation"}
                  </span>
                </Button>
              )}
              {reattached && showLiveTerminal && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setReattachedTaskId(null)}
                >
                  <span>Detach</span>
                </Button>
              )}
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
                      disabled={!availableConnectionCommand}
                      onSelect={() => setConnectionDialogOpen(true)}
                    >
                      <TerminalSquare className="size-4" />
                      <span>View connection details</span>
                    </DropdownMenuItem>
                    {run.workspace &&
                      ["idle", "suspended", "deleting"].includes(
                        run.workspace.state,
                      ) && (
                        <DropdownMenuItem
                          onSelect={() => setDeleteWorkspaceDialogOpen(true)}
                        >
                          <Trash2 className="size-4" />
                          <span>Delete workspace</span>
                        </DropdownMenuItem>
                      )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </>
        ) : null}
      </header>

      <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 md:p-6">
        {run && live && <AgentRunLiveness run={run} />}
        {isOwner && !live && run?.workspace && (
          <output className="flex shrink-0 flex-col gap-2 rounded-md border bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-2 sm:items-center">
              <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 sm:mt-0" />
              <span className="font-medium text-foreground">
                {run.workspace.state === "suspended"
                  ? "Workspace suspended; saved files are retained."
                  : run.workspace.state === "idle"
                    ? canReattach
                      ? "Session running; Continue reopens its terminal."
                      : "Session ended; resume the saved conversation."
                    : run.workspace.state === "deleted"
                      ? "Workspace removed. Run history remains available."
                      : "Workspace is in use or changing state."}
              </span>
            </div>
            {run.workspace.state !== "deleted" && (
              <WorkspaceRetention expiresAt={run.workspace.expiresAt} />
            )}
          </output>
        )}
        {showLiveTerminal ? (
          <AgentRunTerminal
            taskId={taskId}
            active
            title={live ? "Live terminal" : "Output"}
            showManualCommand={false}
            showDisconnectedStatus={false}
            onCommandChange={setConnectionCommand}
            onError={() => {
              setReattachedTaskId(null);
              void query.refetch();
            }}
            onClosed={() => {
              setReattachedTaskId(null);
              void query.refetch();
            }}
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
        description="The Agent process will stop. Its workspace, saved files, and run history will be retained so you can continue later."
        isPending={cancelRun.isPending}
        confirmLabel="Stop run"
        pendingLabel="Stopping…"
        onConfirm={() =>
          cancelRun.mutate(taskId, {
            onSuccess: () => setStopDialogOpen(false),
          })
        }
      />
      <ContinueAgentRunDialog
        taskId={taskId}
        open={continueDialogOpen}
        onOpenChange={setContinueDialogOpen}
      />
      <DeleteConfirmDialog
        open={deleteWorkspaceDialogOpen}
        onOpenChange={setDeleteWorkspaceDialogOpen}
        title="Delete this workspace?"
        description="This permanently removes the development environment and all its files. You cannot continue it afterward. Saved run transcripts remain available."
        confirmLabel="Delete workspace"
        isPending={deleteWorkspace.isPending}
        onConfirm={() =>
          deleteWorkspace.mutate(taskId, {
            onSuccess: () => setDeleteWorkspaceDialogOpen(false),
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
        description="Connect from a terminal with access to this workspace's cluster."
        className="max-w-3xl"
        bodyClassName="space-y-2"
      >
        <p className="text-sm font-medium">
          {live ? "Manual attach command" : "Workspace shell command"}
        </p>
        <div className="flex flex-col gap-3 rounded-md border bg-slate-950 p-3 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 break-all font-mono text-xs text-emerald-400">
            {availableConnectionCommand}
          </code>
          <Button
            className="shrink-0 self-end sm:self-auto"
            variant="outline"
            size="sm"
            aria-label="Copy terminal command"
            onClick={async () => {
              if (!availableConnectionCommand) return;
              try {
                await copyToClipboard(availableConnectionCommand);
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
