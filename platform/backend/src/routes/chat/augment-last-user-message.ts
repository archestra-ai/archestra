import type { ChatMessage, ChatMessagePart } from "@archestra/shared";

/**
 * Splice `block` into a message's text. `"prepend"` puts it before the first
 * text part (`block\n\nexisting`); `"append"` puts it after the last text part
 * (`existing\n\nblock`). When the message has no text part, one is added at the
 * matching end.
 */
export function spliceText(
  message: ChatMessage,
  block: string,
  placement: "prepend" | "append",
): ChatMessage {
  const parts: ChatMessagePart[] = message.parts ? [...message.parts] : [];
  const textIndex =
    placement === "prepend"
      ? parts.findIndex((part) => part.type === "text")
      : parts.findLastIndex((part) => part.type === "text");

  if (textIndex === -1) {
    return placement === "prepend"
      ? { ...message, parts: [{ type: "text", text: block }, ...parts] }
      : { ...message, parts: [...parts, { type: "text", text: block }] };
  }

  const textPart = parts[textIndex];
  const existing = typeof textPart.text === "string" ? textPart.text : "";
  const text = existing
    ? placement === "prepend"
      ? `${block}\n\n${existing}`
      : `${existing}\n\n${block}`
    : block;
  parts[textIndex] = { ...textPart, text };
  return { ...message, parts };
}
