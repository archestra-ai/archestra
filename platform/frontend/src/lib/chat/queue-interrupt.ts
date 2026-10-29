import type { UIMessage } from "ai";

/** A remote tool may still commit side effects after its stream is cancelled. */
export function getQueueInterruptBlockedReason(params: {
  messages: UIMessage[];
  hasPendingQuestion: boolean;
  isCompacting: boolean;
}): string | undefined {
  if (params.isCompacting) return "Wait for context compaction to finish.";
  if (params.hasPendingQuestion) return "Answer the pending question first.";
  for (const message of params.messages) {
    for (const part of message.parts) {
      if (!(part.type === "dynamic-tool" || part.type.startsWith("tool-")))
        continue;
      if ("state" in part && part.state === "approval-requested") {
        return "Resolve the pending tool approval first.";
      }
      if (
        "state" in part &&
        (part.state === "input-available" ||
          part.state === "approval-responded")
      ) {
        return "Wait for the running tool to finish.";
      }
    }
  }
  return undefined;
}
