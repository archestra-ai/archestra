import {
  type ChatMessage,
  ChatMessageMetadataSchema,
  openAppaTargetScopeContext,
} from "@archestra/shared";

/**
 * Hidden scope reminder for an OpenAPPA policy-target conversation, read off
 * its latest scoped user message. Returns undefined when the conversation
 * carries no target scope, so the turn's system prompt is unaffected.
 *
 * The target is an untrusted client hint. Only a validated kind and UUID enter
 * the system prompt; the model must resolve the exact target by ID.
 */
export function readOpenAppaPolicyTargetContext(
  messages: ChatMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const target = ChatMessageMetadataSchema.safeParse(message.metadata).data
      ?.openAppaPolicyTarget;
    if (target) return openAppaTargetScopeContext(target.kind, target.id);
  }
  return undefined;
}
