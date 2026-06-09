"use client";

import {
  CalendarClock,
  Database,
  MessageCircle,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { LoadingWrapper } from "@/components/loading";
import { ProjectFormDialog } from "@/components/project-form-dialog";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useCreateConversation } from "@/lib/chat/chat.query";
import { getConversationDisplayTitle } from "@/lib/chat/chat-utils";
import { useDeleteProject, useProject } from "@/lib/project.query";

export default function ProjectDetailPageClient({ id }: { id: string }) {
  const router = useRouter();
  const { data: project, isLoading } = useProject(id);
  const { data: session } = useSession();
  const { data: canUpdate } = useHasPermissions({ project: ["update"] });
  const { data: canDelete } = useHasPermissions({ project: ["delete"] });
  const { data: agents = [] } = useProfiles({
    filters: { agentTypes: ["agent"] },
  });
  const createConversation = useCreateConversation();
  const deleteProject = useDeleteProject();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const startProjectChat = async () => {
    const agent = agents[0];
    if (!agent) return;
    const conversation = await createConversation.mutateAsync({
      agentId: agent.id,
      projectId: id,
    });
    if (conversation) router.push(`/chat/${conversation.id}`);
  };

  return (
    <LoadingWrapper isPending={isLoading}>
      {project ? (
        <div className="mx-auto flex max-w-[1500px] gap-6 p-6">
          <main className="min-w-0 flex-1 space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="mb-3 flex items-center gap-3">
                  <AgentIcon
                    icon={project.icon}
                    fallbackType="agent"
                    size={28}
                  />
                  <ResourceVisibilityBadge
                    scope={project.scope}
                    teams={project.teams}
                    authorId={project.authorId}
                    authorName={project.authorName}
                    currentUserId={session?.user?.id}
                  />
                </div>
                <h1 className="truncate text-4xl font-semibold tracking-tight">
                  {project.name}
                </h1>
                {project.description ? (
                  <p className="mt-2 max-w-3xl text-muted-foreground">
                    {project.description}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  onClick={startProjectChat}
                  disabled={agents.length === 0}
                >
                  <Plus className="h-4 w-4" />
                  New chat
                </Button>
                {canUpdate ? (
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setEditOpen(true)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                ) : null}
                {canDelete ? (
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Recent sessions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {(project.recentConversations ?? []).length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No chat sessions yet.
                  </div>
                ) : (
                  project.recentConversations?.map((conversation) => (
                    <button
                      key={conversation.id}
                      type="button"
                      onClick={() => router.push(`/chat/${conversation.id}`)}
                      className="flex w-full items-center gap-3 rounded-md border p-3 text-left hover:bg-muted/50"
                    >
                      <MessageCircle className="h-4 w-4 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {getConversationDisplayTitle(
                            conversation.title,
                            conversation.messages,
                          )}
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {new Date(conversation.updatedAt).toLocaleDateString()}
                      </span>
                    </button>
                  ))
                )}
              </CardContent>
            </Card>
          </main>

          <aside className="hidden w-[360px] shrink-0 space-y-4 xl:block">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Instructions</CardTitle>
              </CardHeader>
              <CardContent className="whitespace-pre-wrap text-sm text-muted-foreground">
                {project.instructions || "No project instructions."}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarClock className="h-4 w-4" />
                  Scheduled
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {(project.scheduledTriggers ?? []).length} scheduled triggers
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Database className="h-4 w-4" />
                  Context
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {project.knowledgeBases.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No knowledge sources attached.
                  </div>
                ) : (
                  project.knowledgeBases.map((knowledgeBase) => (
                    <div
                      key={knowledgeBase.id}
                      className="rounded-md border p-2 text-sm"
                    >
                      {knowledgeBase.name}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </aside>

          <ProjectFormDialog
            open={editOpen}
            onOpenChange={setEditOpen}
            project={project}
          />
          <DeleteConfirmDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title="Delete project?"
            description="This removes the project and detaches its chat sessions."
            isPending={deleteProject.isPending}
            confirmLabel="Delete"
            pendingLabel="Deleting..."
            onConfirm={async () => {
              const deleted = await deleteProject.mutateAsync(project.id);
              if (deleted) router.push("/projects");
            }}
          />
        </div>
      ) : null}
    </LoadingWrapper>
  );
}
