"use client";

import {
  isEditableTextFile,
  PROJECT_INSTRUCTIONS_FILENAME,
} from "@archestra/shared";
import {
  CalendarClock,
  Download,
  Eye,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import {
  collapseProjectChats,
  countRunsByTrigger,
  formatScheduledRecentRow,
} from "@/app/projects/[id]/project-chats.utils";
import { ProjectSchedulesSection } from "@/app/projects/[id]/project-schedules-section";
import { AgentIcon } from "@/components/agent-icon";
import { FileDetailHeader } from "@/components/chat/file-detail-header";
import type { FileListItem } from "@/components/chat/file-list-section";
import { FilePreview } from "@/components/chat/file-preview";
import { NewChatComposer } from "@/components/chat/new-chat-composer";
import {
  INSTRUCTIONS_SELECTION,
  InstructionsRow,
  ProjectInstructionsPanel,
} from "@/components/chat/project-instructions";
import { ResizableRightPanel } from "@/components/chat/resizable-right-panel";
import { SelectableFileList } from "@/components/chat/selectable-file-list";
import { FileDropZone } from "@/components/files/file-drop-zone";
import { PageLayout } from "@/components/page-layout";
import { EditProjectDialog } from "@/components/projects/edit-project-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useCreateConversation } from "@/lib/chat/chat.query";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";
import { setPendingProjectChatHandoff } from "@/lib/chat/pending-project-chat-handoff";
import { useFileDeletion } from "@/lib/chat/use-file-deletion";
import { canManageProject } from "@/lib/projects/project-permissions";
import {
  useDeleteProject,
  useDeleteProjectFiles,
  usePinProject,
  useProject,
  useProjectConversations,
  useProjectFiles,
  useUploadProjectFiles,
} from "@/lib/projects/projects.query";
import { sandboxArtifactUrl } from "@/lib/skills-sandbox/sandbox-file-preview";
import { cn } from "@/lib/utils";
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
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: project, isPending, isLoadingError, refetch } = useProject(id);
  // Chats are hidden from admin oversight, so don't even fetch them there.
  const { data: conversations } = useProjectConversations(id, {
    enabled: !!project && project.viewerRole !== "admin",
  });
  const deleteProject = useDeleteProject();
  const pinProjectMutation = usePinProject();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const { data: isProjectAdmin } = useHasPermissions({ project: ["admin"] });

  // Same as /chat: the Files sidebar owns the bottom edge, so the app shell's
  // version footer would float in the left column — hide it.
  useEffect(() => {
    document.body.classList.add("hide-version");
    return () => document.body.classList.remove("hide-version");
  }, []);

  if (isPending) {
    return (
      <PageLayout title="Project" description="">
        <p className="py-12 text-center text-sm text-muted-foreground">
          Loading…
        </p>
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
                      {project.pinnedAt ? "Unpin" : "Pin"}
                    </DropdownMenuItem>
                  )}
                  {canManage && (
                    <>
                      <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                        <Pencil className="h-4 w-4" />
                        Edit details
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setConfirmDelete(true)}
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
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
            {canChat && <ProjectChatInput projectId={project.id} />}
            <ProjectSchedulesSection
              projectId={project.id}
              canCreate={canChat}
            />
            {!isAdminView && <ChatsList conversations={conversations ?? []} />}
          </div>
        </PageLayout>
      </div>

      {/* Right-side Files panel - desktop only, like the chat page */}
      <div className="hidden md:flex h-full min-h-0">
        <ProjectFilesSidebar
          projectId={project.id}
          canManageProject={canManage}
          // Anyone with real project access (owner or shared) may edit its text
          // files; the admin-oversight view is read-only.
          canEditFiles={!isAdminView}
        />
      </div>
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
function ProjectChatInput({ projectId }: { projectId: string }) {
  const router = useRouter();
  const createConversation = useCreateConversation();
  const { data: projectFiles } = useProjectFiles(projectId);
  const projectHasFiles = (projectFiles?.length ?? 0) > 0;

  return (
    <NewChatComposer
      onSubmit={({ text, agentId, modelId, apiKeyId }) => {
        // Ignore a second submit while the first create is still in flight.
        if (createConversation.isPending) return;
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

function ChatsList({
  conversations,
}: {
  conversations: Array<{
    id: string;
    title: string | null;
    authorName: string | null;
    origin: "user" | "schedule_trigger";
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
            const isScheduled = conv.origin === "schedule_trigger";
            const scheduled = isScheduled
              ? formatScheduledRecentRow({
                  scheduleName: conv.scheduleName,
                  prompt: conv.title,
                  runCount: conv.scheduleTriggerId
                    ? (runCounts.get(conv.scheduleTriggerId) ?? 0)
                    : 0,
                })
              : null;
            // A scheduled row opens its latest run's chat WITH the schedule
            // context, so the chat sidebar shows the runs navigator for the rest.
            const href = isScheduled
              ? `/chat/${conv.id}?scheduleTriggerId=${conv.scheduleTriggerId}&scheduleRunId=${conv.scheduleRunId}`
              : `/chat/${conv.id}`;
            return (
              <Link
                key={conv.id}
                href={href}
                className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:bg-muted/50"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  {isScheduled ? (
                    <CalendarClock
                      className="h-4 w-4 text-primary"
                      aria-hidden
                    />
                  ) : (
                    <MessageCircle
                      className="h-4 w-4 text-primary"
                      aria-hidden
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {scheduled
                        ? scheduled.title
                        : (conv.title ?? "Untitled chat")}
                    </span>
                    {conv.readOnly && (
                      <Badge variant="outline" className="shrink-0 gap-1">
                        <Eye className="h-3 w-3" />
                        read-only
                      </Badge>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {scheduled
                      ? scheduled.meta
                      : conv.readOnly
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
 * The project's files as a full-height right sidebar — the same resizable shell
 * and stacked list-over-preview body as the chat-page Files panel, minus the tab
 * header: Files is the only view here, and the project name already shows in the
 * page title, so both are dropped.
 */
function ProjectFilesSidebar({
  projectId,
  canManageProject,
  canEditFiles,
}: {
  projectId: string;
  /** Owner / project-admin — gates editing the pinned instructions. */
  canManageProject: boolean;
  /** Real project access (owner/shared, not oversight) — gates editing files. */
  canEditFiles: boolean;
}) {
  const { data: files } = useProjectFiles(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The selected file's in-place editor is open. Lifted here so the Edit toggle
  // can sit in the action row next to Download/Delete.
  const [editing, setEditing] = useState(false);
  // Opening a file shows it below the list (split); `expanded` fills the panel.
  const [expanded, setExpanded] = useState(false);

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
    // Files and instructions both open in the read view; editing is entered
    // explicitly via the Edit affordance in the action row.
    setEditing(false);
    setExpanded(false);
  };
  const collapse = () => setExpanded(false);
  const deselect = () => {
    setSelectedId(null);
    setEditing(false);
    setExpanded(false);
  };

  // If the open file disappears (e.g. deleted elsewhere), fall back to the list.
  const selectedMissing =
    selectedId !== null && !instructionsSelected && selected === null;
  useEffect(() => {
    if (selectedMissing) {
      setSelectedId(null);
      setEditing(false);
      setExpanded(false);
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
        disabled={uploadProjectFiles.isPending}
        className="flex-1 min-h-0 flex flex-col gap-0"
      >
        <div className="flex-1 min-h-0 overflow-hidden relative">
          <div className="flex h-full flex-col">
            {/* The list fills the panel when nothing is open, is capped above
                the preview in the split, and is hidden when expanded. Kept
                mounted so an in-progress multi-selection survives previewing. */}
            <div
              className={cn(
                "flex flex-col",
                previewing
                  ? expanded
                    ? "hidden"
                    : "max-h-[45%] shrink-0 overflow-hidden border-b"
                  : "min-h-0 flex-1",
              )}
            >
              <SelectableFileList<FileListItem>
                sections={[{ items }]}
                canManage
                selectedId={selectedId}
                onOpen={openFile}
                onRequestDelete={requestDelete}
                leading={
                  <InstructionsRow
                    selected={instructionsSelected}
                    onSelect={() => openFile(INSTRUCTIONS_SELECTION)}
                  />
                }
              />
            </div>
            {previewing && (
              <FileDetailHeader
                title={detailName}
                expanded={expanded}
                onExpand={() => setExpanded(true)}
                onCollapse={collapse}
              >
                {instructionsSelected && canManageProject && !editing && (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    title="Edit instructions"
                    className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Pencil className="h-4 w-4" />
                    <span className="sr-only">Edit instructions</span>
                  </button>
                )}
                {selected && !instructionsSelected && (
                  <div className="flex shrink-0 items-center">
                    {selected.contentUrl && (
                      <a
                        href={selected.contentUrl}
                        download={selected.name}
                        title={`Download ${selected.name}`}
                        className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Download className="h-4 w-4" />
                        <span className="sr-only">
                          Download {selected.name}
                        </span>
                      </a>
                    )}
                    {selectedEditable && !editing && (
                      <button
                        type="button"
                        onClick={() => setEditing(true)}
                        title={`Edit ${selected.name}`}
                        className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Pencil className="h-4 w-4" />
                        <span className="sr-only">Edit {selected.name}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        requestDelete([selected], (failedIds) => {
                          if (!failedIds.includes(selected.id)) deselect();
                        })
                      }
                      title={`Delete ${selected.name}`}
                      className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                      <span className="sr-only">Delete {selected.name}</span>
                    </button>
                  </div>
                )}
              </FileDetailHeader>
            )}
            {previewing && instructionsSelected ? (
              <ProjectInstructionsPanel
                projectId={projectId}
                isOwner={canManageProject}
                editing={editing}
                onExitEdit={() => setEditing(false)}
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
                onExitEdit={() => setEditing(false)}
              />
            ) : null}
          </div>
        </div>
      </FileDropZone>
      {deleteDialog}
    </ResizableRightPanel>
  );
}
