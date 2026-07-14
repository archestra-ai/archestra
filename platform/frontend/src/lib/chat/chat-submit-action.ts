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

export type ChatSubmitAction = "queue" | "stop" | "send";

export function classifyChatSubmitAction(params: {
  /** AI SDK useChat status snapshot as seen by the page. */
  status: string;
  /** Message queueing is on (beta) AND a conversation exists to queue into. */
  queueEnabled: boolean;
  /** A direct send fired but the page's `status` hasn't caught up yet. */
  directSendPending: boolean;
}): ChatSubmitAction {
  const { status, queueEnabled, directSendPending } = params;
  const isStreaming = status === "submitted" || status === "streaming";

  if (isStreaming) {
    // Submitting mid-turn queues the message with queueing on; without it, the
    // submit button doubles as Stop.
    return queueEnabled ? "queue" : "stop";
  }

  // Status reads idle, but a direct send we just issued is still settling — the
  // turn is live, so queue the follow-up rather than race it.
  if (queueEnabled && directSendPending) {
    return "queue";
  }

  return "send";
}
