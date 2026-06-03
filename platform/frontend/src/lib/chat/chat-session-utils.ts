import type { UIMessage } from "@ai-sdk/react";
import { hasRenderableAssistantContent } from "@shared";

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

  // Restoration rebuilds the assistant tail from `previousMessages` on every
  // call, so a persistent empty assistant message (e.g. a reload into an
  // interrupted resume) produces a fresh array each render. Reuse the prior
  // reference when the result is renderably identical, so consumers keyed on
  // array identity don't re-render in an infinite loop.
  return hasSameRenderableMessages(restoredMessages, previousMessages)
    ? previousMessages
    : restoredMessages;
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

function hasSameRenderableMessages(
  candidate: UIMessage[],
  previous: UIMessage[],
): boolean {
  if (candidate === previous) {
    return true;
  }
  if (candidate.length !== previous.length) {
    return false;
  }
  return candidate.every((message, index) => {
    const previousMessage = previous[index];
    return (
      sameMessageIdentity(message, previousMessage) &&
      message.parts === previousMessage?.parts
    );
  });
}
