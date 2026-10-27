import type { ModelMessage } from "ai";

/**
 * The AI SDK records parallel tool results in the order they finish. Models
 * read them back by position as well as by id, so a result list in completion
 * order lets a model pin one call's result on another. Run it before a step's
 * cache breakpoint is placed: the breakpoint marks the last result part.
 */
export function orderToolResultsByCall(
  messages: ModelMessage[],
): ModelMessage[] {
  const ordered = messages.map((message, i) => {
    const previous = messages[i - 1];
    if (
      message.role !== "tool" ||
      previous?.role !== "assistant" ||
      typeof previous.content === "string"
    ) {
      return message;
    }
    const callOrder = new Map(
      previous.content.flatMap((part, position) =>
        part.type === "tool-call" ? [[part.toolCallId, position] as const] : [],
      ),
    );
    const rank = (part: (typeof message.content)[number]) =>
      (part.type === "tool-result"
        ? callOrder.get(part.toolCallId)
        : undefined) ?? previous.content.length;
    const content = message.content.toSorted((a, b) => rank(a) - rank(b));
    return content.every((part, j) => part === message.content[j])
      ? message
      : { ...message, content };
  });
  return ordered.every((message, i) => message === messages[i])
    ? messages
    : ordered;
}
