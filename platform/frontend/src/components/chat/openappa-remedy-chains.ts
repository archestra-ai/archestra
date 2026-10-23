import {
  type ArchestraToolShortName,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
} from "@archestra/shared";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { isEqual } from "lodash-es";
import {
  getCompactToolState,
  getHumanRulingDisplay,
  getToolNameFromPart,
} from "@/lib/chat/chat-tools-display.utils";
import { withoutProxyTransportArguments } from "./proxy-transport-arguments";

type ToolPart = ToolUIPart | DynamicToolUIPart;

/** One tool call of a remedy chain, with the part that carries its result. */
export type RemedyChainMember = {
  role: "notice" | "remedy" | "attempt";
  partIndex: number;
  resultIndex: number | undefined;
  toolName: string;
  part: ToolPart;
  toolResultPart: ToolPart | null;
};

/**
 * Every tool call that belongs to one guarded call: the Guardrails denial
 * notices and remedies negotiated for it, and the attempt that finally ran.
 * Chat renders the chain as a single call of its target tool.
 */
export type RemedyChain = {
  /** The first notice — where the model first made the call. */
  anchorIndex: number;
  /** The tool the policy ruled on (a run_tool dispatch's target). */
  targetToolName: string;
  /** The target's arguments, as an object when they parse as one. */
  targetArguments: unknown;
  /** Notices and remedies, in part order. */
  steps: RemedyChainMember[];
  /** The released attempt, once the model retried and the call ran. */
  finalAttempt: RemedyChainMember | null;
};

export type RemedyChainStatus = {
  state: "running" | "completed" | "error" | "denied";
  label?: string;
};

/**
 * Find the remedy chains in one message's parts, in part order.
 *
 * A denial notice opens a chain. A remedy joins the open chain whose ruling
 * names its `offer_id`. A later call to the same target with the same
 * arguments joins too: a blocked one arrives as another notice and continues
 * the chain, a released one is the final attempt and closes it.
 *
 * Notices in the same step are parallel calls, so each opens its own chain,
 * and parallel retries close the matching chains oldest first. A retry still
 * streaming its arguments joins the latest chain for its target that already
 * has a remedy, until its arguments are complete enough to compare.
 */
export function identifyRemedyChains(
  parts: readonly unknown[] | undefined,
  options: {
    getToolShortName?: (toolName: string) => ArchestraToolShortName | null;
  },
): RemedyChain[] {
  const getToolShortName = options.getToolShortName;
  if (!parts || !getToolShortName) return [];

  const invocations: {
    index: number;
    step: number;
    part: ToolPart;
    toolName: string;
  }[] = [];
  const resultIndexByCallId = new Map<string, number>();
  const seenCallIds = new Set<string>();
  // Without step markers every notice may continue an earlier chain.
  const hasSteps = parts.some(isStepStartPart);
  let step = 0;
  parts.forEach((part, index) => {
    if (isStepStartPart(part)) {
      step++;
      return;
    }
    if (!isToolPart(part)) return;
    const toolName = getToolNameFromPart(part);
    if (!toolName) return;
    const callId = part.toolCallId;
    if (callId && seenCallIds.has(callId)) {
      resultIndexByCallId.set(callId, index);
      return;
    }
    if (callId) seenCallIds.add(callId);
    invocations.push({ index, step, part, toolName });
  });

  const chains: (RemedyChain & {
    offerIds: Set<string>;
    noticeStep: number;
  })[] = [];
  const isOpen = (chain: RemedyChain) => chain.finalAttempt === null;

  // Each call scans the open chains, so a message costs chains × calls. Both
  // stay small in a real turn (a few guarded calls among tens of tool calls).

  for (const { index, step, part, toolName } of invocations) {
    const resultIndex = part.toolCallId
      ? resultIndexByCallId.get(part.toolCallId)
      : undefined;
    const resultPart =
      resultIndex !== undefined && isToolPart(parts[resultIndex])
        ? (parts[resultIndex] as ToolPart)
        : null;
    const member = (role: RemedyChainMember["role"]): RemedyChainMember => ({
      role,
      partIndex: index,
      resultIndex,
      toolName,
      part,
      toolResultPart: resultPart,
    });
    const shortName = getToolShortName(toolName);

    if (shortName === TOOL_GET_REMEDY_PLANS_SHORT_NAME) {
      const notice = parseNotice(part.input, part.state === "input-streaming");
      if (!notice) continue;
      const offerIds = offeredRemedyIds(
        `${notice.ruling}\n${outputText(resultPart?.output ?? part.output)}`,
      );
      const continued = chains.findLast(
        (chain) =>
          isOpen(chain) &&
          (!hasSteps || chain.noticeStep < step) &&
          chain.targetToolName === notice.tool &&
          isEqual(chain.targetArguments, notice.arguments),
      );
      if (continued) {
        continued.steps.push(member("notice"));
        for (const offerId of offerIds) continued.offerIds.add(offerId);
        continued.noticeStep = step;
        continue;
      }
      chains.push({
        anchorIndex: index,
        targetToolName: notice.tool,
        targetArguments: notice.arguments,
        steps: [member("notice")],
        finalAttempt: null,
        offerIds,
        noticeStep: step,
      });
      continue;
    }

    if (shortName === TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME) {
      const offerId = (part.input as { offer_id?: unknown } | undefined)
        ?.offer_id;
      if (typeof offerId !== "string" || offerId.length === 0) continue;
      // A remedy is tied to its blocked call only by the offers that call's
      // rulings list, so it joins the chain whose rulings offered this id.
      chains
        .findLast((chain) => isOpen(chain) && chain.offerIds.has(offerId))
        ?.steps.push(member("remedy"));
      continue;
    }

    const attempt = resolveAttempt({ part, toolName, getToolShortName });
    // The two searches run in opposite directions on purpose. A streaming
    // retry joins the newest chain that has a remedy, the one the model is
    // retrying now. A complete retry closes the oldest matching chain, so
    // identical parallel retries close identical parallel chains in order.
    const chain =
      part.state === "input-streaming"
        ? // Provisional: its arguments are not complete enough to compare.
          chains.findLast(
            (candidate) =>
              isOpen(candidate) &&
              candidate.targetToolName === attempt.toolName &&
              candidate.steps.some((member) => member.role === "remedy"),
          )
        : chains.find(
            (candidate) =>
              isOpen(candidate) &&
              candidate.targetToolName === attempt.toolName &&
              isEqual(candidate.targetArguments, attempt.arguments),
          );
    if (chain) chain.finalAttempt = member("attempt");
  }

  return chains.map(
    ({ offerIds: _offerIds, noticeStep: _noticeStep, ...chain }) => chain,
  );
}

