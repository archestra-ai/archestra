"use client";

import { OPENAPPA_CONFIG_SUGGESTED_PROMPTS } from "@archestra/shared";
import type { UIMessage } from "ai";
import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ChatLandingLayout } from "@/app/chat/chat-landing-layout";
import ArchestraPromptInput from "@/app/chat/prompt-input";
import { SuggestedPromptPills } from "@/app/chat/suggested-prompt-pills";
import { ApiKeyLoadError } from "@/components/api-key-load-error";
import { ChatMessages } from "@/components/chat/chat-messages";
import { NoApiKeySetup } from "@/components/no-api-key-setup";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useConversation, useCreateConversation } from "@/lib/chat/chat.query";
import { useChatSession } from "@/lib/chat/global-chat.context";
import {
  setPendingProjectChatHandoff,
  takePendingProjectChatHandoff,
} from "@/lib/chat/pending-project-chat-handoff";
import { useLlmModels } from "@/lib/llm-models.query";
import { useHasAnyApiKey } from "@/lib/llm-provider-api-keys.query";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";

export function PolicyChatStarter({
  initialPrompt,
  conversationId,
  onConversationStart,
}: {
  initialPrompt?: string;
  conversationId?: string;
  onConversationStart?: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [suggestionPreview, setSuggestionPreview] = useState<string | null>(
    null,
  );
  const pendingPrompt = useRef<string | null>(null);
  const autoStarted = useRef(false);
  const { hasAnyApiKey, isLoading, isLoadError, refetch } = useHasAnyApiKey();
  const models = useLlmModels({ enabled: hasAnyApiKey });
  const createConversation = useCreateConversation();
  const conversation = useConversation(conversationId);
  const isPolicyConversation = conversation.data?.origin === "openappa";
  const selectedModel = conversation.data?.modelId ?? "";
  const modelName = models.data?.find(
    (model) => model.dbId === selectedModel,
  )?.displayName;
  const session = useChatSession({
    conversationId,
    initialMessages: conversation.data?.messages as UIMessage[] | undefined,
    enabled: isPolicyConversation,
  });

  useEffect(() => {
    if (conversationId && conversation.data && !isPolicyConversation) {
      router.replace(`/chat/${encodeURIComponent(conversationId)}`);
    }
  }, [conversationId, conversation.data, isPolicyConversation, router]);

  useEffect(() => {
    if (!conversationId) return;
    const handoff = takePendingProjectChatHandoff(conversationId);
    if (handoff) pendingPrompt.current = handoff.prompt;
  }, [conversationId]);

  useEffect(() => {
    if (!session || !pendingPrompt.current) return;
    const text = pendingPrompt.current;
    pendingPrompt.current = null;
    startTransition(() => {
      session.sendMessage({
        role: "user",
        parts: [{ type: "text", text }],
        metadata: { createdAt: new Date().toISOString() },
      });
    });
  }, [session]);

  const sync = useAppaGithubSync();
  const usesGitHub = Boolean(sync.data?.source?.interval);
  const githubAppReady = Boolean(sync.data?.source?.githubAppConfigId);
  const submit = useCallback(
    async (request: string) => {
      const text = request.trim();
      if (!text) return;
      setError(null);
      if (session) {
        session.sendMessage({
          role: "user",
          parts: [{ type: "text", text }],
          metadata: { createdAt: new Date().toISOString() },
        });
        return;
      }
      try {
        const created = await createConversation.mutateAsync({
          origin: "openappa",
        });
        if (!created)
          throw new Error("Could not start the policy conversation");
        setPendingProjectChatHandoff({
          conversationId: created.id,
          prompt: text,
        });
        onConversationStart?.();
        router.push(`/openappa/${encodeURIComponent(created.id)}`);
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Could not start chat",
        );
      }
    },
    [session, createConversation, onConversationStart, router],
  );

  useEffect(() => {
    if (
      autoStarted.current ||
      !initialPrompt ||
      conversationId ||
      !hasAnyApiKey ||
      createConversation.isPending
    )
      return;
    autoStarted.current = true;
    void submit(initialPrompt);
  }, [
    initialPrompt,
    conversationId,
    hasAnyApiKey,
    createConversation.isPending,
    submit,
  ]);

  const composer = (active: boolean) => (
    <ArchestraPromptInput
      minimalMode
      fixedAgentName="OpenAPPA Configuration Agent"
      fixedModelName={
        modelName ??
        (conversationId ? "Model unavailable" : "Selected automatically")
      }
      placeholderPreview={suggestionPreview}
      placeholderOverride="Ask about or change your policy…"
      agentId={conversation.data?.agentId ?? null}
      conversationId={active ? conversationId : undefined}
      selectedModel={selectedModel}
      onModelChange={() => {}}
      status={
        active
          ? (session?.status ?? "ready")
          : createConversation.isPending
            ? "submitted"
            : "ready"
      }
      sendDisabled={!hasAnyApiKey || (active && !session)}
      onSubmit={({ text }) => void submit(text)}
      onStop={active ? () => session?.stop() : undefined}
    />
  );

  return (
    <section
      aria-label="Change OpenAPPA policy with chat"
      className={`flex min-h-0 flex-1 flex-col overflow-hidden ${conversationId ? "" : "pt-3"}`}
    >
      {usesGitHub && !githubAppReady && (
        <InlineNotice className="mb-3">
          <TriangleAlert />
          <span className="font-medium">GitHub App needed</span>
          <InlineNoticeText>
            Choose a GitHub App credential in OpenAPPA settings before the agent
            can open policy pull requests.
          </InlineNoticeText>
          <Button variant="outline" size="sm" className="ml-auto" asChild>
            <Link href="/settings/openappa">Open sync settings</Link>
          </Button>
        </InlineNotice>
      )}
      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : isLoadError ? (
        <ApiKeyLoadError onRetry={refetch} />
      ) : !hasAnyApiKey ? (
        <NoApiKeySetup
          description="Connect an LLM provider to configure OpenAPPA with chat"
          onKeyAdded={() => void refetch()}
        />
      ) : conversationId ? (
        <>
          <div className="min-h-0 flex-1 overflow-hidden">
            <ChatMessages
              conversationId={conversationId}
              agentId={conversation.data?.agentId ?? undefined}
              messages={
                session?.messages ??
                (conversation.data?.messages as UIMessage[] | undefined) ??
                []
              }
              status={session?.status ?? "ready"}
              optimisticToolCalls={session?.optimisticToolCalls}
              isLoadingConversation={!session}
              onMessagesUpdate={session?.setMessages}
              onToolApprovalResponse={session?.addToolApprovalResponse}
              selectedModel={selectedModel}
              error={session?.error}
            />
          </div>
          <div className="relative border-t transition-[transform,opacity] duration-300">
            <div className="sticky bottom-0 bg-background py-4">
              <div className="mx-auto w-full max-w-4xl">{composer(true)}</div>
            </div>
          </div>
        </>
      ) : (
        <ChatLandingLayout
          title="What should the policy do?"
          description={
            <>
              Describe a change. The agent will show you a diff before it{" "}
              {usesGitHub ? "opens a GitHub pull request" : "saves a revision"}.
            </>
          }
          suggestions={
            <SuggestedPromptPills
              prompts={[...OPENAPPA_CONFIG_SUGGESTED_PROMPTS]}
              align="start"
              disabled={createConversation.isPending}
              onPreviewChange={setSuggestionPreview}
              onSelect={({ prompt }) => void submit(prompt)}
            />
          }
        >
          <div className="transition-[transform,opacity] duration-300">
            {composer(false)}
          </div>
        </ChatLandingLayout>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
