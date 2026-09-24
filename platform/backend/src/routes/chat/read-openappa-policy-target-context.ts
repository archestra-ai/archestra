import {
  type ChatMessage,
  ChatMessageMetadataSchema,
  openAppaTargetScopeContext,
} from "@archestra/shared";

/**
 * Hidden scope reminder for an OpenAPPA policy-target conversation, read off
 * the turn's last user message. Returns undefined when the conversation
 * carries no target scope, so the turn's system prompt is unaffected.
 *
 * The target is an untrusted client hint. Only a validated kind and UUID enter
 * the system prompt; the model must resolve the exact target by ID.
 */
export function readOpenAppaPolicyTargetContext(
  messages: ChatMessage[],
): string | undefined {
  const lastUser = messages.findLast((message) => message.role === "user");
  const target = ChatMessageMetadataSchema.safeParse(lastUser?.metadata).data
    ?.openAppaPolicyTarget;
  if (!target) return undefined;
  return openAppaTargetScopeContext(target.kind, target.id);
}
