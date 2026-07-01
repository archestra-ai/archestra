import {
  coerceMalformedToolInputs,
  hasPersistableAssistantContent,
  hasRenderableAssistantContent,
  stripDanglingToolCalls,
} from "@archestra/shared";
import logger from "@/logging";
import type { ChatMessage, ChatMessagePart } from "@/types";
import { stripImagesFromMessages } from "./strip-images-from-messages";

export function normalizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  // Coerce malformed tool inputs last, over the already-cleaned parts: dedupe
  // keys on type/toolCallId/state and dangling-strip keys on state — neither
  // reads `input` — so repairing input here can never drop a deduped twin or
  // change which parts survive.
  return coerceMalformedToolInputsFromMessages(
    dropEmptyAssistantMessages(
      stripOrphanedToolUiStartsFromMessages(
        stripImagesFromMessages(
          stripDanglingToolCallsFromMessages(
            dedupeToolPartsFromMessages(messages),
          ),
        ),
      ),
    ),
  );
}

// Stricter normalization for the persist path: after the shared cleanup, drop
// assistant turns that would reload as an empty bubble. The replay/model path
// uses the looser `normalizeChatMessages` so live-streamed turns aren't blanked,
// but only durably-renderable assistant turns should ever reach the DB.
export function normalizeChatMessagesForPersistence(
  messages: ChatMessage[],
): ChatMessage[] {
  return dropNonPersistableAssistantMessages(normalizeChatMessages(messages));
}

function dedupeToolPartsFromMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!message.parts || !Array.isArray(message.parts)) {
      return message;
    }

    const dedupedParts = dedupeToolParts(message.parts);
    if (dedupedParts.length === message.parts.length) {
      return message;
    }

    logger.warn(
      {
        messageId: message.id,
        role: message.role,
        originalCount: message.parts.length,
        dedupedCount: dedupedParts.length,
      },
      "[normalizeChatMessages] Removed duplicate tool parts from message",
    );

    return {
      ...message,
      parts: dedupedParts,
    };
  });
}

function dedupeToolParts(
  parts: NonNullable<ChatMessage["parts"]>,
): NonNullable<ChatMessage["parts"]> {
  const seenToolPartSignatures = new Set<string>();
  const dedupedParts: NonNullable<ChatMessage["parts"]> = [];

  for (const part of parts) {
    const signature = getToolPartSignature(part);
    if (signature && seenToolPartSignatures.has(signature)) {
      continue;
    }

    if (signature) {
      seenToolPartSignatures.add(signature);
    }

    dedupedParts.push(part);
  }

  return dedupedParts;
}

function stripDanglingToolCallsFromMessages(messages: ChatMessage[]) {
  const sanitizedMessages = stripDanglingToolCalls(messages);

  return sanitizedMessages.map((message, index) => {
    const originalMessage = messages[index];
    const originalCount = originalMessage?.parts?.length ?? 0;
    const sanitizedCount = message.parts?.length ?? 0;

    if (sanitizedCount === originalCount) {
      return message;
    }

    logger.warn(
      {
        messageId: message.id,
        role: message.role,
        originalCount,
        sanitizedCount,
      },
      "[normalizeChatMessages] Removed dangling tool calls from message",
    );

    return message;
  });
}

// repairs tool-call parts whose `input` is not a JSON object (a malformed-JSON
// remnant the AI SDK couldn't parse) so replaying the history doesn't fail
// provider validation. The pure transform lives in shared; this wrapper logs
// each repair so a rising rate of malformed model output stays visible.
function coerceMalformedToolInputsFromMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  const repaired = coerceMalformedToolInputs(messages);

  repaired.forEach((message, index) => {
    const original = messages[index];
    if (message === original) {
      return;
    }

    message.parts?.forEach((part, partIndex) => {
      const originalPart = original.parts?.[partIndex];
      if (!originalPart || part === originalPart) {
        return;
      }

      logger.warn(
        {
          messageId: message.id,
          role: message.role,
          toolCallId: part.toolCallId,
          partType: part.type,
          originalInputType: describeInputType(originalPart.input),
          recoveredFromJson:
            typeof originalPart.input === "string" &&
            isRecord(part.input) &&
            Object.keys(part.input).length > 0,
        },
        "[normalizeChatMessages] Coerced non-object tool-call input to an object",
      );
    });
  });

  return repaired;
}

