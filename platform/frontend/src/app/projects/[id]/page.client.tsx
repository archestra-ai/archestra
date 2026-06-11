"use client";

import { Eye, Folder, MessageSquarePlus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useDeleteProject,
  useProject,
  useProjectConversations,
  useSetProjectShare,
} from "@/lib/projects/projects.query";
import { useTeams } from "@/lib/teams/team.query";

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
      description={project.description ?? "No description"}
      actionButton={
        <div className="flex items-center gap-2">
          {project.isOwner && (
            <Button
              variant="outline"
              onClick={async () => {
                const ok = await deleteProject.mutateAsync({ id: project.id });
                if (ok) router.push("/projects");
              }}
              disabled={deleteProject.isPending}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          )}
          <Button onClick={() => router.push(`/chat?project=${project.id}`)}>
            <MessageSquarePlus className="mr-2 h-4 w-4" />
            New chat
          </Button>
        </div>
      }
    >
      <div className="space-y-8">
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <Folder className="h-4 w-4" aria-hidden />
            Result folder: {project.folderName}
          </span>
          {!project.isOwner && (
            <Badge variant="secondary">Shared with you</Badge>
          )}
        </div>

        {project.isOwner && <ShareControls projectId={project.id} />}

        <section>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Chats
          </h2>
          {!conversations || conversations.length === 0 ? (
            <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
              No chats yet — start one with “New chat”.
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border">
              {conversations.map((conv, i) => (
                <Link
                  key={conv.id}
                  href={`/chat/${conv.id}`}
                  className={`flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50 ${i > 0 ? "border-t" : ""}`}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {conv.title ?? "Untitled chat"}
                  </span>
                  {conv.readOnly && (
                    <Badge variant="outline" className="gap-1">
                      <Eye className="h-3 w-3" />
                      {conv.authorName ?? "someone else"} · read-only
                    </Badge>
                  )}
                  <span className="hidden w-40 shrink-0 text-right text-xs text-muted-foreground sm:block">
                    {new Date(conv.lastMessageAt).toLocaleString()}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </PageLayout>
  );
}

// === internal components ===

function ShareControls({ projectId }: { projectId: string }) {
  const { data: project } = useProject(projectId);
  const { data: teams } = useTeams();
  const setShare = useSetProjectShare();

  if (!project) return null;
  const visibility = project.visibility ?? "none";
  const shareTeamIds = project.shareTeamIds ?? [];

  return (
    <section className="max-w-md space-y-3 rounded-md border p-4">
      <Label className="text-sm font-medium">Sharing</Label>
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
              <label key={team.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    setShare.mutate({
                      id: projectId,
                      visibility: "team",
                      teamIds: checked
                        ? shareTeamIds.filter((id) => id !== team.id)
                        : [...shareTeamIds, team.id],
                    })
                  }
                />
                {team.name}
              </label>
            );
          })}
          {(teams ?? []).length === 0 && (
            <p className="text-xs text-muted-foreground">No teams exist yet.</p>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        People you share with can read every chat in the project and start their
        own; writing in a chat stays with its author. Agent results land in the
        shared project folder.
      </p>
    </section>
  );
}
