/**
 * In-memory carrier for the opening prompt of a chat started from a project.
 *
 * The project composer creates the conversation up front — so the project page
 * stays on screen instead of routing through an empty `/chat` that flashes the
 * New Chat splash — then navigates straight to `/chat/<id>`. The prompt rides
 * this module-level singleton across that one client-side navigation, and
 * `/chat/<id>` drains it (together with any attachments from
 * `pending-chat-handoff-files`) into the conversation's first message.
 *
 * Keyed by the created conversation id so an unrelated `/chat/<id>` open never
 * inherits a stale handoff; a hard reload starts empty, which is fine for a
 * one-shot handoff — the conversation already exists, just without its opening
 * message.
 */
type PendingProjectChatHandoff = {
  conversationId: string;
  prompt: string;
};

let pending: PendingProjectChatHandoff | null = null;

/** Stash the opening prompt for a just-created project chat. */
export function setPendingProjectChatHandoff(
  handoff: PendingProjectChatHandoff,
): void {
  pending = handoff;
}

/**
 * Return and clear the stashed opening prompt, but only for the conversation it
 * was stashed for. A mismatch (or empty store) yields null and leaves any
 * pending handoff untouched.
 */
export function takePendingProjectChatHandoff(
  conversationId: string,
): PendingProjectChatHandoff | null {
  if (pending?.conversationId !== conversationId) {
    return null;
  }
  const handoff = pending;
  pending = null;
  return handoff;
}
