import { TOOL_STATE, type ToolState } from "@shared";
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
      if (!TERMINAL_APPROVAL_STATES.has(part.state as ToolState)) continue;
      // Only consider parts that went through the approval flow. Tighten the
      // shape check beyond `typeof === "object"` so a future SDK change to
      // emit e.g. `approval: []` or another non-record sentinel doesn't
      // mis-fire the sweep.
      if (!isApprovalRecord(part.approval)) continue;
      ids.add(part.toolCallId);
    }
  }
  return ids;
}

const TERMINAL_APPROVAL_STATES = new Set<ToolState>([
  TOOL_STATE.APPROVAL_RESPONDED,
  TOOL_STATE.OUTPUT_AVAILABLE,
  TOOL_STATE.OUTPUT_ERROR,
  TOOL_STATE.OUTPUT_DENIED,
]);

function isApprovalRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  // The AI SDK approval object always carries at least one of these keys.
  return "id" in value || "approved" in value;
}
