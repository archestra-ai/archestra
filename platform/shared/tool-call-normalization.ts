type ToolPartLike = {
  state?: unknown;
  toolCallId?: unknown;
  type?: unknown;
};

type MessageWithParts<TPart extends ToolPartLike> = {
  parts?: TPart[];
};

export function stripDanglingToolCalls<
  TPart extends ToolPartLike,
  TMessage extends MessageWithParts<TPart>,
>(messages: TMessage[]): TMessage[] {
  const completedToolCallIds = collectCompletedToolCallIds(messages);

  return messages.map((message) => {
    if (!message.parts?.length) {
      return message;
    }

    const sanitizedParts = message.parts.filter((part) => {
      if (
        typeof part.toolCallId !== "string" ||
        !isInputAvailableToolPart(part)
      ) {
        return true;
      }

      return completedToolCallIds.has(part.toolCallId);
    });

    if (sanitizedParts.length === message.parts.length) {
      return message;
    }

    return {
      ...message,
      parts: sanitizedParts,
    };
  });
}

function collectCompletedToolCallIds<
  TPart extends ToolPartLike,
  TMessage extends MessageWithParts<TPart>,
>(messages: TMessage[]) {
  const completedToolCallIds = new Set<string>();

  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (typeof part.toolCallId === "string" && isCompletedToolPart(part)) {
        completedToolCallIds.add(part.toolCallId);
      }
    }
  }

  return completedToolCallIds;
}

function isCompletedToolPart(part: ToolPartLike) {
  return (
    part.state === "output-available" ||
    part.state === "output-error" ||
    part.state === "output-denied" ||
    part.type === "tool-result"
  );
}

function isInputAvailableToolPart(part: ToolPartLike) {
  return part.state === "input-available" || part.type === "tool-call";
}
