import type { ChatMessage } from "@/types";

/**
 * Collect every `toolCallId` whose tool part has reached a terminal state in
 * the approval flow. A part is in the approval flow when it carries the
 * `approval` object (set by the AI SDK when `needsApproval` returned true).
 * The returned set drives the persistence sweep: any prior message with a
 * matching `toolCallId` still in `approval-requested` is stale.
 */
export function collectResolvedApprovalToolCallIds(
  messages: ChatMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (typeof part.toolCallId !== "string") continue;
      if (typeof part.state !== "string") continue;
      if (!TERMINAL_APPROVAL_STATES.has(part.state)) continue;
      // Only consider parts that went through the approval flow.
      if (!part.approval || typeof part.approval !== "object") continue;
      ids.add(part.toolCallId);
    }
  }
  return ids;
}

const TERMINAL_APPROVAL_STATES = new Set([
  "approval-responded",
  "output-available",
  "output-error",
  "output-denied",
]);
