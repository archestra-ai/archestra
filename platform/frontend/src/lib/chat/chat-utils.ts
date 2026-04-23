import type { archestraApiTypes } from "@shared";

const DEFAULT_SESSION_NAME = "New Chat Session";

export type ConversationShareVisibility = NonNullable<
  archestraApiTypes.GetChatConversationsResponses["200"][number]["share"]
>["visibility"];

/**
 * Builds the external agent ID header value for chat requests.
 * Strips non-ISO-8859-1 characters since HTTP headers reject them.
 */
export function getChatExternalAgentId(appName: string): string {
  const id = `${appName} Chat`;
  return id
    .replace(/[^\x20-\xff]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

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

export function getConversationShareTooltip(
  visibility: ConversationShareVisibility | undefined,
) {
  if (visibility === "team") {
    return "Shared with selected teams";
  }

  if (visibility === "user") {
    return "Shared with selected users";
  }

  return "Shared with your organization";
}