// drops `data-tool-ui-start` markers whose tool call no longer survives — e.g. an
// aborted MCP-app turn whose dangling `tool-*` part was just stripped. The chat
// renderer treats such a marker as canonical and synthesizes an `input-streaming`
// tool from it, so an orphaned marker reloads as a perpetually running tool. Runs
// after dangling-call stripping so "surviving" reflects the cleaned-up parts.
function stripOrphanedToolUiStartsFromMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  return messages.map((message) => {
    const parts = message.parts;
    if (!parts?.length) {
      return message;
    }

    const liveToolCallIds = new Set<string>();
    for (const part of parts) {
      if (isToolPart(part) && typeof part.toolCallId === "string") {
        liveToolCallIds.add(part.toolCallId);
      }
    }

    const keptParts = parts.filter((part) => {
      if (!isToolUiStartPart(part)) {
        return true;
      }

      const toolCallId = getToolUiStartToolCallId(part);
      return toolCallId !== null && liveToolCallIds.has(toolCallId);
    });

    if (keptParts.length === parts.length) {
      return message;
    }

    logger.warn(
      {
        messageId: message.id,
        role: message.role,
        originalCount: parts.length,
        keptCount: keptParts.length,
      },
      "[normalizeChatMessages] Removed orphaned tool-ui-start parts from message",
    );

    return { ...message, parts: keptParts };
  });
}

// drops assistant turns left with no renderable content — e.g. a turn whose only
// parts were dangling tool calls that stripDanglingToolCalls removed. An empty
// assistant response is never valid, so neither the model nor the DB should see
// one. Non-assistant messages are left untouched.
function dropEmptyAssistantMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (message) =>
      message.role !== "assistant" || hasRenderableAssistantContent(message),
  );
}

// drops assistant turns that survive UI-renderability but would reload as an
// empty bubble — e.g. a turn left with only a `data-tool-ui-start` whose tool
// call never resolved, an unrecognized telemetry `data-*`, or `content: ""`.
function dropNonPersistableAssistantMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  return messages.filter((message) => {
    if (message.role !== "assistant") {
      return true;
    }

    if (hasPersistableAssistantContent(message)) {
      return true;
    }

    logger.warn(
      {
        messageId: message.id,
        role: message.role,
        partCount: message.parts?.length ?? 0,
      },
      "[normalizeChatMessages] Dropped non-persistable empty assistant message",
    );
    return false;
  });
}

// matches both statically-typed `tool-<name>` parts and the `dynamic-tool`
// shape MCP tools deserialize to — the frontend renderer and shared dangling-call
// normalization both treat `dynamic-tool` as a real tool part, so a `data-tool-ui-start`
// can legitimately pair with one and its toolCallId must count as live.
function isToolPart(part: ChatMessagePart): boolean {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

function isToolUiStartPart(part: ChatMessagePart): boolean {
  return part.type.startsWith("data-tool-ui-start");
}

function getToolUiStartToolCallId(part: ChatMessagePart): string | null {
  const data = part.data;
  if (typeof data !== "object" || data === null || !("toolCallId" in data)) {
    return null;
  }

  const toolCallId = (data as { toolCallId?: unknown }).toolCallId;
  return typeof toolCallId === "string" ? toolCallId : null;
}

function getToolPartSignature(part: NonNullable<ChatMessage["parts"]>[number]) {
  if (!part.toolCallId || typeof part.toolCallId !== "string") {
    return null;
  }

  if (part.type === "tool-call" || part.type === "tool-result") {
    return `${part.type}:${part.toolCallId}`;
  }

  if (part.type.startsWith("tool-")) {
    return `${part.type}:${part.toolCallId}:${getToolPartState(part)}`;
  }

  if (part.toolName && typeof part.toolName === "string") {
    return `${part.type}:${part.toolName}:${part.toolCallId}:${getToolPartState(part)}`;
  }

  return null;
}
function getToolPartState(part: ChatMessagePart) {
  return typeof part.state === "string" ? part.state : "unknown";
}

function describeInputType(input: unknown): string {
  if (input === null) {
    return "null";
  }
  if (Array.isArray(input)) {
    return "array";
  }
  return typeof input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
