const DEFAULT_SESSION_NAME = "New Chat Session";

/**
 * Generates localStorage keys scoped to a specific conversation.
 * Use this everywhere conversation-specific keys are read/written/removed
 * so that key formats stay in sync (especially for cleanup on deletion).
 */
export function conversationStorageKeys(conversationId: string) {
  return {
    artifactOpen: `archestra-chat-artifact-open-${conversationId}`,
    draft: `archestra_chat_draft_${conversationId}`,
  };
}

/**
 * Extracts a display title for a conversation.
 * Priority: explicit title > first user message > default session name
 */
export function getConversationDisplayTitle(
  title: string | null,
  // biome-ignore lint/suspicious/noExplicitAny: UIMessage structure from AI SDK is dynamic
  messages?: any[],
): string {
  if (title) return title;

  // Try to extract from first user message
  if (messages && messages.length > 0) {
    for (const msg of messages) {
      if (msg.role === "user" && msg.parts) {
        for (const part of msg.parts) {
          if (part.type === "text" && part.text) {
            return part.text;
          }
        }
      }
    }
  }

  return DEFAULT_SESSION_NAME;
}