/**
 * The chain's state as one call of its target tool. While its turn is still
 * active, a chain the model has not released reads as running, so the peel
 * does not flicker through the negotiation's intermediate states; only the
 * released attempt, or the turn ending, settles it.
 */
export function getRemedyChainStatus(
  chain: RemedyChain,
  options: { turnActive?: boolean } = {},
): RemedyChainStatus {
  const { finalAttempt } = chain;
  if (finalAttempt) {
    const state = getCompactToolState(finalAttempt);
    return {
      state,
      label:
        state === "running"
          ? undefined
          : getHumanRulingDisplay(finalAttempt)?.label,
    };
  }
  if (options.turnActive) return { state: "running" };
  if (chain.steps.some((step) => getCompactToolState(step) === "running")) {
    return { state: "running" };
  }
  const lastRemedy = chain.steps.findLast((step) => step.role === "remedy");
  const ruling = lastRemedy ? getHumanRulingDisplay(lastRemedy) : null;
  if (ruling?.ruling === "deny") {
    return { state: "denied", label: ruling.label };
  }
  return { state: "denied", label: "Blocked" };
}

/** Every part index the chain renders, so its members render nothing alone. */
export function remedyChainPartIndices(chain: RemedyChain): number[] {
  const members = chain.finalAttempt
    ? [...chain.steps, chain.finalAttempt]
    : chain.steps;
  return members.flatMap((member) =>
    member.resultIndex === undefined
      ? [member.partIndex]
      : [member.partIndex, member.resultIndex],
  );
}

// === Internal helpers ===

function isToolPart(part: unknown): part is ToolPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    typeof part.type === "string" &&
    (part.type.startsWith("tool-") || part.type === "dynamic-tool")
  );
}

function isStepStartPart(part: unknown): boolean {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "step-start"
  );
}

/**
 * A notice still streaming its input counts as soon as it names its target,
 * so its circle shows the target from the start.
 */
function parseNotice(
  input: unknown,
  streaming = false,
): { tool: string; arguments: unknown; ruling: string } | null {
  if (typeof input !== "object" || input === null) return null;
  if (streaming) {
    const { tool, arguments: args, ruling } = input as Record<string, unknown>;
    if (typeof tool !== "string" || tool.length === 0) return null;
    return {
      tool,
      arguments: parseArguments(args),
      ruling: typeof ruling === "string" ? ruling : "",
    };
  }
  const {
    tool,
    arguments: args,
    ruling,
    notice,
  } = input as Record<string, unknown>;
  if (
    typeof tool !== "string" ||
    tool.length === 0 ||
    typeof ruling !== "string" ||
    typeof notice !== "object" ||
    notice === null
  ) {
    return null;
  }
  return { tool, arguments: parseArguments(args), ruling };
}

/** The call as the policy sees it: a run_tool dispatch names its target. */
function resolveAttempt(params: {
  part: ToolPart;
  toolName: string;
  getToolShortName: (toolName: string) => ArchestraToolShortName | null;
}): { toolName: string; arguments: unknown } {
  const { part, toolName, getToolShortName } = params;
  const shortName = getToolShortName(toolName);
  if (shortName === TOOL_RUN_TOOL_SHORT_NAME) {
    const input = (part.input ?? {}) as {
      tool_name?: unknown;
      tool_args?: unknown;
    };
    if (typeof input.tool_name === "string" && input.tool_name.length > 0) {
      return {
        toolName: input.tool_name,
        arguments: parseArguments(input.tool_args ?? {}),
      };
    }
  }
  return {
    toolName,
    arguments: withoutProxyTransportArguments({
      toolName,
      shortName,
      input: part.input ?? {},
    }),
  };
}

/** OpenAI-family notices carry the arguments as a JSON string. */
function parseArguments(args: unknown): unknown {
  if (typeof args !== "string") return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/**
 * The offer ids a ruling presents as remedies, from its
 * `execute_remedy_plan(offer_id: "…", plan: "…")` lines. Only these belong to
 * the blocked call; an id the ruling merely mentions elsewhere does not.
 */
function offeredRemedyIds(rulingText: string): Set<string> {
  return new Set(
    Array.from(
      rulingText.matchAll(/execute_remedy_plan\(offer_id:\s*\\*"([^"\\]+)/g),
      (match) => match[1],
    ),
  );
}

function outputText(output: unknown): string {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return "";
  }
}
