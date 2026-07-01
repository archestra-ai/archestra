import {
  SUBAGENT_TOOL_CALL_PART_TYPE,
  type SubagentToolCallPartData,
} from "@archestra/shared";
import type { UIMessageChunk } from "ai";
import type { ChatMessage, ChatMessagePart } from "@/types";

export type SubagentToolStreamWriter = {
  write: (chunk: UIMessageChunk) => void;
};

/**
 * Collects the tool calls delegated child agents make during a turn and, when a
 * chat stream is attached, streams each one to the client as a model-invisible
 * `data-subagent-tool-call` part. One bridge instance is shared down the whole
 * delegation chain (threaded through the tool-execution context), so a
 * grandchild's calls reach the same writer and collector as a direct child's —
 * the client re-nests them by `toolCallId`→`parentToolCallId` linkage.
 *
 * The delegation tool's own result is unaffected: it stays the child's final
 * text. This bridge only surfaces what the child did along the way.
 */
export type SubagentToolStreamBridge = {
  setWriter: (writer: SubagentToolStreamWriter) => void;
  /** Surface one child tool call: stream it live (if a writer is attached) and collect it for persistence. */
  emit: (data: SubagentToolCallPartData) => void;
  /** The parts collected this turn, for splicing into the assistant message before persistence. */
  collected: () => ChatMessagePart[];
};

// Cap on the JSON size of a child tool call's input/output before it is
// streamed or persisted. A subagent call rides inside the parent assistant
// message row, and a browser-style tool can return very large output, so an
// uncapped payload would bloat that row unbounded. Matches the hook-run debug
// body cap.
const SUBAGENT_PAYLOAD_CAP = 10_000;

export function createSubagentToolStreamBridge(): SubagentToolStreamBridge {
  let writer: SubagentToolStreamWriter | null = null;
  const parts: ChatMessagePart[] = [];

  return {
    setWriter(nextWriter) {
      writer = nextWriter;
    },

    emit(data) {
      const capped: SubagentToolCallPartData = {
        parentToolCallId: data.parentToolCallId,
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        ...(data.input !== undefined ? { input: capPayload(data.input) } : {}),
        ...(data.state !== undefined ? { state: data.state } : {}),
        ...(data.output !== undefined
          ? { output: capPayload(data.output) }
          : {}),
        ...(data.errorText !== undefined
          ? { errorText: capString(data.errorText) }
          : {}),
      };
      parts.push({ type: SUBAGENT_TOOL_CALL_PART_TYPE, data: capped });
      // Setting the chunk id to the child toolCallId lets the client reconcile
      // and dedupe the part across stream resumes.
      writer?.write({
        type: SUBAGENT_TOOL_CALL_PART_TYPE,
        id: data.toolCallId,
        data: capped,
      } as UIMessageChunk);
    },

    collected() {
      return parts;
    },
  };
}

/**
 * Append collected subagent tool-call parts to the assistant message(s) of the
 * turn so they persist and survive a reload. A child call is routed to the
 * assistant message holding the real delegation tool part whose id matches its
 * `parentToolCallId`; a deeper descendant (whose parent is itself a subagent
 * part, not a real tool part) falls back to the last assistant message of the
 * turn. The client collects subagent parts across the whole conversation, so
 * exact placement only affects which row stores the part, never how it nests.
 *
 * Pure: returns the input unchanged when there is nothing to append, otherwise
 * shallow-copies only the messages it touches.
 */
export function applySubagentToolCallsToMessages(
  messages: ChatMessage[],
  parts: ChatMessagePart[],
): ChatMessage[] {
  if (parts.length === 0) {
    return messages;
  }

  let lastUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
    }
  }
  const assistantIdxs: number[] = [];
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    if (messages[i].role === "assistant") {
      assistantIdxs.push(i);
    }
  }
  if (assistantIdxs.length === 0) {
    return messages;
  }
  const lastIdx = assistantIdxs[assistantIdxs.length - 1];

  // toolCallId -> index of the assistant message that holds that real tool part.
  const toolIdxById = new Map<string, number>();
  for (const idx of assistantIdxs) {
    for (const part of messages[idx].parts ?? []) {
      if (
        typeof part.toolCallId === "string" &&
        typeof part.type === "string" &&
        (part.type.startsWith("tool-") || part.type === "dynamic-tool")
      ) {
        toolIdxById.set(part.toolCallId, idx);
      }
    }
  }

  const partsByIdx = new Map<number, ChatMessagePart[]>();
  for (const part of parts) {
    const parentToolCallId = (part.data as SubagentToolCallPartData)
      ?.parentToolCallId;
    const idx =
      (typeof parentToolCallId === "string"
        ? toolIdxById.get(parentToolCallId)
        : undefined) ?? lastIdx;
    const list = partsByIdx.get(idx);
    if (list) {
      list.push(part);
    } else {
      partsByIdx.set(idx, [part]);
    }
  }

  return messages.map((message, idx) => {
    const msgParts = partsByIdx.get(idx);
    if (!msgParts) {
      return message;
    }
    return {
      ...message,
      parts: [...(message.parts ?? []), ...msgParts],
    };
  });
}

function capString(value: string): string {
  if (value.length <= SUBAGENT_PAYLOAD_CAP) {
    return value;
  }
  return `${value.slice(0, SUBAGENT_PAYLOAD_CAP)}…[truncated ${value.length - SUBAGENT_PAYLOAD_CAP} chars]`;
}

// Cap a structured value by its serialized size. Small values pass through
// unchanged (so the client renders real JSON); an oversized one is replaced by
// a truncated string marker rather than dropped, keeping the row bounded.
function capPayload(value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
  // JSON.stringify returns undefined for values with no JSON representation
  // (a function, a bare `undefined`, a symbol). Replace it rather than forward
  // a value that can't ride in a UIMessageChunk or persist cleanly.
  if (serialized === undefined) {
    return "[unserializable]";
  }
  if (serialized.length <= SUBAGENT_PAYLOAD_CAP) {
    return value;
  }
  return capString(serialized);
}
