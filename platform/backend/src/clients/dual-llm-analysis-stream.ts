import {
  DUAL_LLM_ANALYSIS_PART_TYPE,
  type DualLlmAnalysisPartData,
} from "@archestra/shared";
import type { UIMessageChunk } from "ai";
import type { DualLlmProgressEvent } from "@/guardrails/dual-llm-progress-bus";
import type { ChatMessage, ChatMessagePart } from "@/types";

type DualLlmAnalysisStreamWriter = {
  write: (chunk: UIMessageChunk) => void;
};

/**
 * Collects the dual LLM analyses the proxy runs during a turn and, when the
 * chat stream is attached, streams each one to the client as a
 * model-invisible `data-dual-llm-analysis` part. The part streams with the
 * analyzed tool call's id as its chunk id, so every progress event replaces
 * the previous snapshot in place instead of appending.
 *
 * Events are buffered until the model stream's own `start` chunk has been
 * observed: analyses run while the proxy holds the request *before* the
 * upstream call, and a non-transient data part written pre-`start` makes the
 * client mint a phantom assistant message (see the context-window breakdown
 * emit in routes.ts).
 */
type DualLlmAnalysisStreamBridge = {
  setWriter: (writer: DualLlmAnalysisStreamWriter) => void;
  /** Called once the merged UI stream has produced its first chunk. */
  markStreamStarted: () => void;
  handleEvent: (event: DualLlmProgressEvent) => void;
  /** The parts collected this turn, for splicing into the assistant message before persistence. */
  collected: () => ChatMessagePart[];
};

export function createDualLlmAnalysisStreamBridge(): DualLlmAnalysisStreamBridge {
  let writer: DualLlmAnalysisStreamWriter | null = null;
  let streamStarted = false;
  // Insertion-ordered so collected() preserves analysis order.
  const analyses = new Map<string, DualLlmAnalysisPartData>();

  // Each write carries the analysis's full current state under its tool call
  // id, so the client reconciles in place. That also makes a buffered analysis
  // need no queue: replaying every known analysis once the stream opens
  // delivers exactly the state a live sequence would have converged on.
  const emit = (data: DualLlmAnalysisPartData) => {
    if (!writer || !streamStarted) {
      return;
    }
    writer.write({
      type: DUAL_LLM_ANALYSIS_PART_TYPE,
      id: data.toolCallId,
      data: { ...data, rounds: [...data.rounds] },
    } as UIMessageChunk);
  };

  return {
    setWriter(nextWriter) {
      writer = nextWriter;
    },

    markStreamStarted() {
      if (streamStarted) {
        return;
      }
      streamStarted = true;
      for (const data of analyses.values()) {
        emit(data);
      }
    },

    handleEvent(event) {
      const existing = analyses.get(event.toolCallId);
      const data: DualLlmAnalysisPartData = existing ?? {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: "analyzing",
        rounds: [],
      };
      switch (event.kind) {
        case "start":
          break;
        case "qa":
          data.rounds.push({
            question: event.question,
            options: event.options,
            answer: event.answer,
          });
          break;
        case "complete":
          data.status = "done";
          data.summary = event.analysis.result;
          // Later agentic-loop steps re-evaluate the same history and confirm
          // this analysis from the sanitize-once cache; that must not relabel
          // an interrogation that visibly ran live in this turn as cached.
          data.cached = data.rounds.length === 0 && event.cached;
          // A cached analysis replays no Q&A rounds; surface how many the
          // original interrogation ran (one answer per round).
          data.questionCount =
            data.rounds.length > 0
              ? data.rounds.length
              : event.analysis.conversations.filter(
                  (message) => message.role === "user",
                ).length;
          break;
        case "error":
          data.status = "failed";
          data.failureMessage = event.message;
          break;
      }
      if (!existing) {
        analyses.set(event.toolCallId, data);
      }
      emit(data);
    },

    collected() {
      return [...analyses.values()].map((data) => ({
        type: DUAL_LLM_ANALYSIS_PART_TYPE,
        data: { ...data, rounds: [...data.rounds] },
      }));
    },
  };
}

/**
 * Splice collected dual-LLM analysis parts into the turn's assistant
 * message(s) before persistence, each directly after the last tool part
 * carrying its `toolCallId` (the invocation/result pair whose output was
 * analyzed), so a reload renders the block where it streamed. An analysis
 * whose tool part is not in the persisted window falls back to the end of the
 * last assistant message.
 *
 * Pure: returns the input unchanged when there is nothing to splice,
 * otherwise shallow-copies only the messages it touches.
 */
export function applyDualLlmAnalysesToMessages(
  messages: ChatMessage[],
  parts: ChatMessagePart[],
): ChatMessage[] {
  if (parts.length === 0) {
    return messages;
  }

  let lastAssistantIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
    }
  }
  if (lastAssistantIdx === -1) {
    return messages;
  }

  const result = messages.map((message) => ({
    ...message,
    parts: [...(message.parts ?? [])],
  }));

  for (const part of parts) {
    const toolCallId = (part.data as DualLlmAnalysisPartData)?.toolCallId;
    let placed = false;
    if (typeof toolCallId === "string") {
      for (let i = result.length - 1; i >= 0 && !placed; i--) {
        if (result[i].role !== "assistant") {
          continue;
        }
        const msgParts = result[i].parts;
        for (let j = msgParts.length - 1; j >= 0; j--) {
          const candidate = msgParts[j];
          if (
            typeof candidate?.type === "string" &&
            (candidate.type.startsWith("tool-") ||
              candidate.type === "dynamic-tool") &&
            candidate.toolCallId === toolCallId
          ) {
            msgParts.splice(j + 1, 0, part);
            placed = true;
            break;
          }
        }
      }
    }
    if (!placed) {
      result[lastAssistantIdx].parts.push(part);
    }
  }

  return result;
}
