"use client";

import {
  ChevronDown,
  MessageCircle,
  MoreVertical,
  Pencil,
  Star,
  Trash2,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import {
  resolveInitialAgentState,
  resolvePreferredModelForProvider,
} from "@/app/chat/chat-initial-state";
import { ChatPageContent } from "@/app/chat/page";
import ArchestraPromptInput, {
  type ArchestraPromptInputProps,
} from "@/app/chat/prompt-input";
import { AgentIcon } from "@/components/agent-icon";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { LoadingWrapper } from "@/components/loading";
import { ProjectFormDialog } from "@/components/project-form-dialog";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useMemberDefaultModel } from "@/lib/chat/chat.query";
import { getConversationDisplayTitle } from "@/lib/chat/chat-utils";
import { deriveModelSource } from "@/lib/chat/use-chat-preferences";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useLlmModels, useLlmModelsByProvider } from "@/lib/llm-models.query";
import {
  type SupportedProvider,
  useLlmProviderApiKeys,
} from "@/lib/llm-provider-api-keys.query";
import { useOrganization } from "@/lib/organization.query";
import {
  type ProjectDetail,
  useDeleteProject,
  useProject,
} from "@/lib/project.query";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

type ProjectConversation = NonNullable<
  ProjectDetail["recentConversations"]
>[number];
const PROJECT_DETAIL_SESSION_LIST_MAX_HEIGHT = "max-h-[420px]";

