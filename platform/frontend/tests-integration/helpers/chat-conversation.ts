const NOW = "2026-09-18T12:00:00.000Z";

/**
 * A conversation as `/api/chat/conversations/:id` returns it, with
 * `messageCount` alternating user/assistant text messages ("Turn 0" …).
 */
export function makeConversation(params: {
  id: string;
  title: string;
  agentId: string;
  messageCount: number;
  userId?: string;
}) {
  const { id, title, agentId, messageCount } = params;
  return {
    id,
    userId: params.userId ?? "test-user-admin",
    organizationId: "test-org",
    agentId,
    title,
    titleIsPlaceholder: false,
    origin: "user",
    projectId: null,
    modelId: null,
    selectedModel: "gpt-4o",
    selectedProvider: "openai",
    chatApiKeyId: null,
    thinkingEffort: null,
    hasCustomToolSelection: false,
    hooksDebugEnabled: false,
    encryptedChat: false,
    todoList: null,
    artifact: null,
    pinnedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastMessageAt: NOW,
    deletedAt: null,
    agent: {
      id: agentId,
      name: "Load agent",
      agentType: "agent",
      systemPrompt: null,
      toolExposureMode: "full",
      llmApiKeyId: null,
    },
    share: null,
    unread: false,
    chatErrors: [],
    compactions: [],
    messages: Array.from({ length: messageCount }, (_, i) => ({
      id: `${id}-m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [
        {
          type: "text",
          text: `Turn ${i}. ${"A paragraph long enough to wrap onto a few lines in the transcript. ".repeat(3)}`,
        },
      ],
    })),
  };
}
