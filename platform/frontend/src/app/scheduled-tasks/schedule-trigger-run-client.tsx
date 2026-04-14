"use client";

import type { UIMessage } from "@ai-sdk/react";
import type { SupportedProvider } from "@shared";
import type { ChatStatus } from "ai";
import {
  ArrowLeft,
  ChevronDown,
  ExternalLink,
  FileText,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import type { FormEvent } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ArchestraPromptInput from "@/app/chat/prompt-input";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ConversationArtifactPanel } from "@/components/chat/conversation-artifact";
import { LoadingSpinner } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useInternalAgents } from "@/lib/agent.query";
import {
  useConversation,
  useStopChatStream,
  useUpdateConversation,
} from "@/lib/chat/chat.query";
import { useChatSession } from "@/lib/chat/global-chat.context";
import { useLlmModels, useLlmModelsByProvider } from "@/lib/llm-models.query";
import { useOrganization } from "@/lib/organization.query";
import {
  useCreateScheduleTriggerRunConversation,
  useScheduleTrigger,
  useScheduleTriggerRun,
} from "@/lib/schedule-trigger.query";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { formatCronSchedule } from "@/lib/utils/format-cron";
import {
  getScheduleTriggerRunSessionId,
  isScheduleTriggerRunActive,
} from "./schedule-trigger.utils";

type ScheduleTriggerRunPageProps = {
  triggerId: string;
  runId: string;
};

function areConversationMessagesSynced(
  localMessages: UIMessage[],
  backendMessages: UIMessage[],
) {
  if (localMessages.length !== backendMessages.length) {
    return false;
  }

  return localMessages.every((localMessage, index) => {
    const backendMessage = backendMessages[index];
    return (
      backendMessage &&
      localMessage.id === backendMessage.id &&
      localMessage.role === backendMessage.role &&
      JSON.stringify(localMessage.parts) ===
        JSON.stringify(backendMessage.parts)
    );
  });
}

