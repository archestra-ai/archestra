"use client";

import { PROJECT_INSTRUCTIONS_FILENAME } from "@archestra/shared";
import {
  CalendarClock,
  ChevronLeft,
  Download,
  Eye,
  FileText,
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
import { collapseProjectChats } from "@/app/projects/[id]/project-chats.utils";
import { ProjectSchedulesSection } from "@/app/projects/[id]/project-schedules-section";
import { AgentIcon } from "@/components/agent-icon";
import {
  type FileListItem,
  FileSection,
} from "@/components/chat/file-list-section";
import { FilePreview } from "@/components/chat/file-preview";
import { NewChatComposer } from "@/components/chat/new-chat-composer";
import {
  INSTRUCTIONS_SELECTION,
  InstructionsRow,
  ProjectInstructionsPanel,
} from "@/components/chat/project-instructions";
import { ResizableRightPanel } from "@/components/chat/resizable-right-panel";
import { PageLayout } from "@/components/page-layout";
import { EditProjectDialog } from "@/components/projects/edit-project-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { buildProjectChatHandoffUrl } from "@/lib/projects/project-chat-handoff";
import { canManageProject } from "@/lib/projects/project-permissions";
import {
  useDeleteProject,
  usePinProject,
  useProject,
  useProjectConversations,
  useProjectFiles,
} from "@/lib/projects/projects.query";
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
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: project, isPending } = useProject(id);
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
              {project.viewerRole === "shared" && (
                <Badge variant="secondary">Shared with you</Badge>
              )}
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
          projectName={project.name}
          isOwner={canManage}
        />
      </div>
    </div>
  );
}

// === internal components ===

/**
 * The real /chat composer; submitting hands off to /chat, which creates the
 * project chat (via ?project=) and sends the prompt (via ?user_prompt=).
 */
function ProjectChatInput({ projectId }: { projectId: string }) {
  const router = useRouter();

  return (
    <NewChatComposer
      onSubmitPrompt={(text, agentId) =>
        router.push(
          buildProjectChatHandoffUrl({ projectId, prompt: text, agentId }),
        )
      }
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
                      {isScheduled
                        ? (conv.scheduleName ?? "Scheduled task")
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
                    {isScheduled
                      ? (conv.title ?? "No prompt")
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
 * The project's files as a full-height right sidebar — the exact chat-page
 * Files panel: same resizable shell, same tab header, same stacked
 * list-over-preview body.
 */
function ProjectFilesSidebar({
  projectId,
  projectName,
  isOwner,
}: {
  projectId: string;
  projectName: string;
  isOwner: boolean;
}) {
  const { data: files } = useProjectFiles(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "detail">("list");

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
    }));
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const instructionsSelected = selectedId === INSTRUCTIONS_SELECTION;
  const detailName = instructionsSelected
    ? PROJECT_INSTRUCTIONS_FILENAME
    : (selected?.name ?? "");

  const openFile = (id: string) => {
    setSelectedId(id);
    setView("detail");
  };
  const backToList = () => setView("list");

  // If the open file disappears (e.g. deleted elsewhere), fall back to the list.
  const selectedMissing =
    selectedId !== null && !instructionsSelected && selected === null;
  useEffect(() => {
    if (selectedMissing) {
      setSelectedId(null);
      setView("list");
    }
  }, [selectedMissing]);

  return (
    <ResizableRightPanel>
      <Tabs value="files" className="flex-1 min-h-0 flex flex-col gap-0">
        <div className="flex items-center gap-2 border-b px-2 py-2">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <TabsList className="h-8 w-max">
              <TabsTrigger value="files" className="text-xs px-3">
                <FileText className="h-3 w-3" />
                Files
              </TabsTrigger>
            </TabsList>
          </div>
          <span className="shrink-0 truncate pr-1 text-xs text-muted-foreground">
            {projectName}
          </span>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden relative">
          <div className="flex h-full flex-col">
            {view === "list" ? (
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                <FileSection
                  items={items}
                  selectedId={null}
                  onSelect={openFile}
                  leading={
                    <InstructionsRow
                      onSelect={() => openFile(INSTRUCTIONS_SELECTION)}
                    />
                  }
                />
                {items.length === 0 && (
                  <p className="px-1 pt-3 text-xs text-muted-foreground">
                    Results the agent saves in this project will appear here.
                  </p>
                )}
              </div>
            ) : (
              <>
                <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground"
                    onClick={backToList}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Files
                  </Button>
                  <span className="shrink-0 text-muted-foreground">·</span>
                  <span
                    className="min-w-0 flex-1 truncate text-sm font-medium"
                    title={detailName}
                  >
                    {detailName}
                  </span>
                  {selected && !instructionsSelected && selected.contentUrl && (
                    <a
                      href={selected.contentUrl}
                      download={selected.name}
                      title={`Download ${selected.name}`}
                      className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Download className="h-4 w-4" />
                      <span className="sr-only">Download {selected.name}</span>
                    </a>
                  )}
                </div>
                {instructionsSelected ? (
                  <ProjectInstructionsPanel
                    projectId={projectId}
                    isOwner={isOwner}
                    onClose={backToList}
                  />
                ) : selected ? (
                  <FilePreview file={selected} onClose={backToList} />
                ) : null}
              </>
            )}
          </div>
        </div>
      </Tabs>
    </ResizableRightPanel>
  );
}
