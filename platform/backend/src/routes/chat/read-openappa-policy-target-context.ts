import {
  type ChatMessage,
  ChatMessageMetadataSchema,
  openAppaTargetScopeContext,
} from "@archestra/shared";

/**
 * Hidden scope reminder for an OpenAPPA policy-target conversation, read off
 * the turn's last user message and rendered via the same wording the target
 * table's suggested prompts use. Returns undefined when the conversation
 * carries no target scope, so the turn's system prompt is unaffected.
 *
 * The target `kind`/`name` are an untrusted client hint reused only to phrase
 * a sentence in the caller's own conversation — the same trust level as text
 * the caller could type directly, never a distinct permission grant, so no
 * access check (unlike `resolveOpenedApp`) is needed before using it.
 */
export function readOpenAppaPolicyTargetContext(
  messages: ChatMessage[],
): string | undefined {
  const lastUser = messages.findLast((message) => message.role === "user");
  const target = ChatMessageMetadataSchema.safeParse(lastUser?.metadata).data
    ?.openAppaPolicyTarget;
  if (!target) return undefined;
  return openAppaTargetScopeContext(target.kind, target.name);
}