export function ScheduleTriggerRunPage({
  triggerId,
  runId,
}: ScheduleTriggerRunPageProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const loadedConversationRef = useRef<string | undefined>(undefined);
  const bootstrapRequestedRef = useRef(false);
  const recoveryAttemptedRef = useRef(false);
  const wasRunActiveRef = useRef(false);
  const [bootstrappedConversationId, setBootstrappedConversationId] = useState<
    string | null
  >(null);
  const [conversationBootstrapError, setConversationBootstrapError] = useState<
    string | null
  >(null);
  const [showDetails, setShowDetails] = useState(false);
  const [isArtifactOpen, setIsArtifactOpen] = useState(false);

  const { data: trigger, isLoading: triggerLoading } = useScheduleTrigger(
    triggerId,
    {
      enabled: !!triggerId,
      refetchInterval: 5_000,
    },
  );
  const { data: run, isLoading: runLoading } = useScheduleTriggerRun(
    triggerId,
    runId,
    {
      enabled: !!triggerId && !!runId,
      refetchInterval: 3_000,
    },
  );
  const ensureConversationMutation = useCreateScheduleTriggerRunConversation();
  const conversationId =
    run?.chatConversationId ?? bootstrappedConversationId ?? undefined;
  const { data: conversation, isLoading: conversationLoading } =
    useConversation(conversationId);
  const chatSession = useChatSession({ conversationId });

  const isRunActive = isScheduleTriggerRunActive(run?.status);

  const { data: chatModels = [] } = useLlmModels();
  const { modelsByProvider } = useLlmModelsByProvider();
  const { data: organization } = useOrganization();
  const { data: internalAgents = [] } = useInternalAgents({
    enabled: !!conversation?.agentId,
  });

  const updateConversationMutation = useUpdateConversation();
  const stopChatStreamMutation = useStopChatStream();

  const messages = chatSession?.messages ?? [];
  const status = chatSession?.status ?? ("ready" as ChatStatus);
  const error = chatSession?.error;
  const sendMessage = chatSession?.sendMessage;
  const stop = chatSession?.stop;
  const setMessages = chatSession?.setMessages;
  const optimisticToolCalls = chatSession?.optimisticToolCalls ?? [];
  const addToolApprovalResponse = chatSession?.addToolApprovalResponse;
  const tokenUsage = chatSession?.tokenUsage;
  const tokensUsed = tokenUsage?.totalTokens;

  const selectedModel = useMemo(
    () =>
      conversation?.selectedModel
        ? chatModels.find((item) => item.id === conversation.selectedModel)
        : undefined,
    [conversation?.selectedModel, chatModels],
  );

  const currentProvider = selectedModel?.provider;
  const selectedModelContextLength =
    selectedModel?.capabilities?.contextLength ?? null;
  const selectedModelInputModalities =
    selectedModel?.capabilities?.inputModalities ?? null;

  useEffect(() => {
    if (!run?.chatConversationId) {
      return;
    }

    setBootstrappedConversationId(run.chatConversationId);
    setConversationBootstrapError(null);
  }, [run?.chatConversationId]);

  const ensureConversationMutateRef = useRef(
    ensureConversationMutation.mutateAsync,
  );
  ensureConversationMutateRef.current = ensureConversationMutation.mutateAsync;

  const ensureConversation = useCallback(async () => {
    bootstrapRequestedRef.current = true;
    setConversationBootstrapError(null);

    try {
      const createdConversation = await ensureConversationMutateRef.current({
        triggerId,
        runId,
      });
      setBootstrappedConversationId(createdConversation.id);
    } catch {
      setConversationBootstrapError(
        "Unable to prepare a chat conversation for this run.",
      );
    }
  }, [runId, triggerId]);

  useEffect(() => {
    if (
      !run ||
      ensureConversationMutation.isPending ||
      bootstrapRequestedRef.current
    ) {
      return;
    }

    void ensureConversation();
  }, [ensureConversation, ensureConversationMutation.isPending, run]);

  useEffect(() => {
    const wasRunActive = wasRunActiveRef.current;
    wasRunActiveRef.current = isRunActive;

    if (!run || isRunActive || !wasRunActive) {
      return;
    }

    void ensureConversation();
  }, [ensureConversation, isRunActive, run]);

  useEffect(() => {
    if (
      !conversationId ||
      conversationLoading ||
      conversation !== null ||
      recoveryAttemptedRef.current ||
      ensureConversationMutation.isPending
    ) {
      return;
    }

    recoveryAttemptedRef.current = true;
    void ensureConversation();
  }, [
    conversation,
    conversationId,
    conversationLoading,
    ensureConversation,
    ensureConversationMutation.isPending,
  ]);

  useEffect(() => {
    if (!setMessages || !conversationId || !conversation?.messages) {
      return;
    }

    if (loadedConversationRef.current !== conversationId) {
      loadedConversationRef.current = undefined;
    }

    const backendMessages = conversation.messages as UIMessage[];
    const shouldSync =
      conversation.id === conversationId &&
      status !== "submitted" &&
      status !== "streaming" &&
      backendMessages.length >= messages.length &&
      (loadedConversationRef.current !== conversationId ||
        messages.length === 0 ||
        !areConversationMessagesSynced(messages, backendMessages));

    if (shouldSync) {
      setMessages(backendMessages);
      loadedConversationRef.current = conversationId;
    }
  }, [conversation, conversationId, messages, setMessages, status]);

  useLayoutEffect(() => {
    if (status === "ready" && conversation?.id && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [conversation?.id, status]);

  useEffect(() => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, []);

  const handleModelChange = useCallback(
    (modelId: string) => {
      if (!conversation) return;

      const provider = chatModels.find((item) => item.id === modelId)?.provider;
      updateConversationMutation.mutate({
        id: conversation.id,
        selectedModel: modelId,
        selectedProvider: provider,
      });
    },
    [chatModels, conversation, updateConversationMutation],
  );

  const handleProviderChange = useCallback(
    (provider: SupportedProvider, chatApiKeyId: string) => {
      if (!conversation) return;

      const providerModels = modelsByProvider[provider];
      const bestModel =
        providerModels?.find((item) => item.isBest) ?? providerModels?.[0];

      updateConversationMutation.mutate({
        id: conversation.id,
        chatApiKeyId,
        selectedModel: bestModel?.id,
        selectedProvider: bestModel ? provider : undefined,
      });
    },
    [conversation, modelsByProvider, updateConversationMutation],
  );

  const handleSubmit = useCallback(
    (
      message: {
        text?: string;
        files?: Array<{ url: string; mediaType: string; filename?: string }>;
      },
      event: FormEvent<HTMLFormElement>,
    ) => {
      event.preventDefault();

      if (isRunActive) {
        return;
      }

      if (status === "submitted" || status === "streaming") {
        if (conversationId) {
          stopChatStreamMutation.mutateAsync(conversationId).finally(() => {
            stop?.();
          });
        } else {
          stop?.();
        }
        return;
      }

      const hasText = message.text?.trim();
      const hasFiles = message.files && message.files.length > 0;

      if (!sendMessage || (!hasText && !hasFiles)) {
        return;
      }

      if (setMessages) {
        const hasPendingApprovals = messages.some((chatMessage) =>
          chatMessage.parts.some(
            (part) => "state" in part && part.state === "approval-requested",
          ),
        );

        if (hasPendingApprovals) {
          setMessages(
            messages.map((chatMessage) => ({
              ...chatMessage,
              parts: chatMessage.parts.map((part) =>
                "state" in part && part.state === "approval-requested"
                  ? {
                      ...part,
                      state: "output-denied" as const,
                      output:
                        "Tool approval was skipped because the user sent a new message",
                    }
                  : part,
              ),
            })) as UIMessage[],
          );
        }
      }

      const parts: Array<
        | { type: "text"; text: string }
        | { type: "file"; url: string; mediaType: string; filename?: string }
      > = [];

      if (hasText) {
        parts.push({ type: "text", text: message.text as string });
      }

      if (hasFiles) {
        for (const file of message.files ?? []) {
          parts.push({
            type: "file",
            url: file.url,
            mediaType: file.mediaType,
            filename: file.filename,
          });
        }
      }

      sendMessage({
        role: "user",
        parts,
      });
    },
    [
      conversationId,
      messages,
      sendMessage,
      setMessages,
      status,
      stop,
      stopChatStreamMutation,
      isRunActive,
    ],
  );

  const isLoadingPage = triggerLoading || runLoading;
  const activeAgentId = conversation?.agentId ?? trigger?.agentId ?? undefined;
  const activeAgentName =
    conversation?.agent?.name ??
    internalAgents.find((agent) => agent.id === activeAgentId)?.name ??
    trigger?.agent?.name ??
    "Scheduled agent";

  if (isLoadingPage) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading scheduled run...
      </div>
    );
  }

  if (!trigger || !run) {
    return (
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4 rounded-xl border bg-background p-6 shadow-sm">
        <p className="text-sm font-medium text-foreground">Run not found</p>
        <p className="text-sm text-muted-foreground">
          The scheduled trigger or run could not be loaded.
        </p>
        <div>
          <Button variant="outline" asChild>
            <Link href="/scheduled-tasks">Back to schedules</Link>
          </Button>
        </div>
      </div>
    );
  }

  const humanCadence = formatCronSchedule(trigger.cronExpression);

  return (
    <div
      className={cn(
        "mr-auto flex w-full flex-col gap-4",
        isArtifactOpen ? "max-w-[1520px]" : "max-w-[1080px]",
      )}
    >
      {/* Header */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            asChild
            className="h-7 px-2 text-muted-foreground"
          >
            <Link href={`/scheduled-tasks/${trigger.id}`}>
              <ArrowLeft className="mr-1 h-3.5 w-3.5" />
              {trigger.name}
            </Link>
          </Button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-lg font-semibold tracking-tight">
              Run {run.runKind}
            </h1>
            <StatusBadge label={run.status} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {run.artifact && (
              <Button
                variant={isArtifactOpen ? "secondary" : "outline"}
                size="sm"
                onClick={() => setIsArtifactOpen((prev) => !prev)}
              >
                <FileText className="mr-1.5 h-3.5 w-3.5" />
                Artifact
              </Button>
            )}
            {conversationId && (
              <Button variant="outline" size="sm" asChild>
                <Link
                  href={`/chat?conversation=${conversationId}&scheduleTriggerId=${trigger.id}&scheduleRunId=${run.id}`}
                >
                  Continue in chat
                </Link>
              </Button>
            )}
            <Button variant="ghost" size="sm" asChild>
              <Link
                href={`/llm/logs/session/${encodeURIComponent(getScheduleTriggerRunSessionId(run.id))}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Session logs
                <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          {activeAgentName} · {humanCadence} · {trigger.timezone}
          {run.createdAt && (
            <> · queued {formatRelativeTimeFromNow(run.createdAt)}</>
          )}
          {run.completedAt && (
            <> · completed {formatRelativeTimeFromNow(run.completedAt)}</>
          )}
        </p>
      </div>

      {/* Collapsible details: prompt snapshot + metadata */}
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
        <button
          type="button"
          className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent/5"
          onClick={() => setShowDetails((prev) => !prev)}
        >
          <span>Prompt &amp; run details</span>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              showDetails && "rotate-180",
            )}
          />
        </button>

        {showDetails && (
          <div className="border-t border-border/60 px-4 py-4 space-y-4">
            {/* Prompt snapshot */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Prompt
              </p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                {trigger.messageTemplate}
              </p>
            </div>

            {/* Metadata grid */}
            <div className="grid gap-x-8 gap-y-3 sm:grid-cols-3">
              <DetailItem label="Agent" value={activeAgentName} />
              <DetailItem label="Schedule" value={humanCadence} />
              <DetailItem label="Timezone" value={trigger.timezone} />
              <DetailItem
                label="Queued"
                value={run.createdAt ? formatTimestamp(run.createdAt) : "—"}
              />
              <DetailItem
                label="Started"
                value={
                  run.startedAt ? formatTimestamp(run.startedAt) : "Not started"
                }
              />
              <DetailItem
                label="Completed"
                value={
                  run.completedAt
                    ? formatTimestamp(run.completedAt)
                    : "In progress"
                }
              />
            </div>
          </div>
        )}
      </div>

      {/* Chat thread + optional artifact panel */}
      <div className="flex gap-4">
        <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-border/60 bg-background">
          {isRunActive && (
            <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Run in progress — conversation unlocks when complete
            </div>
          )}

          {(!conversationId && ensureConversationMutation.isPending) ||
          (!conversationBootstrapError &&
            !!conversationId &&
            conversationLoading) ? (
            <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Preparing conversation
            </div>
          ) : null}

          <div className="flex min-h-[60vh] flex-col">
            {conversationId ? (
              <>
                <div className="min-h-0 flex-1 px-3 md:px-4">
                  <ChatMessages
                    conversationId={conversationId}
                    agentId={activeAgentId}
                    messages={messages}
                    status={status}
                    optimisticToolCalls={optimisticToolCalls}
                    isLoadingConversation={conversationLoading}
                    onMessagesUpdate={setMessages}
                    error={error}
                    agentName={activeAgentName}
                    selectedModel={conversation?.selectedModel ?? ""}
                    onToolApprovalResponse={
                      addToolApprovalResponse
                        ? ({ id, approved, reason }) => {
                            addToolApprovalResponse({ id, approved, reason });
                          }
                        : undefined
                    }
                  />
                </div>

                {activeAgentId && conversation ? (
                  <div className="sticky bottom-0 border-t border-border/60 bg-background/98 p-4 backdrop-blur-sm">
                    <div className="mx-auto w-full max-w-4xl">
                      {isRunActive ? (
                        <div className="flex items-center justify-center gap-2 rounded-xl border border-border/60 bg-muted/20 px-4 py-4 text-sm text-muted-foreground">
                          <LoadingSpinner />
                          <span>Waiting for run to finish...</span>
                        </div>
                      ) : ensureConversationMutation.isPending ? (
                        <div className="flex items-center justify-center gap-2 rounded-xl border border-border/60 bg-muted/20 px-4 py-4 text-sm text-muted-foreground">
                          <LoadingSpinner />
                          <span>Syncing run output...</span>
                        </div>
                      ) : (
                        <ArchestraPromptInput
                          onSubmit={handleSubmit}
                          status={status}
                          selectedModel={conversation.selectedModel ?? ""}
                          onModelChange={handleModelChange}
                          agentId={activeAgentId}
                          conversationId={conversationId}
                          currentConversationChatApiKeyId={
                            conversation.chatApiKeyId
                          }
                          currentProvider={currentProvider}
                          textareaRef={textareaRef}
                          onProviderChange={handleProviderChange}
                          allowFileUploads={
                            organization?.allowChatFileUploads ?? false
                          }
                          tokensUsed={tokensUsed}
                          maxContextLength={selectedModelContextLength}
                          inputModalities={selectedModelInputModalities}
                          agentLlmApiKeyId={
                            conversation.agent?.llmApiKeyId ?? null
                          }
                          submitDisabled={false}
                          isPlaywrightSetupVisible={false}
                        />
                      )}
                    </div>
                  </div>
                ) : null}
              </>
            ) : conversationBootstrapError ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
                <p className="text-sm text-muted-foreground">
                  {conversationBootstrapError}
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    bootstrapRequestedRef.current = false;
                    recoveryAttemptedRef.current = false;
                    setBootstrappedConversationId(null);
                    void ensureConversation();
                  }}
                  disabled={ensureConversationMutation.isPending}
                >
                  Retry
                </Button>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center px-6 py-16 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating conversation...
                </div>
              </div>
            )}
          </div>
        </div>

        {isArtifactOpen && run.artifact && (
          <div className="w-[400px] shrink-0 overflow-hidden rounded-xl border border-border/60">
            <ConversationArtifactPanel
              artifact={run.artifact}
              isOpen={isArtifactOpen}
              onToggle={() => setIsArtifactOpen(false)}
              embedded
            />
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Small helpers ─── */

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground">{value}</p>
    </div>
  );
}

function StatusBadge({ label }: { label: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-border/60 px-2 py-0.5 text-xs capitalize",
        label === "success" &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
        label === "failed" &&
          "border-destructive/30 bg-destructive/10 text-destructive",
        label === "running" &&
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      {label}
    </Badge>
  );
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
