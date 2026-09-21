import type { UIMessage } from "@ai-sdk/react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  type AskUserGroupMember,
  getAskUserOutcome,
  getAskUserQuestion,
} from "./ask-user-outcome";

export type AskUserGroup = {
  key: string;
  firstIndex: number;
  members: AskUserGroupMember[];
  consumedIndices: ReadonlySet<number>;
};

/**
 * Reconstructs the stable transcript slot for related ask_user calls.
 * Pairs tool results by toolCallId rather than adjacency.
 * Step boundaries serve as the batch marker. Earlier messages without step
 * boundaries group inputs preceding their shared result phase.
 */
export function identifyAskUserGroups({
  messageId,
  parts,
  getToolShortName,
}: {
  messageId: string;
  parts: UIMessage["parts"] | undefined;
  getToolShortName: (toolName: string) => string | null;
}): AskUserGroup[] {
  const records = new Map<string, ToolRecord>();
  let stepOrdinal = 0;
  let hasStepBoundary = false;
  let legacyPhase = 0;
  let legacyResultSeen = false;

  for (const [index, part] of (parts ?? []).entries()) {
    if (part.type === "step-start") {
      stepOrdinal += 1;
      hasStepBoundary = true;
      continue;
    }
    if (!isAskUserToolPart(part, getToolShortName) || !part.toolCallId) {
      continue;
    }

    const isTerminal =
      part.state === "output-available" || part.state === "output-error";
    let record = records.get(part.toolCallId);
    if (!record) {
      if (!hasStepBoundary && (isTerminal || legacyResultSeen)) {
        legacyPhase += 1;
      }
      record = {
        toolCallId: part.toolCallId,
        groupOrdinal: hasStepBoundary ? stepOrdinal : legacyPhase,
        firstIndex: index,
        part,
        resultPart: isTerminal ? part : null,
        indices: new Set([index]),
      };
      records.set(part.toolCallId, record);
    } else {
      record.indices.add(index);
      if (isTerminal) {
        record.resultPart = part;
      } else if (record.part.state === "output-available") {
        record.part = part;
      }
    }
    if (!hasStepBoundary && isTerminal) {
      legacyResultSeen = true;
    }
  }

  const groups = new Map<number, GroupableToolRecord[]>();
  for (const record of records.values()) {
    if (
      record.part.errorText ||
      record.resultPart?.errorText ||
      record.part.state === "output-error" ||
      record.resultPart?.state === "output-error"
    ) {
      continue;
    }
    const outcome = getAskUserOutcome({
      part: record.part,
      toolResultPart: record.resultPart,
    });
    // An output without the structured ask_user outcome must keep the generic
    // tool renderer, which can faithfully show its raw value or error details.
    if (outcome === null) {
      continue;
    }
    const group = groups.get(record.groupOrdinal) ?? [];
    group.push({ ...record, outcome });
    groups.set(record.groupOrdinal, group);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ordinal, group]) => {
      group.sort((a, b) => a.firstIndex - b.firstIndex);
      const consumedIndices = new Set(
        group.flatMap((record) => [...record.indices]),
      );
      return {
        key: `${messageId}-ask-user-${ordinal}`,
        firstIndex: group[0].firstIndex,
        consumedIndices,
        members: group.map((record) => ({
          toolCallId: record.toolCallId,
          question: getAskUserQuestion(record.part.input),
          outcome: record.outcome,
        })),
      };
    });
}

type ToolRecord = {
  toolCallId: string;
  groupOrdinal: number;
  firstIndex: number;
  part: ToolUIPart | DynamicToolUIPart;
  resultPart: ToolUIPart | DynamicToolUIPart | null;
  indices: Set<number>;
};

type GroupableToolRecord = ToolRecord & {
  outcome: Exclude<ReturnType<typeof getAskUserOutcome>, null>;
};

function isAskUserToolPart(
  part: UIMessage["parts"][number],
  getToolShortName: (toolName: string) => string | null,
): part is ToolUIPart | DynamicToolUIPart {
  if (typeof part !== "object" || part === null || !("type" in part)) {
    return false;
  }
  const toolName =
    part.type === "dynamic-tool" && "toolName" in part
      ? part.toolName
      : part.type.startsWith("tool-")
        ? part.type.replace("tool-", "")
        : null;
  return (
    typeof toolName === "string" && getToolShortName(toolName) === "ask_user"
  );
}
