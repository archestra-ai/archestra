"use client";

import {
  Eye,
  File as FileIcon,
  FileText,
  MessageCircle,
  Pencil,
  Trash2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import {
  type FileListItem,
  FileSection,
} from "@/components/chat/file-list-section";
import { FilePreview } from "@/components/chat/file-preview";
import { NewChatComposer } from "@/components/chat/new-chat-composer";
import { ResizableRightPanel } from "@/components/chat/resizable-right-panel";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
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
          title={project.name}
          description={project.description ?? ""}
          actionButton={
            project.isOwner ? (
              <div className="flex items-center gap-1">
                <EditDescriptionButton
                  projectId={project.id}
                  description={project.description}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Delete project"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                <SharePopover projectId={project.id} />
              </div>
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

          <div className="space-y-6">
            <ProjectChatInput projectId={project.id} />
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

function EditDescriptionButton({
  projectId,
  description,
}: {
  projectId: string;
  description: string | null;
}) {
  const updateProject = useUpdateProject();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(description ?? "");

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Edit description"
        onClick={() => {
          setDraft(description ?? "");
          setOpen(true);
        }}
      >
        <Pencil className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit description</DialogTitle>
          </DialogHeader>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            maxLength={4096}
            placeholder="What is this project about?"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={updateProject.isPending}
              onClick={async () => {
                const ok = await updateProject.mutateAsync({
                  id: projectId,
                  description: draft.trim() || null,
                });
                if (ok) setOpen(false);
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Compact share control: a button summarizing visibility, details in a popover. */
function SharePopover({ projectId }: { projectId: string }) {
  const { data: project } = useProject(projectId);
  const { data: teams } = useTeams();
  const setShare = useSetProjectShare();

  if (!project) return null;
  const visibility = project.visibility ?? "none";
  const shareTeamIds = project.shareTeamIds ?? [];
  const label =
    visibility === "organization"
      ? "Shared · Org"
      : visibility === "team"
        ? `Shared · ${shareTeamIds.length} team${shareTeamIds.length === 1 ? "" : "s"}`
        : "Share";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Users className="h-4 w-4" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <p className="text-sm font-medium">Who can see this project</p>
        <Select
          value={visibility}
          onValueChange={(value) =>
            setShare.mutate({
              id: projectId,
              visibility: value as "organization" | "team" | "none",
              teamIds: value === "team" ? shareTeamIds : [],
            })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Only me</SelectItem>
            <SelectItem value="organization">Whole organization</SelectItem>
            <SelectItem value="team">Specific teams</SelectItem>
          </SelectContent>
        </Select>
        {visibility === "team" && (
          <div className="space-y-1">
            {(teams ?? []).map((team) => {
              const checked = shareTeamIds.includes(team.id);
              return (
                <label
                  key={team.id}
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setShare.mutate({
                        id: projectId,
                        visibility: "team",
                        teamIds: checked
                          ? shareTeamIds.filter((t) => t !== team.id)
                          : [...shareTeamIds, team.id],
                      })
                    }
                  />
                  {team.name}
                </label>
              );
            })}
            {(teams ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">
                No teams exist yet.
              </p>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          People you share with can read every chat, start their own, and work
          with the project's files through chats. Writing in a chat stays with
          its author.
        </p>
      </PopoverContent>
    </Popover>
  );
}
