// Decides what a chat composer submit should do, given the current send state.
// Extracted from the chat page's handleSubmit so the routing contract can be
// unit-tested in isolation (the page component itself is too large to exercise
// this branch reliably).
//
// The subtlety this encodes: the `status` the page reads is a snapshot from the
// shared session map, which lags the real AI SDK status by a render. Right
// after a direct send fires, the turn is already in flight but `status` can
// still read "ready" for a tick or two. `directSendPending` carries that fact
// synchronously so follow-up submits queue instead of starting a second,
// racing direct send (concurrent sends reach the model but clobber each other's
// optimistic message, so most never render).
//
// Context compaction is the other way the conversation can be busy while
// `status` reads idle: a manual `/compact` rewrites the thread over a REST call
// with no stream attached. Sending into that would race the rewrite, so those
// submits queue too and the session drains them once compaction settles.

export type ChatSubmitAction = "queue" | "stop" | "send";

export function classifyChatSubmitAction(params: {
  /** AI SDK useChat status snapshot as seen by the page. */
  status: string;
  /** A conversation exists to queue into (false on the new-chat composer). */
  queueEnabled: boolean;
  /** A direct send fired but the page's `status` hasn't caught up yet. */
  directSendPending: boolean;
  /** A context compaction (auto or manual) is rewriting the thread. */
  isCompacting: boolean;
}): ChatSubmitAction {
  const { status, queueEnabled, directSendPending, isCompacting } = params;
  const isStreaming = status === "submitted" || status === "streaming";

  if (isStreaming) {
    // Submitting mid-turn queues the message when there is a conversation to
    // queue into; on the new-chat composer the submit doubles as Stop.
    return queueEnabled ? "queue" : "stop";
  }

  // Status reads idle, but the conversation is still busy — a direct send we
  // just issued is settling, or a compaction is rewriting the thread. Either
  // way the follow-up queues rather than racing it.
  if (queueEnabled && (directSendPending || isCompacting)) {
    return "queue";
  }

  return "send";
}
