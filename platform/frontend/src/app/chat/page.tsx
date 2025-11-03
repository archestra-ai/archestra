"use client";

import { type UIMessage, useChat } from "@ai-sdk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DefaultChatTransport } from "ai";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ConversationList } from "@/components/chat/conversation-list";
import { PromptSuggestions } from "@/components/chat/prompt-suggestions";

interface Conversation {
  id: string;
  title: string | null;
  selectedModel: string;
  userId: string;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
}

interface ConversationWithMessages extends Conversation {
  messages: UIMessage[];
}

export default function ChatPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const [conversationId, setConversationId] = useState<string>();
  const [input, setInput] = useState("");
  const loadedConversationRef = useRef<string>();

  // Initialize conversation ID from URL on mount
  useEffect(() => {
    const conversationParam = searchParams.get("conversation");
    if (conversationParam && conversationParam !== conversationId) {
      setConversationId(conversationParam);
    }
  }, [searchParams, conversationId]);

  // Update URL when conversation changes
  const selectConversation = (id: string | undefined) => {
    setConversationId(id);
    if (id) {
      router.push(`${pathname}?conversation=${id}`);
    } else {
      router.push(pathname);
    }
  };

  // Fetch conversations
  const { data: conversations = [] } = useQuery<Conversation[]>({
    queryKey: ["conversations"],
    queryFn: async () => {
      const res = await fetch("/api/chat/conversations");
      if (!res.ok) throw new Error("Failed to fetch conversations");
      return res.json();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes - don't refetch unless explicitly invalidated
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: false, // Don't refetch when window gains focus
  });

  // Fetch conversation with messages
  const { data: conversation } = useQuery<ConversationWithMessages>({
    queryKey: ["conversation", conversationId],
    queryFn: async () => {
      if (!conversationId) return null;
      const res = await fetch(`/api/chat/conversations/${conversationId}`);
      if (!res.ok) throw new Error("Failed to fetch conversation");
      return res.json();
    },
    enabled: !!conversationId,
    staleTime: 0, // Always refetch to ensure we have the latest messages
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: false, // Don't refetch when window gains focus
  });

  // Create conversation mutation
  const createConversation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/chat/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Failed to create conversation");
      return res.json();
    },
    onSuccess: (newConversation) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      selectConversation(newConversation.id);
    },
  });

  // Delete conversation mutation
  const deleteConversation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/chat/conversations/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete conversation");
      return res.json();
    },
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.removeQueries({ queryKey: ["conversation", deletedId] });

      // If we deleted the selected conversation, clear the selection
      if (conversationId === deletedId) {
        setConversationId(undefined);
        setMessages([]);
        router.push(pathname);
      }
    },
  });

  // useChat hook for streaming (AI SDK 5.0 - manages messages only)
  const { messages, sendMessage, status, stop, setMessages } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat", // Must match backend route
      credentials: "include", // Send cookies for authentication
    }),
    id: conversationId,
    onFinish: () => {
      // Invalidate the conversation query to refetch with new messages
      if (conversationId) {
        queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      }
    },
  });

  // Sync messages when conversation loads or changes
  useEffect(() => {
    // When switching to a different conversation, reset the loaded ref
    if (loadedConversationRef.current !== conversationId) {
      loadedConversationRef.current = undefined;
    }

    // If we have conversation data and haven't synced it yet, sync it
    if (
      conversation?.messages &&
      conversation.id === conversationId &&
      loadedConversationRef.current !== conversationId
    ) {
      setMessages(conversation.messages);
      loadedConversationRef.current = conversationId;
    } else if (conversationId && !conversation) {
      // Clear messages when switching to a conversation that's loading
      setMessages([]);
    }
  }, [conversationId, conversation, setMessages]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!input.trim() || status === "submitted" || status === "streaming") {
      return;
    }

    sendMessage({
      role: "user",
      parts: [{ type: "text", text: input }],
    });
    setInput("");
  };

  const handleSelectPrompt = (prompt: string) => {
    // Send the message directly instead of just filling the input
    if (status === "submitted" || status === "streaming") {
      return;
    }

    sendMessage({
      role: "user",
      parts: [{ type: "text", text: prompt }],
    });
  };

  const isLoading = status === "submitted" || status === "streaming";

  return (
    <div className="flex h-screen">
      {/* Sidebar - Conversation List */}
      <ConversationList
        conversations={conversations}
        selectedConversationId={conversationId}
        onSelectConversation={selectConversation}
        onCreateConversation={() => createConversation.mutate()}
        onDeleteConversation={(id) => deleteConversation.mutate(id)}
        isCreatingConversation={createConversation.isPending}
      />

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {!conversationId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <p className="text-lg mb-2">No conversation selected</p>
              <p className="text-sm">Create a new chat to get started</p>
            </div>
          </div>
        ) : (
          <>
            {messages.length === 0 ? (
              <PromptSuggestions onSelectPrompt={handleSelectPrompt} />
            ) : (
              <ChatMessages messages={messages} />
            )}
            <ChatInput
              input={input}
              onInputChange={(e) => setInput(e.target.value)}
              onSubmit={handleSubmit}
              onStop={stop}
              isLoading={isLoading}
            />
          </>
        )}
      </div>
    </div>
  );
}
