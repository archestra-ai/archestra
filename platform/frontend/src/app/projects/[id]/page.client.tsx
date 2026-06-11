"use client";

import {
  Download,
  Eye,
  Folder,
  MessageCircle,
  Pencil,
  Trash2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
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
import { Textarea } from "@/components/ui/textarea";
import {
  useDeleteProject,
  useProject,
  useProjectConversations,
  useProjectFiles,
  useSetProjectShare,
  useUpdateProject,
} from "@/lib/projects/projects.query";
import {
  formatBytes,
  sandboxArtifactUrl,
} from "@/lib/skills-sandbox/sandbox-file-preview";
import { useDeleteSandboxFile } from "@/lib/skills-sandbox/sandbox-files.query";
import { useTeams } from "@/lib/teams/team.query";
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
        description="Chats and the result folder are kept — chats become ordinary conversations, the folder stays in My Files."
        isPending={deleteProject.isPending}
        onConfirm={async () => {
          const ok = await deleteProject.mutateAsync({ id: project.id });
          if (ok) router.push("/projects");
        }}
        confirmLabel="Delete"
        pendingLabel="Deleting..."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <ProjectChatInput projectId={project.id} />
          <ChatsList conversations={conversations ?? []} />
        </div>
        <ProjectFilesCard
          projectId={project.id}
          folderName={project.folderName}
          canDelete={project.isOwner}
        />
      </div>
    </PageLayout>
  );
}

// === internal components ===

/**
 * Prompt box that starts a chat IN this project. Built from the same
 * prompt-input primitives as the /chat composer, so it looks identical;
 * submitting hands off to /chat, which creates the project chat and sends.
 */
function ProjectChatInput({ projectId }: { projectId: string }) {
  const router = useRouter();

  const handleSubmit = (message: PromptInputMessage) => {
    const prompt = message.text?.trim();
    if (!prompt) return;
    router.push(
      `/chat?project=${projectId}&user_prompt=${encodeURIComponent(prompt)}`,
    );
  };

  return (
    <PromptInput onSubmit={handleSubmit}>
      <PromptInputBody>
        <PromptInputTextarea placeholder="Start a chat in this project…" />
      </PromptInputBody>
      <PromptInputFooter>
        <div className="flex-1" />
        <PromptInputSubmit className="!h-8" status="ready" />
      </PromptInputFooter>
    </PromptInput>
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
        <div className="space-y-3">
          {conversations.map((conv) => (
            <Link
              key={conv.id}
              href={`/chat/${conv.id}`}
              className="flex items-center gap-4 rounded-xl border bg-card px-4 py-4 transition-colors hover:bg-muted/50"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
                <MessageCircle className="h-5 w-5 text-primary" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">
                    {conv.title ?? "Untitled chat"}
                  </span>
                  {conv.readOnly && (
                    <Badge variant="outline" className="shrink-0 gap-1">
                      <Eye className="h-3 w-3" />
                      read-only
                    </Badge>
                  )}
                </span>
                <span className="block truncate text-sm text-muted-foreground">
                  {conv.readOnly
                    ? `by ${conv.authorName ?? "someone else"}`
                    : "by you"}
                </span>
              </span>
              <span className="shrink-0 text-sm text-muted-foreground">
                {formatRelativeTimeFromNow(conv.lastMessageAt)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

/** The project's result folder, kept fresh while the page is open. */
function ProjectFilesCard({
  projectId,
  folderName,
  canDelete,
}: {
  projectId: string;
  folderName: string;
  canDelete: boolean;
}) {
  const { data: files } = useProjectFiles(projectId);
  const deleteFile = useDeleteSandboxFile();
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    filename: string;
  } | null>(null);

  return (
    <aside className="h-fit rounded-xl border">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Folder className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">Files</span>
        <span className="ml-auto truncate text-xs text-muted-foreground">
          {folderName}
        </span>
      </div>
      <DeleteConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete ${pendingDelete?.filename ?? "file"}?`}
        description="This permanently removes the file from the project's result folder."
        isPending={deleteFile.isPending}
        onConfirm={async () => {
          if (pendingDelete) {
            await deleteFile.mutateAsync({ id: pendingDelete.id });
            setPendingDelete(null);
          }
        }}
        confirmLabel="Delete"
        pendingLabel="Deleting..."
      />
      {!files || files.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">
          Results the agent saves in this project land here.
        </p>
      ) : (
        <div>
          {files.map((file, i) => (
            <div
              key={file.id ?? file.filename}
              className={`flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50 ${i > 0 ? "border-t" : ""}`}
            >
              <span className="min-w-0 flex-1 truncate">{file.filename}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatBytes(file.sizeBytes)}
              </span>
              {file.id && (
                <>
                  <a
                    href={sandboxArtifactUrl(file.id)}
                    download={file.filename}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`Download ${file.filename}`}
                  >
                    <Download className="h-4 w-4" />
                  </a>
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() =>
                        setPendingDelete({
                          id: file.id as string,
                          filename: file.filename,
                        })
                      }
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${file.filename}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </aside>
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
          with the result folder through chats. Writing in a chat stays with its
          author.
        </p>
      </PopoverContent>
    </Popover>
  );
}
