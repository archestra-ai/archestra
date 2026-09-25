"use client";

import {
  isEditableTextFile,
  PROJECT_INSTRUCTIONS_FILENAME,
} from "@archestra/shared";
import {
  CalendarClock,
  Eye,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import {
  collapseProjectChats,
  countRunsByTrigger,
  formatScheduledRecentRow,
} from "@/app/projects/[id]/project-chats.utils";
import { ProjectSchedulesSection } from "@/app/projects/[id]/project-schedules-section";
import { runHref } from "@/app/projects/[id]/schedules/[triggerId]/run-row.utils";
import { AgentIcon } from "@/components/agent-icon";
import { Response } from "@/components/ai-elements/response";
import type { FileListItem } from "@/components/chat/file-list-section";
import { FilePreview } from "@/components/chat/file-preview";
import { NewChatComposer } from "@/components/chat/new-chat-composer";
import {
  INSTRUCTIONS_SELECTION,
  ProjectInstructionsPanel,
} from "@/components/chat/project-instructions";
import { ResizableRightPanel } from "@/components/chat/resizable-right-panel";
import { RunStateIcon } from "@/components/chat/run-state-icon";
import { SelectableFileList } from "@/components/chat/selectable-file-list";
import { CreatedByCell } from "@/components/created-by-cell";
import { FileDropZone } from "@/components/files/file-drop-zone";
import { FormDialog } from "@/components/form-dialog";
import { PageLayout } from "@/components/page-layout";
import { EditProjectDialog } from "@/components/projects/edit-project-dialog";
import { projectVisibilityToScope } from "@/components/projects/project-visibility";
import { QueryLoadError } from "@/components/query-load-error";
import { useResolveRunChat } from "@/components/scheduled-tasks/use-resolve-run-chat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useResourceOwnershipTransfer } from "@/components/use-resource-ownership-transfer";
import { useStartAgentRun } from "@/lib/agent-runtime.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useCreateConversation } from "@/lib/chat/chat.query";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";
import { setPendingChatHandoffFiles } from "@/lib/chat/pending-chat-handoff-files";
import { setPendingProjectChatHandoff } from "@/lib/chat/pending-project-chat-handoff";
import { useFileDeletion } from "@/lib/chat/use-file-deletion";
import { useDialogFlagUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import {
  canDeleteProject,
  canManageProject,
} from "@/lib/projects/project-permissions";
import {
  useDeleteProject,
  useDeleteProjectFiles,
  usePinProject,
  useProject,
  useProjectConversations,
  useProjectFiles,
  useProjectInstructions,
  useProjectRuns,
  useUploadProjectFiles,
} from "@/lib/projects/projects.query";
import { useScheduleTriggerRuns } from "@/lib/schedule-trigger.query";
import { sandboxArtifactUrl } from "@/lib/skills-sandbox/sandbox-file-preview";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { ProjectDeleteConfirmDialog } from "../project-delete-confirm-dialog";

export default function ProjectDetailPageClient() {
  return (
    <ErrorBoundary>
      <ProjectDetail />
    </ErrorBoundary>
  );
}

function ProjectDetail() {
  const isMobile = useIsMobile();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: project, isPending, isLoadingError, refetch } = useProject(id);
  const ownership = useResourceOwnershipTransfer({
    kind: "project",
    resource: project
      ? {
          ...project,
          authorId: project.createdBy?.id ?? null,
          scope: projectVisibilityToScope(project.visibility),
        }
      : null,
    onTransferred: () => router.push("/projects"),
  });
  // Chats are hidden from admin oversight, so don't even fetch them there.
  const { data: conversations } = useProjectConversations(id, {
    enabled: !!project && project.viewerRole !== "admin",
  });
  const { data: runs } = useProjectRuns(id, {
    enabled: !!project && project.viewerRole !== "admin",
  });
  const deleteProject = useDeleteProject();
  const pinProjectMutation = usePinProject();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { open: editOpen, setOpen: setEditOpen } =
    useDialogFlagUrlParam("edit");
  const { data: isProjectAdmin } = useHasPermissions(
    { project: ["update"] },
    "*",
  );

  // Same as /chat: the Files sidebar owns the bottom edge, so the app shell's
  // version footer would float in the left column — hide it.
  useEffect(() => {
    document.body.classList.add("hide-version");
    return () => document.body.classList.remove("hide-version");
  }, []);

  if (isPending) {
    return (
      <PageLayout title="Project" description="">
        {null}
      </PageLayout>
    );
  }
  if (isLoadingError) {
    return (
      <PageLayout title="Project" description="">
        <QueryLoadError
          title="Couldn't load this project"
          onRetry={() => refetch()}
        />
      </PageLayout>
    );
  }
  if (!project) {
    return (
      <PageLayout title="Project" description="">
        <p className="py-12 text-center text-sm text-muted-foreground">
          Project not found.
        </p>
      </PageLayout>
    );
  }

  // A project admin can manage ANY project they can see — their own, one shared
  // with them, or another member's they oversee (edit / delete / sharing /
  // instructions), matching the backend's requireManageable.
  const canManage = canManageProject(project.viewerRole, !!isProjectAdmin);
  const canDelete = canDeleteProject({
    viewerRole: project.viewerRole,
    isProjectAdmin: !!isProjectAdmin,
  });
  // The oversight-only view (a foreign project surfaced purely via project:admin)
  // additionally hides chats: no composer, no chats list, no pin, no new
  // schedules. A project merely shared with the admin keeps its chats.
  const isAdminView = project.viewerRole === "admin";
  const canChat = !isAdminView;

  return (
    // The same two-column shell as /chat: the page content scrolls in the left
    // column while the Files panel takes the full height of the right side.
    <div className="flex h-full w-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <PageLayout
          title={
            <span className="flex items-center gap-2">
              <AgentIcon icon={project.icon} fallbackType="project" size={22} />
              <span className="min-w-0 truncate">{project.name}</span>
            </span>
          }
          description={project.description ?? ""}
          actionButton={
            <div className="flex items-center gap-2">
              {isAdminView && (
                <Badge variant="secondary">
                  Viewing as administrator
                  {project.ownerName ? ` · ${project.ownerName}` : ""}
                </Badge>
              )}
              {/* The project has no facts row of its own, so its creator sits
                  in the header. Hidden in the admin view,
                  where the badge above already names the owner. */}
              {!isAdminView && (
                <CreatedByCell
                  createdBy={project.createdBy}
                  className="text-xs text-muted-foreground"
                />
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Project actions"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {!isAdminView && (
                    <DropdownMenuItem
                      onSelect={() =>
                        pinProjectMutation.mutate({
                          id: project.id,
                          pinned: !project.pinnedAt,
                        })
                      }
                    >
                      {project.pinnedAt ? (
                        <PinOff className="h-4 w-4" />
                      ) : (
                        <Pin className="h-4 w-4" />
                      )}
                      <span>{project.pinnedAt ? "Unpin" : "Pin"}</span>
                    </DropdownMenuItem>
                  )}
                  {canManage && (
                    <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                      <Pencil className="h-4 w-4" />
                      Edit details
                    </DropdownMenuItem>
                  )}
                  {ownership.menuItem}
                  {canManage && canDelete && (
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setConfirmDelete(true)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              {ownership.dialog}
            </div>
          }
        >
          {confirmDelete && (
            <ProjectDeleteConfirmDialog
              project={project}
              open={confirmDelete}
              onOpenChange={setConfirmDelete}
              isPending={deleteProject.isPending}
              onConfirm={async () => {
                const ok = await deleteProject.mutateAsync({ id: project.id });
                if (ok) router.push("/projects");
              }}
            />
          )}
          {editOpen && (
            <EditProjectDialog
              projectId={project.id}
              open={editOpen}
              onOpenChange={setEditOpen}
            />
          )}

          <div className="space-y-6">
            {canChat && (
              <ProjectChatInput
                projectId={project.id}
                defaultAgentId={project.defaultAgent?.id ?? null}
              />
            )}
            {isMobile && (
              <ProjectSchedulesSection
                projectId={project.id}
                canCreate={canChat}
                defaultAgentId={project.defaultAgent?.id ?? null}
              />
            )}
            {!isAdminView && <RunsList runs={runs ?? []} />}
            {!isAdminView && <ChatsList conversations={conversations ?? []} />}
          </div>
        </PageLayout>
      </div>

      {/* Right-side Files panel - desktop only, like the chat page */}
      {!isMobile && (
        <div className="hidden md:flex h-full min-h-0">
          <ProjectFilesSidebar
            projectId={project.id}
            canCreateSchedules={canChat}
            defaultAgentId={project.defaultAgent?.id ?? null}
            canManageProject={canManage}
            // Anyone with real project access (owner or shared) may edit its text
            // files; the admin-oversight view is read-only.
            canEditFiles={!isAdminView}
          />
        </div>
      )}
    </div>
  );
}

// === internal components ===

/**
 * The real /chat composer. Rather than route through an empty `/chat` (which
 * flashes the New Chat splash, then blanks again while it creates the chat over
 * the network and remounts at /chat/<id>), it creates the project chat up front
 * — the project page stays on screen during the request, and `useCreateConversation`
 * seeds the conversation cache so `/chat/<id>` renders without a load. The opening
 * message rides {@link setPendingProjectChatHandoff} across the single navigation,
 * where `/chat/<id>` sends it as the conversation's first message.
 */
function ProjectChatInput({
  projectId,
  defaultAgentId,
}: {
  projectId: string;
  defaultAgentId: string | null;
}) {
  const router = useRouter();
  const createConversation = useCreateConversation();
  const startRun = useStartAgentRun();
  const { data: projectFiles } = useProjectFiles(projectId);
  const projectHasFiles = (projectFiles?.length ?? 0) > 0;

  return (
    <NewChatComposer
      projectDefaultAgentId={defaultAgentId}
      isSubmitting={createConversation.isPending || startRun.isPending}
      onSubmit={({ text, agentId, modelId, apiKeyId, files, runtimeMode }) => {
        // Ignore a second submit while the first create is still in flight.
        if (createConversation.isPending || startRun.isPending) return;
        if (runtimeMode) {
          startRun.mutate(
            { agentId, message: text, files, projectId },
            {
              onSuccess: (run) => {
                if (run) {
                  router.push(`/chat/runs/${run.taskId}`);
                }
              },
            },
          );
          return;
        }
        setPendingChatHandoffFiles(files);
        createConversation.mutate(
          {
            agentId,
            modelId: modelId || undefined,
            chatApiKeyId: apiKeyId ?? undefined,
            projectId,
          },
          {
            onSuccess: (conversation) => {
              if (!conversation) return;
              // The opening prompt travels to /chat/<id>, which sends it (with
              // any attachments the composer stashed) as the first message.
              setPendingProjectChatHandoff({
                conversationId: conversation.id,
                prompt: text,
              });
              // Continuity with the project page: when the project already has
              // files, open the new chat with its Files panel showing. Persisted
              // per conversation, since /chat reads this on mount.
              if (projectHasFiles) {
                const keys = conversationStorageKeys(conversation.id);
                localStorage.setItem(keys.rightPanelOpen, "true");
                localStorage.setItem(keys.rightPanelTab, "files");
              }
              router.push(`/chat/${conversation.id}`);
            },
          },
        );
      }}
    />
  );
}

function RunsList({
  runs,
}: {
  runs: Array<{
    taskId: string;
    title: string;
    state: Parameters<typeof RunStateIcon>[0]["state"];
    stateChangedAt: string | null;
    startedAt: string;
    viewerRole: "owner" | "shared";
  }>;
}) {
  if (runs.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
        Runs
      </h2>
      <div className="space-y-2">
        {runs.map((run) => (
          <Link
            key={run.taskId}
            href={`/chat/runs/${run.taskId}`}
            className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <RunStateIcon state={run.state} className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {run.title}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {run.viewerRole === "owner" ? "Your run" : "Read-only run"}
              </span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatRelativeTimeFromNow(run.stateChangedAt ?? run.startedAt)}
            </span>
            <TerminalSquare className="size-4 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </section>
  );
}

// A Recents row for a schedule: keyed on the schedule's LATEST run (not the
// possibly-stale run this collapsed conversation was built from), so it stays in
// lockstep with the SCHEDULES section — a spinner while that run is running, and
// clicking it opens the current run's chat rather than the last completed one.
function ScheduledRecentRow({
  conv,
  scheduled,
}: {
  conv: {
    id: string;
    scheduleTriggerId: string | null;
    scheduleRunId: string | null;
    lastMessageAt: string;
  };
  scheduled: { title: string; meta: string };
}) {
  const router = useRouter();
  const { resolve, isResolving } = useResolveRunChat();
  const triggerId = conv.scheduleTriggerId;
  const { data: runsResponse } = useScheduleTriggerRuns(triggerId, {
    limit: 1,
    refetchInterval: (query) =>
      query.state.data?.data?.[0]?.status === "running" ? 3_000 : false,
  });
  const latestRun = runsResponse?.data?.[0];
  const isRunning = latestRun?.status === "running";

  const openLatestRun = () => {
    if (!triggerId) {
      router.push(`/chat/${conv.id}`);
      return;
    }
    const href = latestRun ? runHref({ triggerId, run: latestRun }) : null;
    if (href) {
      router.push(href);
    } else if (latestRun) {
      // Legacy run without a conversation: mint one, then open it.
      resolve(triggerId, latestRun.id);
    } else {
      // Runs not loaded yet — fall back to this row's own conversation.
      router.push(
        `/chat/${conv.id}?scheduleTriggerId=${triggerId}&scheduleRunId=${conv.scheduleRunId}`,
      );
    }
  };

  return (
    <button
      type="button"
      onClick={openLatestRun}
      disabled={isResolving}
      className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
        {isRunning ? (
          <Loader2
            className="h-4 w-4 animate-spin text-amber-500"
            aria-hidden
          />
        ) : (
          <CalendarClock className="h-4 w-4 text-primary" aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="truncate block text-sm font-medium">
          {scheduled.title}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {scheduled.meta}
        </span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {formatRelativeTimeFromNow(conv.lastMessageAt)}
      </span>
    </button>
  );
}

function ChatsList({
  conversations,
}: {
  conversations: Array<{
    id: string;
    title: string | null;
    authorName: string | null;
    /** Conversation origin; only `schedule_trigger` is special here. */
    origin: string;
    lastMessageAt: string;
    readOnly: boolean;
    scheduleTriggerId: string | null;
    scheduleRunId: string | null;
    scheduleName: string | null;
  }>;
}) {
  // A schedule's runs collapse to one row (its latest run); user chats are shown
  // as-is. Newest activity first.
  const chats = collapseProjectChats(conversations);
  const runCounts = countRunsByTrigger(conversations);
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
        Recents
      </h2>
      {chats.length === 0 ? (
        <p className="rounded-xl border px-3 py-8 text-center text-sm text-muted-foreground">
          No chats yet — type above to start one.
        </p>
      ) : (
        <div className="space-y-2">
          {chats.map((conv) => {
            if (conv.origin === "schedule_trigger") {
              const scheduled = formatScheduledRecentRow({
                scheduleName: conv.scheduleName,
                prompt: conv.title,
                runCount: conv.scheduleTriggerId
                  ? (runCounts.get(conv.scheduleTriggerId) ?? 0)
                  : 0,
              });
              return (
                <ScheduledRecentRow
                  key={conv.id}
                  conv={conv}
                  scheduled={scheduled}
                />
              );
            }
            return (
              <Link
                key={conv.id}
                href={`/chat/${conv.id}`}
                className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:bg-muted/50"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <MessageCircle className="h-4 w-4 text-primary" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {conv.title ?? "Untitled chat"}
                    </span>
                    {conv.readOnly && (
                      <Badge variant="outline" className="shrink-0 gap-1">
                        <Eye className="h-3 w-3" />
                        read-only
                      </Badge>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {conv.readOnly
                      ? `by ${conv.authorName ?? "someone else"}`
                      : "by you"}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatRelativeTimeFromNow(conv.lastMessageAt)}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * Project instructions, files, and schedules share a resizable sidebar.
 * Content opens in dialogs so the project overview stays in place.
 */
function ProjectFilesSidebar({
  projectId,
  canCreateSchedules,
  defaultAgentId,
  canManageProject,
  canEditFiles,
}: {
  projectId: string;
  canCreateSchedules: boolean;
  defaultAgentId: string | null;
  /** Owner / project-admin — gates editing the pinned instructions. */
  canManageProject: boolean;
  /** Real project access (owner/shared, not oversight) — gates editing files. */
  canEditFiles: boolean;
}) {
  const { data: files } = useProjectFiles(projectId);
  const { data: instructions } = useProjectInstructions(projectId);
  const uploadInput = useRef<HTMLInputElement>(null);
  const instructionsPreview = useRef<HTMLDivElement>(null);
  const [instructionsTruncated, setInstructionsTruncated] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const preview = instructionsPreview.current;
    if (!preview) return;
    const measure = () =>
      setInstructionsTruncated(
        !!instructions?.content?.trim() &&
          preview.scrollHeight > preview.clientHeight,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(preview);
    // The clamped box keeps its size while the markdown inside grows, so
    // watch the rendered content too.
    if (preview.firstElementChild) {
      observer.observe(preview.firstElementChild);
    }
    return () => observer.disconnect();
  }, [instructions?.content]);

  // The instructions file is surfaced only as the pinned entry, so keep it out
  // of the ordinary list (filtered from `items` below).
  const items: FileListItem[] = (files ?? [])
    .filter(
      (f) => f.downloadable && f.filename !== PROJECT_INSTRUCTIONS_FILENAME,
    )
    .map((f) => ({
      id: f.downloadRef,
      name: f.filename,
      mimeType: f.mimeType,
      contentUrl: sandboxArtifactUrl(f.downloadRef),
      // The real row id (null for a rowless hand-placed object) — gates editing.
      rowId: f.id,
    }));
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const instructionsSelected = selectedId === INSTRUCTIONS_SELECTION;
  const previewing = selected !== null || instructionsSelected;
  const detailName = instructionsSelected
    ? PROJECT_INSTRUCTIONS_FILENAME
    : (selected?.name ?? "");
  // Editable only for a row-backed .md/.txt file when the viewer has real project
  // access (the admin-oversight view is read-only, so `canEditFiles` is false).
  const selectedEditable =
    selected != null &&
    canEditFiles &&
    selected.rowId != null &&
    isEditableTextFile({
      filename: selected.name,
      mimeType: selected.mimeType,
    });

  const openFile = (id: string) => {
    setSelectedId(id);
    const file = items.find((item) => item.id === id);
    setEditing(
      id === INSTRUCTIONS_SELECTION
        ? canManageProject
        : !!file &&
            canEditFiles &&
            !!file.rowId &&
            isEditableTextFile({
              filename: file.name,
              mimeType: file.mimeType,
            }),
    );
  };
  const deselect = () => {
    setSelectedId(null);
    setEditing(false);
  };

  // If the open file disappears (e.g. deleted elsewhere), fall back to the list.
  const selectedMissing =
    selectedId !== null && !instructionsSelected && selected === null;
  useEffect(() => {
    if (selectedMissing) {
      setSelectedId(null);
      setEditing(false);
    }
  }, [selectedMissing]);

  // Every viewer of a project has project access, which the backend's artifact
  // delete authorizes — so file select/delete is available to anyone here (the
  // chat panel gates on conversation ownership; the project surface on access).
  const deleteProjectFiles = useDeleteProjectFiles(projectId);
  const uploadProjectFiles = useUploadProjectFiles(projectId);
  const { requestDelete, dialog: deleteDialog } = useFileDeletion<FileListItem>(
    {
      deleteItems: (toDelete) => deleteProjectFiles.mutateAsync(toDelete),
      describe: () =>
        "This file is part of the project and will be removed for everyone with access to it. This can't be undone.",
    },
  );

  return (
    <ResizableRightPanel>
      <FileDropZone
        onDropFiles={(droppedFiles) => uploadProjectFiles.mutate(droppedFiles)}
        uploading={uploadProjectFiles.isPending}
        className="flex-1 min-h-0 flex flex-col gap-0 overflow-hidden"
      >
        {/* Instructions keep their natural (clamped) height, schedules are
            capped, and the file list takes the rest with its own scroller — so
            a long file list never pushes schedules off-screen. */}
        <div className="flex flex-1 min-h-0 flex-col overflow-y-auto divide-y">
          <section className="shrink-0 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Instructions</h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label={
                  canManageProject ? "Edit instructions" : "View instructions"
                }
                onClick={() => openFile(INSTRUCTIONS_SELECTION)}
              >
                {canManageProject ? (
                  <Pencil className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
            <div className="relative rounded-md">
              <div
                ref={instructionsPreview}
                className="max-h-32 overflow-hidden break-words p-2 text-sm text-muted-foreground"
              >
                {instructions?.content?.trim() ? (
                  <Response className="[&_h1]:my-2 [&_h1]:text-base [&_h2]:my-2 [&_h2]:text-sm [&_h3]:my-1 [&_h3]:text-sm">
                    {instructions.content}
                  </Response>
                ) : (
                  <p>Add guidance for every chat in this project.</p>
                )}
              </div>
              {instructionsTruncated && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background" />
              )}
              {/* Rendered markdown can hold links and code-copy buttons, which
                  can't nest inside a button — so the whole preview is covered
                  by one transparent button that opens the full view. */}
              <button
                type="button"
                aria-label="Open instructions"
                className="absolute inset-0 rounded-md transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => openFile(INSTRUCTIONS_SELECTION)}
              />
            </div>
            {instructionsTruncated && (
              <Button
                variant="link"
                size="sm"
                className="h-auto px-2 py-0 text-xs text-foreground"
                onClick={() => openFile(INSTRUCTIONS_SELECTION)}
              >
                Show more
              </Button>
            )}
          </section>
          <section className="flex min-h-0 flex-col px-4 pt-3 pb-1">
            <div className="flex shrink-0 items-center justify-between">
              <h2 className="text-sm font-medium">Files</h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Upload files"
                disabled={uploadProjectFiles.isPending}
                onClick={() => uploadInput.current?.click()}
              >
                <Plus className="h-4 w-4" />
              </Button>
              <input
                ref={uploadInput}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  if (files.length) uploadProjectFiles.mutate(files);
                  event.target.value = "";
                }}
              />
            </div>
            {items.length === 0 ? (
              <p className="mb-3 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                Add files for your agent to use in this project.
              </p>
            ) : (
              <div className="-mx-3 -mt-1 flex min-h-0 flex-1 flex-col">
                <SelectableFileList<FileListItem>
                  sections={[{ items }]}
                  canManage
                  selectedId={selectedId}
                  onOpen={openFile}
                  onEdit={openFile}
                  canEdit={(file) =>
                    canEditFiles &&
                    !!file.rowId &&
                    isEditableTextFile({
                      filename: file.name,
                      mimeType: file.mimeType,
                    })
                  }
                  onRequestDelete={requestDelete}
                />
              </div>
            )}
          </section>
          <div className="max-h-[40%] shrink-0 overflow-y-auto p-4">
            <ProjectSchedulesSection
              projectId={projectId}
              canCreate={canCreateSchedules}
              defaultAgentId={defaultAgentId}
            />
          </div>
        </div>
      </FileDropZone>
      {previewing && (
        <FormDialog
          open
          onOpenChange={(open) => {
            if (!open) deselect();
          }}
          title={instructionsSelected ? "Instructions" : detailName}
          size="large"
        >
          {previewing && instructionsSelected ? (
            <ProjectInstructionsPanel
              projectId={projectId}
              isOwner={canManageProject}
              editing={editing}
              onExitEdit={deselect}
            />
          ) : previewing && selected ? (
            <FilePreview
              // Per-file key: drop any editor state when the previewed file changes.
              key={selected.id}
              file={selected}
              onClose={deselect}
              // Only row-backed files are editable; a rowless (obj_) object has
              // no `rowId`, so `selectedEditable` is false and Edit stays hidden.
              fileId={selected.rowId ?? undefined}
              editing={editing && selectedEditable}
              onExitEdit={deselect}
            />
          ) : null}
        </FormDialog>
      )}
      {deleteDialog}
    </ResizableRightPanel>
  );
}
