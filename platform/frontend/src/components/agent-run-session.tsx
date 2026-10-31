"use client";

import { formatDistance } from "date-fns";
import {
  Activity,
  Bot,
  Copy,
  History,
  Info,
  Loader2,
  type LucideIcon,
  Maximize2,
  MoreHorizontal,
  PanelRight,
  Play,
  Share2,
  Square,
  TerminalSquare,
  Trash2,
  Unplug,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "@/components/agent-icon";
import { AgentRunHeader } from "@/components/agent-run-header";
import { AgentRunLiveness } from "@/components/agent-run-liveness";
import {
  AgentRunDownloadMenuItems,
  AgentRunLogs,
  type AgentRunLogsHandle,
} from "@/components/agent-run-logs";
import { AgentRunState } from "@/components/agent-run-state";
import { AgentRunTerminal } from "@/components/agent-run-terminal";
import { ShareAgentRunDialog } from "@/components/chat/share-agent-run-dialog";
import { CopyableCode } from "@/components/copyable-code";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExecTerminalStatus } from "@/components/exec/exec-terminal-progress";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { WorkspaceRetention } from "@/components/workspace-retention";
import {
  useCancelAgentRun,
  useContinueAgentRun,
  useDeleteAgentWorkspace,
  useMyAgentRun,
} from "@/lib/agent-runtime.query";
import { useRuntimeClock } from "@/lib/agent-runtime-time";
import {
  useHasPermissions,
  useScopedCapabilities,
} from "@/lib/auth/auth.query";
import { copyToClipboard } from "@/lib/clipboard";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { llmSessionHref } from "@/lib/interactions/llm-log-links";
import { useProject } from "@/lib/projects/projects.query";

