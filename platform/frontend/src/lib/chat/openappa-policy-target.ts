import {
  ChatMessageMetadataSchema,
  type ChatOpenAppaPolicyTargetMetadata,
} from "@archestra/shared";
import type { UIMessage } from "ai";

/**
 * The policy target an OpenAPPA conversation is scoped to, read off its latest
 * scoped user message. Conversation links carry no target query, so this is how
 * a reopened conversation keeps scoping later turns.
 */
export function findOpenAppaPolicyTarget(
  messages: readonly UIMessage[],
): ChatOpenAppaPolicyTargetMetadata | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const target = ChatMessageMetadataSchema.safeParse(message.metadata).data
      ?.openAppaPolicyTarget;
    if (target) return target;
  }
  return undefined;
}
