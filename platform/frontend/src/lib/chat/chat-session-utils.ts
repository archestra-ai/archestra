import type { UIMessage } from "@ai-sdk/react";
import { hasRenderableAssistantContent } from "@archestra/shared";

/**
 * Preserves the last renderable assistant content when a live session update
 * temporarily regresses after streaming, either by replacing the assistant
 * message with an empty payload or by dropping the assistant tail entirely.
 *
 * This guards against a transient UI regression where streamed assistant text
 * briefly appears, then disappears until persisted session data catches up.
 * We only restore when the new session state is clearly a regression, and we
 * return the original `nextMessages` array unchanged when no restoration is
 * needed to avoid unnecessary re-renders.
 */
export function restoreRenderableAssistantParts(params: {
  previousMessages: UIMessage[];
  nextMessages: UIMessage[];
}): UIMessage[] {
  const { previousMessages, nextMessages } = params;
  const restoredMessageTail = restoreTruncatedAssistantTail({
    previousMessages,
    nextMessages,
  });
  if (restoredMessageTail !== nextMessages) {
    return restoredMessageTail;
  }

  let changed = false;

  const restoredMessages = nextMessages.map((message, index) => {
    if (message.role !== "assistant" || hasRenderableAssistantParts(message)) {
      return message;
    }

    const previousMessage = findPreviousRenderableAssistantMessage({
      previousMessages,
      nextMessages,
      nextMessage: message,
      index,
    });
    if (
      previousMessage?.role !== "assistant" ||
      !hasRenderableAssistantParts(previousMessage)
    ) {
      return message;
    }

    changed = true;
    return {
      ...message,
      parts: previousMessage.parts,
    };
  });

  if (!changed) {
    return nextMessages;
  }

  // While a non-renderable assistant persists (e.g. reconnecting to an in-flight
  // tool call on reload), this restoration runs on every render and would hand
  // back a fresh array each time. That churns the caller's stableMessages
  // identity, which re-fires the session-sync effect → setSessionVersion →
  // re-render in a storm that crashes the chat view (React #185, "Maximum update
  // depth"). previousMessages is the prior render's restored output, so when the
  // rebuild is structurally identical, reuse it to keep the reference stable.
  if (messagesShallowEqual(restoredMessages, previousMessages)) {
    return previousMessages;
  }

  return restoredMessages;
}

// Compares every field of UIMessage (id, role, metadata, parts) so reusing the
// previous reference can never silently drop a non-parts update — e.g. an
// assistant message gaining its metadata.persistedMessageId after streaming,
// which edit/regeneration relies on to target the right persisted row. parts and
// metadata are compared by reference: a genuine change produces a new reference,
// while a stable render reuses them, so this stays both correct and cheap.
function messagesShallowEqual(a: UIMessage[], b: UIMessage[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((message, index) => {
    const other = b[index];
    return (
      !!other &&
      message.id === other.id &&
      message.role === other.role &&
      message.metadata === other.metadata &&
      message.parts === other.parts
    );
  });
}

/**
 * While a session auto-recovers from a severed stream (auto-retry or
 * reattaching to the still-running response), the live message list passes
 * through ugly intermediate states: regenerate() drops the partial assistant
 * answer, and the replay rebuilds it from scratch a moment later. Rendering
 * those states blinks the streamed text away and back. Instead, the UI keeps
 * showing the frozen pre-recovery snapshot until the recovered stream has
 * renderable assistant content again — the replay delivers its whole backlog
 * in the first batch, so the swap happens at full length with no visible gap.
 */
export function shouldFreezeChatMessages(params: {
  isRecovering: boolean;
  liveMessages: UIMessage[];
  frozenMessages: UIMessage[];
}): boolean {
  const { isRecovering, liveMessages, frozenMessages } = params;
  if (!isRecovering || frozenMessages.length === 0) {
    return false;
  }

  const lastMessage = liveMessages.at(-1);
  // Once the recovered stream renders assistant content again, the live list
  // has caught up with (or passed) the frozen snapshot — stop freezing.
  return !(
    lastMessage?.role === "assistant" &&
    hasRenderableAssistantContent(lastMessage)
  );
}

/**
 * Drops a trailing assistant message left with no renderable content. Mirrors the
 * backend's persist behavior (an empty last message is not stored), keeping the live
 * view consistent with what a reload would show — used after stripping dangling tool
 * parts from a stopped turn, which can leave only `step-start`/telemetry parts behind.
 */
export function pruneEmptyTrailingAssistantMessage(
  messages: UIMessage[],
): UIMessage[] {
  const lastMessage = messages.at(-1);
  if (
    lastMessage?.role === "assistant" &&
    !hasRenderableAssistantContent(lastMessage)
  ) {
    return messages.slice(0, -1);
  }
  return messages;
}

// shared with the backend persist path so the live view and what a reload shows
// agree on what counts as renderable.
function hasRenderableAssistantParts(message: UIMessage): boolean {
  return hasRenderableAssistantContent(message);
}

function findPreviousRenderableAssistantMessage(params: {
  previousMessages: UIMessage[];
  nextMessages: UIMessage[];
  nextMessage: UIMessage;
  index: number;
}): UIMessage | undefined {
  const { previousMessages, nextMessages, nextMessage, index } = params;
  const previousMessageById = previousMessages.find(
    (message) => message.role === "assistant" && message.id === nextMessage.id,
  );
  if (previousMessageById) {
    return previousMessageById;
  }

  const previousMessageAtIndex = previousMessages[index];
  if (
    index > 0 &&
    previousMessageAtIndex?.role === "assistant" &&
    nextMessages
      .slice(0, index)
      .every(
        (message, messageIndex) => previousMessages[messageIndex] === message,
      )
  ) {
    return previousMessageAtIndex;
  }

  return undefined;
}

function restoreTruncatedAssistantTail(params: {
  previousMessages: UIMessage[];
  nextMessages: UIMessage[];
}): UIMessage[] {
  const { previousMessages, nextMessages } = params;

  if (previousMessages.length === 0) {
    return nextMessages;
  }

  const lastPreviousMessage = previousMessages.at(-1);
  if (
    nextMessages.length === 0 &&
    lastPreviousMessage?.role === "assistant" &&
    hasRenderableAssistantContent(lastPreviousMessage)
  ) {
    return previousMessages;
  }

  if (nextMessages.length >= previousMessages.length) {
    return nextMessages;
  }

  const hasStablePrefix = nextMessages.every((message, index) =>
    sameMessageIdentity(message, previousMessages[index]),
  );
  // only restore a tail that carries content worth keeping — restoring a
  // non-renderable assistant (e.g. step-start/telemetry after a stopped turn)
  // would resurrect the empty bubble the persist path just pruned away.
  const truncatedTail = previousMessages.slice(nextMessages.length);
  if (
    hasStablePrefix &&
    truncatedTail.length > 0 &&
    truncatedTail.every(
      (message) =>
        message.role === "assistant" && hasRenderableAssistantContent(message),
    )
  ) {
    return previousMessages;
  }

  return nextMessages;
}

function sameMessageIdentity(a: UIMessage, b: UIMessage | undefined): boolean {
  return !!b && a.id === b.id && a.role === b.role;
}
