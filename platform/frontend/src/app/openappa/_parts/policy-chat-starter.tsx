"use client";

import { OPENAPPA_CONFIG_SUGGESTED_PROMPTS } from "@archestra/shared";
import type { UIMessage } from "ai";
import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import {
  startTransition,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import ArchestraPromptInput from "@/app/chat/prompt-input";
import { SuggestedPromptPills } from "@/app/chat/suggested-prompt-pills";
import { ApiKeyLoadError } from "@/components/api-key-load-error";
import { ChatMessages } from "@/components/chat/chat-messages";
import { NoApiKeySetup } from "@/components/no-api-key-setup";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useConversation,
  useCreateConversation,
  useUpdateConversation,
} from "@/lib/chat/chat.query";
import { useChatSession } from "@/lib/chat/global-chat.context";
import { useLlmModels } from "@/lib/llm-models.query";
import { useHasAnyApiKey } from "@/lib/llm-provider-api-keys.query";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";

export function PolicyChatStarter({
  initialConversationId,
  onConversationStart,
}: {
  initialConversationId?: string;
  onConversationStart?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [suggestionPreview, setSuggestionPreview] = useState<string | null>(
    null,
  );
  const [conversationId, setConversationId] = useState(initialConversationId);
  const pendingPrompt = useRef<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [chatLayout, setChatLayout] = useState<{
    height: number;
    dividerLeft: number;
    dividerWidth: number;
  }>();
  const { hasAnyApiKey, isLoading, isLoadError, refetch } = useHasAnyApiKey();
  const models = useLlmModels({ enabled: hasAnyApiKey });
  const createConversation = useCreateConversation();
  const updateConversation = useUpdateConversation();
  const conversation = useConversation(conversationId);
  const session = useChatSession({
    conversationId,
    initialMessages: conversation.data?.messages as UIMessage[] | undefined,
    enabled: Boolean(conversation.data),
  });

  useEffect(() => {
    if (selectedModel || !models.data?.length) return;
    setSelectedModel(
      models.data.find((model) => model.isBest)?.dbId ?? models.data[0].dbId,
    );
  }, [models.data, selectedModel]);

  useEffect(() => {
    if (conversation.data?.modelId) {
      setSelectedModel(conversation.data.modelId);
    }
  }, [conversation.data?.modelId]);

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
    if (conversationId && !initialConversationId) {
      window.history.replaceState(null, "", `/openappa/${conversationId}`);
    }
  }, [session, conversationId, initialConversationId]);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    const scrollContainer = document.querySelector(
      "[data-page-scroll-container]",
    );
    const main = document.querySelector("#main-content");
    if (!section || !scrollContainer || !main) return;
    const measure = () => {
      const sectionRect = section.getBoundingClientRect();
      const mainRect = main.getBoundingClientRect();
      const scrollRect = scrollContainer.getBoundingClientRect();
      setChatLayout({
        // The app footer takes 3rem and PageLayout adds 1.5rem of bottom padding.
        height: Math.max(288, scrollRect.bottom - sectionRect.top - 72),
        dividerLeft: mainRect.left - sectionRect.left,
        dividerWidth: mainRect.width,
      });
    };
    const observer = new ResizeObserver(measure);
    const notices = document.querySelector("[data-openappa-notices]");
    if (notices) observer.observe(notices);
    observer.observe(main);
    observer.observe(scrollContainer);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const sync = useAppaGithubSync();
  const usesGitHub = Boolean(sync.data?.source?.interval);
  const githubAppReady = Boolean(sync.data?.source?.githubAppConfigId);
  const submit = async (request: string) => {
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
    if (!selectedModel) return;
    try {
      pendingPrompt.current = text;
      const created = await createConversation.mutateAsync({
        modelId: selectedModel,
        origin: "openappa",
      });
      if (!created) throw new Error("Could not start the policy conversation");
      onConversationStart?.();
      startTransition(() => setConversationId(created.id));
    } catch (cause) {
      pendingPrompt.current = null;
      setError(cause instanceof Error ? cause.message : "Could not start chat");
    }
  };
  const changeModel = (modelId: string) => {
    setSelectedModel(modelId);
    if (conversationId) {
      void updateConversation
        .mutateAsync({ id: conversationId, modelId })
        .catch((cause) =>
          setError(
            cause instanceof Error ? cause.message : "Could not change model",
          ),
        );
    }
  };

  const composer = (active: boolean) => (
    <ArchestraPromptInput
      minimalMode
      fixedAgentName="OpenAPPA Configuration Agent"
      placeholderPreview={suggestionPreview}
      placeholderOverride="Ask about or change your policy…"
      agentId={conversation.data?.agentId ?? null}
      conversationId={active ? conversationId : undefined}
      selectedModel={selectedModel}
      onModelChange={changeModel}
      status={
        active
          ? (session?.status ?? "ready")
          : createConversation.isPending
            ? "submitted"
            : "ready"
      }
      sendDisabled={
        !selectedModel ||
        models.isPending ||
        updateConversation.isPending ||
        (active && !session)
      }
      onSubmit={({ text }) => void submit(text)}
      onStop={active ? () => session?.stop() : undefined}
    />
  );

  return (
    <section
      ref={sectionRef}
      aria-label="Change OpenAPPA policy with chat"
      className={`flex min-h-72 flex-col overflow-hidden ${conversationId ? "" : "pt-3"}`}
      style={chatLayout ? { height: chatLayout.height } : undefined}
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
      ) : models.isError ? (
        <QueryLoadError
          title="Could not load policy chat"
          onRetry={() => {
            void models.refetch();
          }}
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
          <div className="relative transition-[transform,opacity] duration-300">
            <div
              aria-hidden="true"
              className="absolute top-0 h-px bg-border"
              style={{
                left: chatLayout?.dividerLeft,
                width: chatLayout?.dividerWidth,
              }}
            />
            <div className="sticky bottom-0 bg-background py-4">
              <div className="mx-auto w-full max-w-4xl">{composer(true)}</div>
            </div>
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-5">
          <div className="mx-auto w-full max-w-4xl">
            <h2 className="text-xl font-semibold tracking-tight">
              What should the policy do?
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Describe a change. The agent will show you a diff before it{" "}
              {usesGitHub ? "opens a GitHub pull request" : "saves a revision"}.
            </p>
          </div>
          <div className="mx-auto w-full max-w-4xl">
            <SuggestedPromptPills
              prompts={[...OPENAPPA_CONFIG_SUGGESTED_PROMPTS]}
              align="start"
              disabled={!selectedModel}
              onPreviewChange={setSuggestionPreview}
              onSelect={({ prompt }) => void submit(prompt)}
            />
          </div>
          <div className="transition-[transform,opacity] duration-300">
            <div className="mx-auto w-full max-w-4xl">{composer(false)}</div>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