export function AgentRunChatSession({
  taskId,
  embedded = false,
  headerLeading,
  drawerFooter,
  initiatorName,
  detailsOpen = false,
  onDetailsOpenChange,
}: {
  taskId: string;
  embedded?: boolean;
  headerLeading?: ReactNode;
  drawerFooter?: ReactNode;
  initiatorName?: string;
  detailsOpen?: boolean;
  onDetailsOpenChange?: (open: boolean) => void;
}) {
  const logsRef = useRef<AgentRunLogsHandle>(null);
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
  const now = useRuntimeClock(true);

  // The trace link opens the run's LLM session (`llmSessionId`). It is shown
  // to the owner only, and `log:read` lets them open it. `sessionId` stays
  // the workspace and log-stream identity.
  const { data: canReadLogs } = useHasPermissions({ log: ["read"] });

  // The server separately permits managers of the owning service account
  // to attach without granting ownership actions.
  const isOwner = run?.viewerRole === "owner";
  const canAttach = run?.canAttach ?? isOwner;

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
    (canAttach && !showHistory && (live || (reattached && canReattach)));
  const canContinue =
    isOwner &&
    !live &&
    run?.workspace &&
    ["idle", "suspended"].includes(run.workspace.state) &&
    new Date(run.workspace.expiresAt).getTime() > now;
  const workspaceNotice = run?.workspace
    ? workspaceNoticeFor({
        state: run.workspace.state,
        canReattach,
        failed: run.state === "TASK_STATE_FAILED",
      })
    : null;

  const actions: {
    label: string;
    icon: LucideIcon;
    onSelect: () => void;
    disabled?: boolean;
    primary?: boolean;
    prominent?: boolean;
  }[] = [];
  if (canAttach && (live || (reattached && canReattach))) {
    actions.push({
      label: showHistory ? "Live terminal" : "Run history",
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
      prominent: true,
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

  const headerActions = run ? (
    <div
      className={
        embedded
          ? "flex w-full items-center gap-1 @3xl:w-auto @3xl:row-start-1 @3xl:col-start-2 @3xl:self-center"
          : "flex shrink-0 items-center gap-1"
      }
    >
      {embedded && (
        <div className="mr-2 min-w-0 flex-1 @3xl:hidden">{headerLeading}</div>
      )}
      {actions
        .filter((action) => action.primary || action.prominent)
        .map((action) => (
          <span key={action.label} className="inline-flex shrink-0">
            {(action.primary || action.prominent) && (
              <Button
                type="button"
                size="icon-sm"
                className="lg:hidden"
                variant={action.primary ? "default" : "outline"}
                aria-label={action.label}
                title={action.label}
                disabled={action.disabled}
                onClick={action.onSelect}
              >
                <action.icon
                  className={
                    action.disabled ? "size-3.5 animate-spin" : "size-3.5"
                  }
                />
              </Button>
            )}{" "}
            <Button
              key={action.label}
              size="sm"
              className={
                action.primary || action.prominent
                  ? "hidden lg:inline-flex"
                  : undefined
              }
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
            </Button>{" "}
          </span>
        ))}
      {(canAttach || canManageAccess || !showLiveTerminal) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
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
            <DropdownMenuItem
              onSelect={() => {
                void copyToClipboard(run.taskId).then(
                  () => toast.success("Run ID copied"),
                  () => toast.error("Could not copy run ID"),
                );
              }}
            >
              <Copy />
              <span>Copy run ID</span>
            </DropdownMenuItem>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground sm:hidden">
              Started{" "}
              {formatDistance(new Date(run.startedAt), now, {
                addSuffix: true,
              })}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {!showLiveTerminal && (
              <>
                <AgentRunDownloadMenuItems
                  onDownload={(kind) => logsRef.current?.download(kind)}
                  trajectoryDisabled={live}
                />
                <DropdownMenuSeparator />
              </>
            )}
            {actions
              .filter((action) => !action.primary && !action.prominent)
              .map((action) => (
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
            {actions.some((action) => !action.primary && !action.prominent) &&
              isOwner && <DropdownMenuSeparator />}
            {isOwner && (
              <>
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
                {canReadLogs && run.llmSessionId ? (
                  <DropdownMenuItem asChild>
                    <Link href={llmSessionHref(run.llmSessionId)}>
                      <Activity className="size-4" />
                      <span>View trace</span>
                    </Link>
                  </DropdownMenuItem>
                ) : null}
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
                      <span>Delete saved files</span>
                    </DropdownMenuItem>
                  )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {embedded && (
        <Button variant="ghost" size="icon-sm" asChild>
          <Link href={`/chat/runs/${activeTaskId}`} aria-label="Open full view">
            <Maximize2 />
          </Link>
        </Button>
      )}
      {embedded && (
        <Button
          variant={detailsOpen ? "secondary" : "ghost"}
          size="icon-sm"
          aria-label="Details"
          title="Details"
          aria-expanded={detailsOpen}
          onClick={() => onDetailsOpenChange?.(!detailsOpen)}
        >
          <PanelRight />
        </Button>
      )}
    </div>
  ) : null;

  return (
    <main className="@container flex h-full min-h-0 min-w-0 flex-col bg-background">
      {!embedded && <RunPageTitle title={run?.title ?? "Agent Runtime"} />}
      {/* Keep this slot mounted while metadata loads so inserting the header
          cannot remount the terminal and restart its attach progress. */}
      <div className="contents">
        {run ? (
          embedded ? (
            <header className="grid shrink-0 grid-cols-1 items-center gap-2 border-b px-4 py-3 @3xl:grid-cols-[minmax(0,1fr)_auto] @3xl:gap-x-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="hidden @3xl:block">{headerLeading}</div>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <h1 className="min-w-0 truncate text-sm font-medium">
                    {run.title}
                  </h1>
                  <span className="inline-flex shrink-0 text-xs [&_span]:text-xs">
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
                  </span>
                </div>
              </div>
              {headerActions}
            </header>
          ) : (
            <AgentRunHeader
              title={run.title}
              status={
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
              }
              agentName={run.agent.name}
              agentHref={`/agents/${run.agent.id}?section=runs`}
              agentImage={<AgentIcon icon={run.agent.icon} size={20} />}
              started={`Started ${formatDistance(new Date(run.startedAt), now, { addSuffix: true })}`}
              startedTitle={new Date(run.startedAt).toLocaleString()}
              actions={headerActions}
            />
          )
        ) : null}
      </div>
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 px-4 pt-3 pb-4 md:px-6 md:pb-6">
          {run && live && <AgentRunLiveness run={run} />}
          {isOwner && !live && run?.workspace && (
            <InlineNotice
              variant={run.state === "TASK_STATE_FAILED" ? "error" : "neutral"}
              role={run.state === "TASK_STATE_FAILED" ? "alert" : "status"}
              className="shrink-0"
            >
              {workspaceNotice && (
                <>
                  <Info aria-hidden />
                  <InlineNoticeText>{workspaceNotice}</InlineNoticeText>
                </>
              )}
              {run.workspace.state !== "deleted" && (
                <WorkspaceRetention expiresAt={run.workspace.expiresAt} />
              )}
            </InlineNotice>
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
              {live && !canAttach && (
                <div className="shrink-0 overflow-hidden rounded-md border bg-slate-950">
                  <ExecTerminalStatus
                    title="Read-only terminal"
                    detail="Only the person who started this run can attach to it. You're viewing its terminal output in read-only mode."
                    compact
                  />
                </div>
              )}
              <AgentRunLogs
                ref={logsRef}
                key={run.taskId}
                run={run}
                sessionId={isOwner ? run.sessionId : undefined}
              />
            </>
          ) : null}
        </section>
        {run && embedded && detailsOpen && (
          <aside
            aria-label="Run details"
            className="absolute inset-y-0 right-0 z-10 flex w-full min-h-0 shrink-0 flex-col border-l bg-background @3xl:static @3xl:w-64"
            onKeyDown={(event) => {
              if (event.key === "Escape") onDetailsOpenChange?.(false);
            }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <dl className="grid grid-cols-2 gap-x-3 gap-y-4 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Started by</dt>
                  <dd className="mt-1">
                    {initiatorName ?? (isOwner ? "You" : "Run owner")}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Started</dt>
                  <dd className="mt-1">
                    {formatDistance(new Date(run.startedAt), now, {
                      addSuffix: true,
                    })}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="mb-2 text-xs text-muted-foreground">Run ID</dt>
                  <dd>
                    <CopyableCode
                      value={run.taskId}
                      toastMessage="Run ID copied"
                    />
                  </dd>
                </div>
                {run.projectId && (
                  <div className="col-span-2">
                    <dt className="text-xs text-muted-foreground">Project</dt>
                    <dd className="mt-1">
                      <RunProjectLink projectId={run.projectId} />
                    </dd>
                  </div>
                )}
                {run.workspace && (
                  <div className="col-span-2">
                    <dt className="text-xs text-muted-foreground">Workspace</dt>
                    <dd className="mt-1">
                      {run.workspace.state === "suspended"
                        ? "Paused; saved files retained"
                        : run.workspace.state}
                    </dd>
                  </div>
                )}
              </dl>
              <section className="mt-5 space-y-3 border-t pt-4 text-xs leading-relaxed">
                <h3 className="text-sm font-medium">Access</h3>
                <p className="text-muted-foreground">
                  The run owner, Agent administrators, and shared viewers can
                  read output.
                  {run.projectId && (
                    <span>
                      {" "}
                      Project viewers also need permission to read all project
                      sessions.
                    </span>
                  )}
                </p>
                <p className="text-muted-foreground">
                  The owner can connect. Managers of an owning service account
                  also need Agent use access. Sharing and project visibility
                  grant read-only access.
                </p>
              </section>
            </div>
            {drawerFooter && (
              <footer className="shrink-0 border-t p-2">{drawerFooter}</footer>
            )}
          </aside>
        )}
      </div>
      <DeleteConfirmDialog
        open={stopDialogOpen}
        onOpenChange={setStopDialogOpen}
        title="Stop this run?"
        description="The Agent process will stop. Saved files and run history will be retained so you can continue later."
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
        title="Delete saved files?"
        description="This permanently removes this run's saved files. You cannot resume the run afterward. Run history remains available."
        confirmLabel="Delete saved files"
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
        description="Connect from a terminal with access to the Kubernetes cluster running this Agent."
        className="max-w-3xl"
        bodyClassName="space-y-2"
      >
        <p className="text-sm font-medium">
          {live ? "Manual attach command" : "Saved run shell command"}
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

function workspaceNoticeFor({
  state,
  canReattach,
  failed,
}: {
  state: string;
  canReattach: boolean;
  failed: boolean;
}): string | null {
  switch (state) {
    case "suspended":
      return failed
        ? "The run failed. Saved files are retained. Open Failed details for the reason, or select Resume to try again."
        : "Paused to save resources. Your files are saved. Select Resume to continue.";
    case "idle":
      return canReattach
        ? null
        : "Session ended; resume the saved conversation.";
    case "deleted":
      return "Saved files removed. Run history remains available.";
    default:
      return "The Agent is busy or changing state. Try again shortly.";
  }
}

function RunProjectLink({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  return (
    <Link
      className="underline underline-offset-4"
      href={`/projects/${projectId}`}
    >
      {project.data?.name ?? "View project"}
    </Link>
  );
}

function RunPageTitle({ title }: { title: string }) {
  usePageTitle(title);
  return null;
}