export default function ProjectDetailPageClient({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const appName = useAppName();
  const { data: project, isLoading } = useProject(id);
  const { data: canUpdate } = useHasPermissions({ project: ["update"] });
  const { data: canDelete } = useHasPermissions({ project: ["delete"] });
  const { data: agents = [] } = useProfiles({
    filters: { agentTypes: ["agent"] },
  });
  const agent = agents[0];
  const { modelsByProvider, isPending: isModelsLoading } =
    useLlmModelsByProvider();
  const { data: chatModels = [] } = useLlmModels();
  const { data: chatApiKeys = [] } = useLlmProviderApiKeys();
  const { data: organization } = useOrganization();
  const { data: memberDefault } = useMemberDefaultModel();
  const deleteProject = useDeleteProject();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedApiKeyId, setSelectedApiKeyId] = useState<string | null>(null);
  const projectConversationId = searchParams.get("conversationId") ?? undefined;
  const shouldShowProjectChat =
    !!projectConversationId ||
    !!searchParams.get("user_prompt") ||
    searchParams.get("newChat") === "1";
  const pinnedConversations =
    project?.recentConversations?.filter(
      (conversation) => conversation.pinnedAt,
    ) ?? [];
  const recentConversations =
    project?.recentConversations?.filter(
      (conversation) => !conversation.pinnedAt,
    ) ?? [];

  useEffect(() => {
    if (!agent) return;
    const resolved = resolveInitialAgentState({
      agent,
      modelsByProvider,
      chatApiKeys,
      organization: organization
        ? {
            defaultModelId: organization.defaultModelId,
            defaultLlmApiKeyId: organization.defaultLlmApiKeyId,
          }
        : null,
      memberDefault: memberDefault ?? null,
    });
    if (!resolved) return;
    setSelectedModel(resolved.modelId);
    setSelectedApiKeyId(resolved.apiKeyId);
  }, [agent, modelsByProvider, chatApiKeys, organization, memberDefault]);

  const currentProvider = useMemo((): SupportedProvider | undefined => {
    if (!selectedModel) return undefined;
    for (const [provider, models] of Object.entries(modelsByProvider)) {
      if (models?.some((model) => model.dbId === selectedModel)) {
        return provider as SupportedProvider;
      }
    }
    return undefined;
  }, [selectedModel, modelsByProvider]);

  const selectedModelInputModalities = useMemo(() => {
    if (!selectedModel) return null;
    return (
      chatModels.find((model) => model.dbId === selectedModel)?.capabilities
        ?.inputModalities ?? null
    );
  }, [selectedModel, chatModels]);

  const modelSource = useMemo(() => {
    return deriveModelSource({
      selectedModelId: selectedModel,
      agentModelId: agent?.modelId,
      orgModelId: organization?.defaultModelId,
    });
  }, [selectedModel, agent?.modelId, organization?.defaultModelId]);

  const handleProviderChange = (
    provider: SupportedProvider,
    apiKeyId: string,
  ) => {
    setSelectedApiKeyId(apiKeyId);
    const preferredModel = resolvePreferredModelForProvider({
      provider,
      modelsByProvider,
    });
    if (preferredModel) {
      setSelectedModel(preferredModel.modelId);
    }
  };

  const handleResetModelOverride = () => {
    if (!agent) return;
    const resolved = resolveInitialAgentState({
      agent,
      modelsByProvider,
      chatApiKeys,
      organization: organization
        ? {
            defaultModelId: organization.defaultModelId,
            defaultLlmApiKeyId: organization.defaultLlmApiKeyId,
          }
        : null,
      memberDefault: null,
    });
    if (!resolved) return;
    setSelectedModel(resolved.modelId);
    setSelectedApiKeyId(resolved.apiKeyId);
  };

  const startProjectChat: ArchestraPromptInputProps["onSubmit"] = (
    message: PromptInputMessage,
    event,
  ) => {
    event.preventDefault();
    if (!agent) return;
    const params = new URLSearchParams({
      agentId: agent.id,
      newChat: "1",
    });
    if (selectedModel) {
      params.set("modelId", selectedModel);
    }
    if (selectedApiKeyId) {
      params.set("chatApiKeyId", selectedApiKeyId);
    }
    if (message.text) {
      params.set("user_prompt", message.text);
    }
    router.push(projectChatHref(id, params));
  };

  return (
    <LoadingWrapper isPending={isLoading}>
      {project && shouldShowProjectChat ? (
        <div className="min-h-0 flex-1">
          <ChatPageContent
            key={`project-chat-${id}-${projectConversationId ?? "new"}`}
            buildConversationHref={(conversationId) =>
              projectChatHref(
                id,
                conversationId
                  ? new URLSearchParams({ conversationId })
                  : undefined,
              )
            }
            projectId={id}
            projectPanel={
              <ProjectSidePanelContent
                appName={appName}
                canUpdate={canUpdate === true}
                onEdit={() => setEditOpen(true)}
                project={project}
              />
            }
            projectTabLabel="Project"
            routeConversationId={projectConversationId}
          />
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
      ) : project ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[1680px] gap-6 px-6 py-6">
            <main className="min-w-0 flex-1 space-y-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <AgentIcon
                      icon={project.icon}
                      fallbackType="agent"
                      size={34}
                    />
                    <h1 className="truncate text-4xl font-semibold tracking-tight">
                      {project.name}
                    </h1>
                  </div>
                  {project.description ? (
                    <p className="max-w-3xl text-muted-foreground">
                      {project.description}
                    </p>
                  ) : null}
                  {project.scope !== "personal" ? (
                    <ResourceVisibilityBadge
                      scope={project.scope}
                      teams={project.teams}
                      authorId={project.authorId}
                      authorName={project.authorName}
                      currentUserId={undefined}
                    />
                  ) : null}
                </div>
                {canUpdate || canDelete ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon">
                        <MoreVertical className="h-4 w-4" />
                        <span className="sr-only">Project actions</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {canUpdate ? (
                        <DropdownMenuItem onClick={() => setEditOpen(true)}>
                          <Pencil className="h-4 w-4" />
                          Edit details
                        </DropdownMenuItem>
                      ) : null}
                      {canDelete ? (
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeleteOpen(true)}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>

              <div className="w-full">
                {agent ? (
                  <ArchestraPromptInput
                    onSubmit={startProjectChat}
                    status="ready"
                    selectedModel={selectedModel}
                    onModelChange={setSelectedModel}
                    agentId={agent.id}
                    currentProvider={currentProvider}
                    initialApiKeyId={selectedApiKeyId}
                    onApiKeyChange={setSelectedApiKeyId}
                    onProviderChange={handleProviderChange}
                    allowFileUploads={
                      organization?.allowChatFileUploads ?? false
                    }
                    isModelsLoading={isModelsLoading}
                    inputModalities={selectedModelInputModalities}
                    agentLlmApiKeyId={agent.llmApiKeyId ?? null}
                    submitDisabled={agents.length === 0}
                    isPlaywrightSetupVisible={false}
                    selectorAgentId={agent.id}
                    selectorAgentName={agent.name}
                    modelSource={modelSource}
                    onResetModelOverride={handleResetModelOverride}
                  />
                ) : (
                  <Card>
                    <CardContent className="py-4 text-sm text-muted-foreground">
                      No agent is available to start a project chat.
                    </CardContent>
                  </Card>
                )}
              </div>

              <section className="space-y-6 pt-3">
                {pinnedConversations.length > 0 ? (
                  <SessionSection
                    title="Pinned"
                    conversations={pinnedConversations}
                    onSelect={(conversationId) =>
                      router.push(
                        projectChatHref(
                          id,
                          new URLSearchParams({ conversationId }),
                        ),
                      )
                    }
                    showStar
                  />
                ) : null}
                <SessionSection
                  title="Recents"
                  conversations={recentConversations}
                  onSelect={(conversationId) =>
                    router.push(
                      projectChatHref(
                        id,
                        new URLSearchParams({ conversationId }),
                      ),
                    )
                  }
                  emptyMessage={
                    pinnedConversations.length > 0
                      ? "No recent chat sessions."
                      : "No chat sessions yet."
                  }
                />
              </section>
            </main>

            <aside className="sticky top-6 hidden max-h-[calc(100vh-3rem)] w-[360px] shrink-0 overflow-y-auto xl:block">
              <ProjectSidePanelContent
                appName={appName}
                canUpdate={canUpdate === true}
                onEdit={() => setEditOpen(true)}
                project={project}
              />
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
        </div>
      ) : null}
    </LoadingWrapper>
  );
}

function projectChatHref(projectId: string, params?: URLSearchParams): string {
  const queryString = params?.toString();
  return queryString
    ? `/projects/${projectId}?${queryString}`
    : `/projects/${projectId}`;
}

function ProjectSidePanelContent({
  appName,
  canUpdate,
  onEdit,
  project,
}: {
  appName: string;
  canUpdate: boolean;
  onEdit: () => void;
  project: ProjectDetail;
}) {
  const [openSideCards, setOpenSideCards] = useState({
    instructions: true,
    context: true,
  });
  const toggleSideCard = (card: keyof typeof openSideCards) => {
    setOpenSideCards((current) => ({
      ...current,
      [card]: !current[card],
    }));
  };

  return (
    <div className="space-y-3">
      <ProjectSideCard
        title="Instructions"
        open={openSideCards.instructions}
        onToggle={() => toggleSideCard("instructions")}
        action={
          canUpdate ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onEdit}
            >
              <Pencil className="h-4 w-4" />
              <span className="sr-only">Edit instructions</span>
            </Button>
          ) : null
        }
      >
        <div className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
          {project.instructions ||
            `Add tone, formatting, or rules to guide how ${appName} works in this project.`}
        </div>
      </ProjectSideCard>

      <ProjectSideCard
        title="Context"
        open={openSideCards.context}
        onToggle={() => toggleSideCard("context")}
      >
        <div className="space-y-2.5">
          <ContextSubsection title="Files">
            <div className="text-xs leading-5 text-muted-foreground">
              No files
            </div>
          </ContextSubsection>
        </div>
      </ProjectSideCard>
    </div>
  );
}

