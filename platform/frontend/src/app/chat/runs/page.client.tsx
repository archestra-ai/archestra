"use client";

import {
  Bot,
  Copy,
  History,
  Info,
  Loader2,
  type LucideIcon,
  MoreHorizontal,
  Play,
  Share2,
  Square,
  TerminalSquare,
  Trash2,
  Unplug,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkspaceRetention } from "@/components/workspace-retention";
import {
  useCancelAgentRun,
  useContinueAgentRun,
  useDeleteAgentWorkspace,
  useMyAgentRun,
} from "@/lib/agent-runtime.query";
import { useRuntimeClock } from "@/lib/agent-runtime-time";
import { useScopedCapabilities } from "@/lib/auth/auth.query";
import { copyToClipboard } from "@/lib/clipboard";
import { usePageTitle } from "@/lib/hooks/use-page-title";

export function AgentRunChatSession({ taskId }: { taskId: string }) {
  const [resumedRun, setResumedRun] = useState<{
    sourceId: string;
    taskId: string;
  } | null>(null);
  const activeTaskId =
    resumedRun?.sourceId === taskId ? resumedRun.taskId : taskId;
  const query = useMyAgentRun(activeTaskId);
  const continuation = useContinueAgentRun();
  const capabilities = useScopedCapabilities();
  const canManageAccess = capabilities.data?.some(
    (grant) =>
      grant.resource === "agentRun" &&
      grant.action === "manage-permissions" &&
      (grant.scope === taskId || grant.scope === "*"),
  );
  const cancelRun = useCancelAgentRun();
  const deleteWorkspace = useDeleteAgentWorkspace();
  const [deleteWorkspaceDialogOpen, setDeleteWorkspaceDialogOpen] =
    useState(false);
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const [reattachedTaskId, setReattachedTaskId] = useState<string | null>(null);
  const reattached = reattachedTaskId === taskId;
  const [showHistory, setShowHistory] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [connectionCommand, setConnectionCommand] = useState<string | null>(
    null,
  );
  const [commandCopied, setCommandCopied] = useState(false);
  const [portCommandCopied, setPortCommandCopied] = useState(false);
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
            detail="This run could not be loaded. It may have failed to start, been removed, or you may not have access."
          />
        </div>
      </main>
    );
  }

  const live = !run || run.endedAt === null;
  const availableConnectionCommand = live
    ? connectionCommand
    : run?.workspace?.connection?.shellCommand;
  const portForwardCommand = run?.portForwardCommand;
  const canReattach = Boolean(isOwner && run?.terminalRetained);
  const showLiveTerminal =
    (!run && query.isPending) ||
    (isOwner && !showHistory && (live || (reattached && canReattach)));
  const canContinue =
    isOwner &&
    !live &&
    run?.workspace &&
    ["idle", "suspended"].includes(run.workspace.state) &&
    new Date(run.workspace.expiresAt).getTime() > now;
  const workspaceNotice = run?.workspace
    ? workspaceNoticeFor(run.workspace.state, canReattach)
    : null;

  const actions: {
    label: string;
    icon: LucideIcon;
    onSelect: () => void;
    disabled?: boolean;
    primary?: boolean;
  }[] = [];
  if (isOwner && (live || (reattached && canReattach))) {
    actions.push({
      label: showHistory ? "Live terminal" : "Session history",
      icon: History,
      onSelect: () => setShowHistory(!showHistory),
    });
  }
  if (canContinue && !showLiveTerminal) {
    actions.push({
      label: continuation.isPending ? "Resuming…" : "Resume",
      icon: continuation.isPending ? Loader2 : Play,
      disabled: continuation.isPending,
      primary: true,
      onSelect: () => {
        if (canReattach) {
          setReattachedTaskId(taskId);
          setShowHistory(false);
          return;
        }
        continuation.mutate(
          { taskId: activeTaskId },
          {
            onSuccess: (result) => {
              if (!result) return;
              // Follow the accepted turn, not the session's stale completed snapshot.
              setResumedRun({ sourceId: taskId, taskId: result.taskId });
              setShowHistory(false);
            },
          },
        );
      },
    });
  }
  if (reattached && showLiveTerminal) {
    actions.push({
      label: "Detach",
      icon: Unplug,
      onSelect: () => setReattachedTaskId(null),
    });
  }
  if (isOwner && live) {
    actions.push({
      label: "Stop",
      icon: Square,
      onSelect: () => setStopDialogOpen(true),
    });
  }
  if (!isOwner && canManageAccess) {
    actions.push({
      label: "Permissions",
      icon: Share2,
      onSelect: () => setShareDialogOpen(true),
    });
  }

  return (
    <main className="@container flex h-full min-h-0 flex-col bg-background">
      {/* Keep this slot mounted while metadata loads so inserting the header
          cannot remount the terminal and restart its attach progress. */}
      <header
        className={
          run
            ? "flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 @2xl:px-5"
            : "hidden"
        }
      >
        {run ? (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="hidden size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40 @2xl:flex">
                <AgentIcon icon={run.agent.icon} size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h1 className="min-w-0 basis-full truncate text-sm font-medium @2xl:basis-auto">
                    {run.title}
                  </h1>
                  <AgentRunState
                    state={run.state}
                    attentionState={run.attentionState}
                    statusReason={run.statusReason}
                    lastModelActivityAt={run.lastModelActivityAt}
                    startedAt={run.startedAt}
                    endedAt={run.endedAt}
                    hardDeadlineAt={run.hardDeadlineAt}
                    terminalRetained={run.terminalRetained}
                    workspace={run.workspace}
                    compact
                  />
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {run.agent.name}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <div className="hidden items-center gap-2 @2xl:flex">
                {actions.map((action) => (
                  <Button
                    key={action.label}
                    size="sm"
                    variant={action.primary ? "default" : "outline"}
                    disabled={action.disabled}
                    onClick={action.onSelect}
                  >
                    <action.icon
                      className={
                        action.disabled ? "size-3.5 animate-spin" : "size-3.5"
                      }
                    />
                    <span>{action.label}</span>
                  </Button>
                ))}
              </div>
              {(isOwner || canManageAccess) && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-8"
                      aria-label="More run actions"
                    >
                      {continuation.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <MoreHorizontal className="size-4" />
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {actions.map((action) => (
                      <DropdownMenuItem
                        key={action.label}
                        disabled={action.disabled}
                        onSelect={action.onSelect}
                      >
                        <action.icon
                          className={
                            action.disabled ? "size-4 animate-spin" : "size-4"
                          }
                        />
                        <span>{action.label}</span>
                      </DropdownMenuItem>
                    ))}
                    {actions.length > 0 && isOwner && <DropdownMenuSeparator />}
                    {isOwner && (
                      <>
                        <DropdownMenuItem
                          onSelect={() => setShareDialogOpen(true)}
                        >
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
                              onSelect={() =>
                                setDeleteWorkspaceDialogOpen(true)
                              }
                            >
                              <Trash2 className="size-4" />
                              <span>Delete workspace</span>
                            </DropdownMenuItem>
                          )}
                      </>
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
            {workspaceNotice && (
              <div className="flex min-w-0 items-start gap-2 sm:items-center">
                <Info
                  aria-hidden
                  className="mt-0.5 size-3.5 shrink-0 sm:mt-0"
                />
                <span className="font-medium text-foreground">
                  {workspaceNotice}
                </span>
              </div>
            )}
            {run.workspace.state !== "deleted" && (
              <WorkspaceRetention expiresAt={run.workspace.expiresAt} />
            )}
          </output>
        )}
        {showLiveTerminal ? (
          <AgentRunTerminal
            taskId={run?.taskId ?? activeTaskId}
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
            {live && !isOwner && (
              <div className="shrink-0 overflow-hidden rounded-md border bg-slate-950">
                <ExecTerminalStatus
                  title="Read-only terminal"
                  detail="Only the person who started this run can attach to it. You're viewing its terminal output in read-only mode."
                  compact
                />
              </div>
            )}
            <AgentRunLogs
              key={run.taskId}
              run={run}
              sessionId={isOwner ? run.sessionId : undefined}
            />
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
          cancelRun.mutate(activeTaskId, {
            onSuccess: () => setStopDialogOpen(false),
          })
        }
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
        taskId={run?.taskId ?? activeTaskId}
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
        {portForwardCommand && (
          <>
            <p className="pt-2 text-sm font-medium">Port forwarding command</p>
            <div className="flex flex-col gap-3 rounded-md border bg-slate-950 p-3 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 break-all font-mono text-xs text-emerald-400">
                {portForwardCommand}
              </code>
              <Button
                className="shrink-0 self-end sm:self-auto"
                variant="outline"
                size="sm"
                aria-label="Copy port forwarding command"
                onClick={async () => {
                  try {
                    await copyToClipboard(portForwardCommand);
                    setPortCommandCopied(true);
                    toast.success("Port forwarding command copied");
                    setTimeout(() => setPortCommandCopied(false), 2000);
                  } catch {
                    toast.error("Failed to copy port forwarding command");
                  }
                }}
              >
                <Copy className="size-3.5" />
                <span>{portCommandCopied ? "Copied!" : "Copy"}</span>
              </Button>
            </div>
          </>
        )}
      </StandardDialog>
    </main>
  );
}

function workspaceNoticeFor(
  state: string,
  canReattach: boolean,
): string | null {
  switch (state) {
    case "suspended":
      return "Workspace suspended; saved files are retained.";
    case "idle":
      return canReattach
        ? null
        : "Session ended; resume the saved conversation.";
    case "deleted":
      return "Workspace removed. Run history remains available.";
    default:
      return "Workspace is in use or changing state.";
  }
}
