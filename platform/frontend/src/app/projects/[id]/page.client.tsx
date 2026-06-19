"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  CalendarClock,
  Eye,
  File as FileIcon,
  FileText,
  Globe,
  Lock,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Trash2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ProjectSchedulesSection } from "@/app/projects/[id]/project-schedules-section";
import { AgentIcon } from "@/components/agent-icon";
import { AgentIconPicker } from "@/components/agent-icon-picker";
import {
  type FileListItem,
  FileSection,
} from "@/components/chat/file-list-section";
import { FilePreview } from "@/components/chat/file-preview";
import { NewChatComposer } from "@/components/chat/new-chat-composer";
import { ResizableRightPanel } from "@/components/chat/resizable-right-panel";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { PageLayout } from "@/components/page-layout";
import { StandardFormDialog } from "@/components/standard-dialog";
import { AssignmentCombobox } from "@/components/ui/assignment-combobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import {
  useDeleteProject,
  useProject,
  useProjectConversations,
  useProjectFiles,
  useSetProjectShare,
  useUpdateProject,
} from "@/lib/projects/projects.query";
import { sandboxArtifactUrl } from "@/lib/skills-sandbox/sandbox-file-preview";
import { useTeams } from "@/lib/teams/team.query";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

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
  const { data: conversations } = useProjectConversations(id);
  const deleteProject = useDeleteProject();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

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

  return (
    // The same two-column shell as /chat: the page content scrolls in the left
    // column while the Files panel takes the full height of the right side.
    <div className="flex h-full w-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <PageLayout
          title={
            <span className="flex items-center gap-2">
              <AgentIcon icon={project.icon} fallbackType="project" size={22} />
              {project.name}
            </span>
          }
          description={project.description ?? ""}
          actionButton={
            project.isOwner ? (
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
                  <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                    <Pencil className="h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Badge variant="secondary">Shared with you</Badge>
            )
          }
        >
          <DeleteConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={`Delete ${project.name}?`}
            description="Chats and files are kept — chats become ordinary conversations, the files stay in My Files."
            isPending={deleteProject.isPending}
            onConfirm={async () => {
              const ok = await deleteProject.mutateAsync({ id: project.id });
              if (ok) router.push("/projects");
            }}
            confirmLabel="Delete"
            pendingLabel="Deleting..."
          />
          {editOpen && (
            <EditProjectDialog
              project={project}
              open={editOpen}
              onOpenChange={setEditOpen}
            />
          )}

          <div className="space-y-6">
            <ProjectChatInput projectId={project.id} />
            <ProjectSchedulesSection projectId={project.id} />
            <ChatsList conversations={conversations ?? []} />
          </div>
        </PageLayout>
      </div>

      {/* Right-side Files panel - desktop only, like the chat page */}
      <div className="hidden md:flex h-full min-h-0">
        <ProjectFilesSidebar
          projectId={project.id}
          projectName={project.name}
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
      onSubmitPrompt={(text) =>
        router.push(
          `/chat?project=${projectId}&user_prompt=${encodeURIComponent(text)}`,
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
  }>;
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
        Chats
      </h2>
      {conversations.length === 0 ? (
        <p className="rounded-xl border px-3 py-8 text-center text-sm text-muted-foreground">
          No chats yet — type above to start one.
        </p>
      ) : (
        <div className="space-y-2">
          {conversations.map((conv) => (
            <Link
              key={conv.id}
              href={`/chat/${conv.id}`}
              className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:bg-muted/50"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                {conv.origin === "schedule_trigger" ? (
                  <CalendarClock className="h-4 w-4 text-primary" aria-hidden />
                ) : (
                  <MessageCircle className="h-4 w-4 text-primary" aria-hidden />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {conv.title ?? "Untitled chat"}
                  </span>
                  {conv.origin === "schedule_trigger" && (
                    <Badge variant="outline" className="shrink-0 gap-1">
                      <CalendarClock className="h-3 w-3" />
                      scheduled
                    </Badge>
                  )}
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
          ))}
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
}: {
  projectId: string;
  projectName: string;
}) {
  const { data: files } = useProjectFiles(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const items: FileListItem[] = (files ?? [])
    .filter((f) => f.id !== null)
    .map((f) => ({
      id: f.id as string,
      name: f.filename,
      mimeType: f.mimeType,
      contentUrl: sandboxArtifactUrl(f.id as string),
    }));
  const selected = items.find((i) => i.id === selectedId) ?? null;

  // Open with the newest file previewed, like the chat panel does. Only once —
  // an explicitly closed preview stays closed.
  const defaultApplied = useRef(false);
  const newestId = items.at(-1)?.id;
  useEffect(() => {
    if (defaultApplied.current || !newestId) return;
    defaultApplied.current = true;
    setSelectedId(newestId);
  }, [newestId]);

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
          {items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center text-xs text-muted-foreground">
              <FileIcon className="mb-2 h-6 w-6 opacity-50" />
              <p className="font-medium">No files yet</p>
              <p className="mt-1">
                Results the agent saves in this project will appear here.
              </p>
            </div>
          ) : (
            <div className="flex h-full flex-col">
              <div
                className={cn(
                  "overflow-y-auto px-3 py-3",
                  selected ? "max-h-[45%] shrink-0 border-b" : "flex-1",
                )}
              >
                <FileSection
                  title="Results"
                  items={items}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              </div>
              {selected && (
                <FilePreview
                  file={selected}
                  onClose={() => setSelectedId(null)}
                />
              )}
            </div>
          )}
        </div>
      </Tabs>
    </ResizableRightPanel>
  );
}

type ProjectVisibility = "none" | "organization" | "team";
type EditProjectForm = {
  name: string;
  description: string;
  icon: string | null;
};

/**
 * Single edit entry point for the owner: name, description, and icon plus the
 * shared visibility control (replacing the old separate description dialog and
 * share popover).
 */
function EditProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: archestraApiTypes.GetProjectResponses["200"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateProject = useUpdateProject();
  const setShare = useSetProjectShare();
  const { data: teams = [] } = useTeams({ enabled: open });

  const form = useForm<EditProjectForm>({
    defaultValues: {
      name: project.name,
      description: project.description ?? "",
      icon: project.icon,
    },
  });
  const icon = form.watch("icon");
  const initialVisibility: ProjectVisibility = project.visibility ?? "none";
  const [visibility, setVisibility] =
    useState<ProjectVisibility>(initialVisibility);
  const [teamIds, setTeamIds] = useState<string[]>(project.shareTeamIds ?? []);

  const visibilityOptions: Array<VisibilityOption<ProjectVisibility>> = [
    {
      value: "none",
      label: "Only me",
      description: "No one else can see this project.",
      icon: Lock,
    },
    {
      value: "organization",
      label: "Organization",
      description: "Everyone in your organization can see this project.",
      icon: Globe,
    },
    {
      value: "team",
      label: "Teams",
      description: "Share this project with selected teams.",
      icon: Users,
      disabled: teams.length === 0,
      disabledLabel: teams.length === 0 ? "No teams available" : undefined,
    },
  ];

  const isPending = updateProject.isPending || setShare.isPending;
  const teamSelectionMissing = visibility === "team" && teamIds.length === 0;

  const onSubmit = form.handleSubmit(async ({ name, description, icon }) => {
    if (teamSelectionMissing) return;
    const ok = await updateProject.mutateAsync({
      id: project.id,
      name: name.trim(),
      description: description.trim() || null,
      icon,
    });
    if (!ok) return;

    const nextTeamIds = visibility === "team" ? teamIds : [];
    const shareChanged =
      visibility !== initialVisibility ||
      (visibility === "team" &&
        nextTeamIds.slice().sort().join() !==
          (project.shareTeamIds ?? []).slice().sort().join());
    if (shareChanged) {
      const shareOk = await setShare.mutateAsync({
        id: project.id,
        visibility,
        teamIds: nextTeamIds,
      });
      if (!shareOk) return;
    }
    onOpenChange(false);
  });

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit project"
      size="medium"
      onSubmit={onSubmit}
      bodyClassName="space-y-4"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              isPending ||
              !form.watch("name").trim().length ||
              teamSelectionMissing
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3">
        <AgentIconPicker
          value={icon}
          onChange={(next) => form.setValue("icon", next)}
          fallbackType="project"
        />
        <div className="flex-1 space-y-3">
          <Input
            placeholder="Project name"
            {...form.register("name", { required: true, maxLength: 256 })}
          />
          <Textarea
            placeholder="What is this project about?"
            rows={3}
            {...form.register("description", { maxLength: 4096 })}
          />
        </div>
      </div>

      <VisibilitySelector
        heading="Sharing"
        value={visibility}
        options={visibilityOptions}
        onValueChange={setVisibility}
      >
        {visibility === "team" && (
          <div className="space-y-2">
            <Label>Teams</Label>
            <AssignmentCombobox
              items={teams.map((team) => ({ id: team.id, name: team.name }))}
              selectedIds={teamIds}
              onToggle={(teamId) =>
                setTeamIds((current) =>
                  current.includes(teamId)
                    ? current.filter((id) => id !== teamId)
                    : [...current, teamId],
                )
              }
              label="Select teams"
              placeholder="Search teams..."
              emptyMessage="No teams found."
              className="h-9 w-full justify-between border text-sm text-foreground"
            />
            {teamIds.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {teams
                  .filter((team) => teamIds.includes(team.id))
                  .map((team) => (
                    <Badge key={team.id} variant="secondary">
                      {team.name}
                    </Badge>
                  ))}
              </div>
            )}
          </div>
        )}
      </VisibilitySelector>

      <p className="text-xs text-muted-foreground">
        People you share with can read every chat, start their own, and work
        with the project's files through chats. Writing in a chat stays with its
        author.
      </p>
    </StandardFormDialog>
  );
}
