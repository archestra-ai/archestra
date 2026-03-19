"use client";

import {
  Bot,
  CornerDownLeftIcon,
  MessageSquare,
  MicIcon,
  PaperclipIcon,
  Plus,
} from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { InitialAgentSelector } from "@/components/chat/initial-agent-selector";
import { LoadingSpinner } from "@/components/loading";
import MessageThread, {
  type PartialUIMessage,
} from "@/components/message-thread";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Version } from "@/components/version";
import { useInternalAgents } from "@/lib/agent.query";
import {
  useForkSharedConversation,
  useSharedConversation,
} from "@/lib/chat-share.query";
import { getConversationDisplayTitle } from "@/lib/chat-utils";

export default function SharedConversationPage() {
  const params = useParams<{ shareId: string }>();
  const router = useRouter();
  const shareId = params.shareId;

  // Hide AppShell's Version - this page renders its own
  useEffect(() => {
    document.body.classList.add("hide-version");
    return () => document.body.classList.remove("hide-version");
  }, []);

  const { data: conversation, isLoading } = useSharedConversation(shareId);
  const forkMutation = useForkSharedConversation();
  const { data: agents = [] } = useInternalAgents();

  const [showForkDialog, setShowForkDialog] = useState(false);
  const [forkAgentId, setForkAgentId] = useState<string | null>(null);

  const effectiveForkAgentId = forkAgentId ?? agents[0]?.id ?? null;

  const messages = useMemo(
    () => (conversation?.messages ?? []) as PartialUIMessage[],
    [conversation?.messages],
  );

  const title = useMemo(
    () =>
      conversation
        ? getConversationDisplayTitle(conversation.title, conversation.messages)
        : "Shared Conversation",
    [conversation],
  );

  const handleStartNewChat = useCallback(() => {
    setShowForkDialog(true);
  }, []);

  const handleFork = useCallback(async () => {
    if (!shareId || !effectiveForkAgentId) return;
    const result = await forkMutation.mutateAsync({
      shareId,
      agentId: effectiveForkAgentId,
    });
    if (result) {
      router.push(`/chat?conversation=${result.id}`);
    }
  }, [shareId, effectiveForkAgentId, forkMutation, router]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty>
          <EmptyMedia>
            <MessageSquare className="h-10 w-10 text-muted-foreground" />
          </EmptyMedia>
          <EmptyContent>
            <EmptyHeader>
              <EmptyTitle>Conversation not found</EmptyTitle>
            </EmptyHeader>
            <EmptyDescription>
              This shared conversation may have been removed or you don't have
              access.
            </EmptyDescription>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-svh">
      {/* Header */}
      <div className="flex-shrink-0 border-b">
        <div className="relative flex items-center justify-between px-4 py-2 h-12">
          {/* Left - readonly agent badge */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {conversation.agent ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Bot className="h-4 w-4" />
                <span>{conversation.agent.name}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Bot className="h-4 w-4" />
                <span className="italic">Deleted profile</span>
              </div>
            )}
          </div>

          {/* Center - title */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-sm text-muted-foreground truncate max-w-[400px]">
              {title}
            </span>
          </div>

          {/* Right - empty for symmetry */}
          <div className="flex-shrink-0" />
        </div>
      </div>

      {/* Messages - readonly, flex-1 with min-h-0 to constrain */}
      <div className="flex-1 min-h-0">
        <MessageThread
          messages={messages}
          containerClassName="h-full"
          hideDivider
          profileId={conversation.agent?.id}
        />
      </div>

      {/* Bottom - disabled input mimicking real prompt */}
      <div className="flex-shrink-0 border-t bg-background p-4 space-y-3">
        <div className="max-w-4xl mx-auto relative">
          {/* Disabled input that looks like the real prompt */}
          <div className="border-input dark:bg-input/30 relative flex w-full flex-col rounded-md border shadow-xs opacity-30 blur-[3px] pointer-events-none select-none">
            {/* Textarea area */}
            <div className="px-4 py-5 min-h-[120px]">
              <span className="text-sm text-muted-foreground">
                Type a message...
              </span>
            </div>
            {/* Footer with tools */}
            <div className="flex items-center justify-between w-full px-3 pb-3">
              <div className="flex items-center gap-1">
                <div className="size-8 flex items-center justify-center">
                  <PaperclipIcon className="size-4 text-muted-foreground" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="size-8 flex items-center justify-center">
                  <MicIcon className="size-4 text-muted-foreground" />
                </div>
                <div className="size-8 flex items-center justify-center rounded-md bg-primary">
                  <CornerDownLeftIcon className="size-4 text-primary-foreground" />
                </div>
              </div>
            </div>
          </div>
          {/* CTA overlay */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-auto">
            <Button onClick={handleStartNewChat}>
              <Plus className="h-4 w-4 mr-2" />
              Start New Chat from here
            </Button>
          </div>
        </div>
        <div className="text-center">
          <Version inline />
        </div>
      </div>

      {/* Fork dialog - select agent */}
      <StandardDialog
        open={showForkDialog}
        onOpenChange={setShowForkDialog}
        title="Start New Chat"
        description="Select an agent to start a new chat with the preloaded messages from this conversation."
        size="small"
        bodyClassName="py-1"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowForkDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleFork}
              disabled={!effectiveForkAgentId || forkMutation.isPending}
            >
              {forkMutation.isPending ? "Creating..." : "Start Chat"}
            </Button>
          </>
        }
      >
        <InitialAgentSelector
          currentAgentId={forkAgentId}
          onAgentChange={setForkAgentId}
        />
      </StandardDialog>
    </div>
  );
}