function SessionSection({
  title,
  conversations,
  emptyMessage,
  onSelect,
  showStar = false,
}: {
  title: string;
  conversations: ProjectConversation[];
  emptyMessage?: string;
  onSelect: (conversationId: string) => void;
  showStar?: boolean;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      <div
        className={cn(
          "space-y-3 pr-1",
          conversations.length > 4 && PROJECT_DETAIL_SESSION_LIST_MAX_HEIGHT,
          conversations.length > 4 && "overflow-y-auto",
        )}
      >
        {conversations.length === 0 ? (
          <div className="rounded-lg border px-4 py-4 text-sm text-muted-foreground">
            {emptyMessage}
          </div>
        ) : (
          conversations.map((conversation) => {
            const preview = getConversationPreview(conversation.messages);
            return (
              <button
                key={conversation.id}
                type="button"
                onClick={() => onSelect(conversation.id)}
                className="flex w-full items-center gap-4 rounded-lg border bg-card px-5 py-4 text-left transition-colors hover:bg-muted/50"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <MessageCircle className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="truncate text-sm font-medium">
                      {getConversationDisplayTitle(
                        conversation.title,
                        conversation.messages,
                      )}
                    </div>
                    {showStar ? (
                      <Star className="h-3.5 w-3.5 shrink-0 fill-muted-foreground text-muted-foreground" />
                    ) : null}
                  </div>
                  {preview ? (
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {preview}
                    </div>
                  ) : null}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatRelativeTimeFromNow(conversation.updatedAt)}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function ProjectSideCard({
  title,
  open,
  onToggle,
  action,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-3 text-sm font-medium">
        <button
          type="button"
          onClick={onToggle}
          className="min-w-0 flex-1 text-left text-muted-foreground hover:text-foreground"
        >
          <span className="block truncate">{title}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {action}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onToggle}
          >
            <span className="sr-only">
              {open ? "Collapse" : "Expand"} {title}
            </span>
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 transition-transform",
                !open && "-rotate-90",
              )}
            />
          </Button>
        </div>
      </div>
      {open ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}

function ContextSubsection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-sm font-medium">{title}</div>
      <div>{children}</div>
    </div>
  );
}

function getConversationPreview(messages: unknown[]): string {
  for (const message of messages) {
    const text = extractMessageText(message);
    if (text) return text;
  }
  return "";
}

function extractMessageText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (typeof record.content === "string" && record.content.trim()) {
    return record.content.trim();
  }
  if (typeof record.text === "string" && record.text.trim()) {
    return record.text.trim();
  }
  if (Array.isArray(record.parts)) {
    for (const part of record.parts) {
      if (!part || typeof part !== "object") continue;
      const partRecord = part as Record<string, unknown>;
      if (typeof partRecord.text === "string" && partRecord.text.trim()) {
        return partRecord.text.trim();
      }
    }
  }
  return null;
}
