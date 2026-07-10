/**
 * Human label for a ChatOps-originated conversation (origin "chatops:*"),
 * or null for web/scheduled chats. Origins are the closed enum produced by
 * the backend's ConversationOriginSchema.
 */
export function chatOpsOriginLabel(origin: string): string | null {
  switch (origin) {
    case "chatops:slack":
      return "Slack";
    case "chatops:ms-teams":
      return "Teams";
    case "chatops:telegram":
      return "Telegram";
    default:
      return null;
  }
}

/**
 * "Author · via Slack" label for a message another participant sent from a
 * ChatOps thread, read from the persisted `metadata.chatops` provenance.
 * Null for plain web turns (no chip is rendered).
 */
export function chatOpsAuthorLabel(metadata: unknown): string | null {
  const chatops = (
    metadata as
      | { chatops?: { authorName?: string; source?: string } }
      | null
      | undefined
  )?.chatops;
  if (!chatops?.authorName) {
    return null;
  }
  const via = chatops.source ? chatOpsOriginLabel(chatops.source) : null;
  return via ? `${chatops.authorName} · via ${via}` : chatops.authorName;
}
