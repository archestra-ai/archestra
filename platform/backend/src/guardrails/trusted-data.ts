import {
  buildTrustedDataBlockedContentNotice,
  extractMcpToolError,
  isSeededAppRenderToolResult,
  type SensitiveContextOrigin,
} from "@archestra/shared";
import { DualLlmSubagent } from "@/agents/subagents/dual-llm";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { resolveRunToolDispatch } from "@/archestra-mcp-server/run-tool-target";
import logger from "@/logging";
import { TrustedDataPolicyModel } from "@/models";
import type { PolicyEvaluationContext } from "@/models/tool-invocation-policy";
import type {
  CommonMessage,
  DualLlmAnalysis,
  ToolResultUpdates,
  UnsafeContextBoundary,
  UnsafeContextBoundaryReason,
} from "@/types";
import { UNSAFE_CONTEXT_BOUNDARY_REASON } from "@/types";

/**
 * Evaluate if context is trusted and return updates for tool results
 *
 * @param messages - Messages in common format
 * @param agentId - The agent ID
 * @param apiKey - API key for the LLM provider (optional for Gemini with Vertex AI)
 * @param provider - The LLM provider
 * @param considerContextUntrusted - If true, marks context as untrusted from the beginning
 * @param onDualLlmStart - Optional callback when dual LLM processing starts
 * @param onDualLlmProgress - Optional callback for dual LLM Q&A progress
 * @returns Object with tool result updates and trust status
 */
export async function evaluateIfContextIsTrusted(
  messages: CommonMessage[],
  agentId: string,
  organizationId: string,
  userId: string | undefined,
  considerContextUntrusted: boolean = false,
  policyContext: PolicyEvaluationContext,
  onDualLlmStart?: () => void,
  onDualLlmProgress?: (progress: {
    question: string;
    options: string[];
    answer: string;
  }) => void,
  initialUntrustedReason?: UnsafeContextBoundaryReason,
): Promise<{
  toolResultUpdates: ToolResultUpdates;
  contextIsTrusted: boolean;
  usedDualLlm: boolean;
  dualLlmAnalyses: DualLlmAnalysis[];
  unsafeContextBoundary?: UnsafeContextBoundary;
}> {
  logger.debug(
    {
      agentId,
      messageCount: messages.length,
      considerContextUntrusted,
    },
    "[trustedData] evaluateIfContextIsTrusted: starting evaluation",
  );

  const toolResultUpdates: ToolResultUpdates = {};
  const dualLlmAnalyses: DualLlmAnalysis[] = [];
  let hasUntrustedData = false;
  let usedDualLlm = false;
  let unsafeContextBoundary: UnsafeContextBoundary | undefined;

  // If agent configured to consider context untrusted from the beginning,
  // mark context as untrusted immediately and skip evaluation
  if (considerContextUntrusted) {
    logger.debug(
      { agentId },
      "[trustedData] evaluateIfContextIsTrusted: context marked untrusted by agent config",
    );
    return {
      toolResultUpdates: {},
      contextIsTrusted: false,
      usedDualLlm: false,
      dualLlmAnalyses: [],
      unsafeContextBoundary: {
        kind: "preexisting_untrusted",
        reason:
          initialUntrustedReason ??
          UNSAFE_CONTEXT_BOUNDARY_REASON.agentConfiguredUntrusted,
      },
    };
  }

  // First, collect all tool calls from all messages
  const allToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    isRunToolDispatchTarget: boolean;
    // biome-ignore lint/suspicious/noExplicitAny: tool outputs can be any shape
    toolResult: any;
    isPlatformAuthoredResult: boolean;
    isUnresolvedDispatch: boolean;
  }> = [];

  for (const message of messages) {
    if (message.toolCalls && message.toolCalls.length > 0) {
      for (const toolCall of message.toolCalls) {
        // A run_tool call carries the *target* tool's output (progressive
        // tool loading routes every third-party call through it). Evaluate
        // the target's trusted-data policies — the wrapper's built-in name
        // would be auto-trusted and the target's "sensitive" policy would
        // never fire. A dispatch whose target cannot be recovered from the
        // call's arguments is flagged to fail closed below.
        const dispatch = resolveRunToolDispatch(
          toolCall.name,
          toolCall.arguments,
        );
        allToolCalls.push({
          toolCallId: toolCall.id,
          toolName:
            dispatch.kind === "target" ? dispatch.toolName : toolCall.name,
          isRunToolDispatchTarget: dispatch.kind === "target",
          toolResult: toolCall.content,
          // Results the platform itself authored carry no external data and
          // must not flip the context to untrusted:
          // - a platform-generated `tool_state` envelope (e.g. unknown_tool)
          //   means no upstream tool ran, so the result is our own text;
          // - a seeded app render (open-in-chat conversation seeding) is a
          //   platform-built render pointer, marked with a reserved `_meta`
          //   key that mcp-client strips from every live upstream result.
          isPlatformAuthoredResult:
            extractMcpToolError(toolCall)?.type === "tool_state" ||
            isSeededAppRenderToolResult(toolCall.content),
          isUnresolvedDispatch: dispatch.kind === "unresolved",
        });
      }
    }
  }

  logger.debug(
    { agentId, toolCallCount: allToolCalls.length },
    "[trustedData] evaluateIfContextIsTrusted: collected tool calls from messages",
  );

  if (allToolCalls.length === 0) {
    logger.debug(
      { agentId },
      "[trustedData] evaluateIfContextIsTrusted: no tool calls found, context is trusted",
    );
    return {
      toolResultUpdates,
      contextIsTrusted: true,
      usedDualLlm: false,
      dualLlmAnalyses: [],
      unsafeContextBoundary,
    };
  }

  // Bulk evaluate all tool calls for trusted data policies
  logger.debug(
    { agentId, toolCallCount: allToolCalls.length },
    "[trustedData] evaluateIfContextIsTrusted: bulk evaluating trusted data policies",
  );
  const evaluationResults = await TrustedDataPolicyModel.evaluateBulk(
    agentId,
    allToolCalls.map(({ toolName, toolResult, isRunToolDispatchTarget }) => ({
      toolName,
      toolOutput: toolResult,
      isRunToolDispatchTarget,
    })),
    policyContext,
  );

  logger.debug(
    { agentId, evaluationResultCount: evaluationResults.size },
    "[trustedData] evaluateIfContextIsTrusted: evaluation results received",
  );

  // Process evaluation results
  for (let i = 0; i < allToolCalls.length; i++) {
    const {
      toolCallId,
      toolResult,
      toolName,
      isPlatformAuthoredResult,
      isUnresolvedDispatch,
    } = allToolCalls[i];
    // A platform-authored result (dispatch error or seeded app render) never
    // carries upstream data. Skip it — otherwise it has no trusted-data
    // evaluation (or no matching policy) and falls through to the untrusted
    // branch below, poisoning the session over a benign platform message.
    if (isPlatformAuthoredResult) {
      continue;
    }
    // A run_tool call whose target tool cannot be recovered: we cannot know
    // which tool produced this data, so its policies cannot be consulted —
    // fail closed rather than inherit the wrapper's built-in auto-trust.
    if (isUnresolvedDispatch) {
      hasUntrustedData = true;
      unsafeContextBoundary ??= createToolResultBoundary({
        reason: "tool_result_marked_untrusted",
        toolCallId,
        toolName,
      });
      continue;
    }
    // evaluateBulk() returns a Map keyed by the stringified input index, so we
    // read results back using the same positional key we submitted above.
    const evaluation = evaluationResults.get(i.toString());

    if (!evaluation) {
      // Tool not found - treat as untrusted
      logger.debug(
        { agentId, toolCallId, toolName },
        "[trustedData] evaluateIfContextIsTrusted: no evaluation result, treating as untrusted",
      );
      hasUntrustedData = true;
      // Preserve the first point where context became unsafe so the UI can show
      // a stable boundary even if later tool results are also untrusted.
      unsafeContextBoundary ??= createToolResultBoundary({
        reason: "tool_result_marked_untrusted",
        toolCallId,
        toolName,
      });
      continue;
    }

    const { isTrusted, isBlocked, shouldSanitizeWithDualLlm, reason } =
      evaluation;
    let toolResultIsTrusted = isTrusted;
    logger.debug(
      {
        agentId,
        toolCallId,
        toolName,
        isTrusted,
        isBlocked,
        shouldSanitizeWithDualLlm,
      },
      "[trustedData] evaluateIfContextIsTrusted: tool evaluation result",
    );

    if (isBlocked) {
      // Tool result is blocked - replace with blocked message
      logger.debug(
        { agentId, toolCallId, reason },
        "[trustedData] evaluateIfContextIsTrusted: tool result blocked by policy",
      );
      toolResultUpdates[toolCallId] = buildTrustedDataBlockedContentNotice({
        reason,
        productName: archestraMcpBranding.catalogName,
      });
      toolResultIsTrusted = false;
      // Preserve the first point where context became unsafe so the UI can show
      // a stable boundary even if later tool results are also untrusted.
      unsafeContextBoundary ??= createToolResultBoundary({
        reason: "tool_result_blocked",
        toolCallId,
        toolName,
      });
    } else if (shouldSanitizeWithDualLlm) {
      if (!usedDualLlm && onDualLlmStart) {
        logger.debug(
          { agentId, toolCallId },
          "[trustedData] evaluateIfContextIsTrusted: starting dual LLM processing",
        );
        onDualLlmStart();
      }

      usedDualLlm = true;

      const userRequest = extractUserRequest(messages);

      logger.debug(
        { agentId, toolCallId, organizationId, userId },
        "[trustedData] evaluateIfContextIsTrusted: creating dual LLM subagent",
      );
      const dualLlmSubagent = await DualLlmSubagent.create({
        dualLlmParams: {
          toolCallId,
          userRequest,
          toolResult,
        },
        callingAgentId: agentId,
        organizationId,
        userId,
      });

      logger.debug(
        { agentId, toolCallId },
        "[trustedData] evaluateIfContextIsTrusted: processing with dual LLM subagent",
      );
      const analysis =
        await dualLlmSubagent.processWithMainAgent(onDualLlmProgress);
      dualLlmAnalyses.push(analysis);
      toolResultUpdates[toolCallId] = analysis.result;
      logger.debug(
        { agentId, toolCallId, summaryLength: analysis.result.length },
        "[trustedData] evaluateIfContextIsTrusted: dual LLM processing complete",
      );
      toolResultIsTrusted = true;
    }

    if (!toolResultIsTrusted) {
      hasUntrustedData = true;
      // Preserve the first point where context became unsafe so the UI can show
      // a stable boundary even if later tool results are also untrusted.
      unsafeContextBoundary ??= createToolResultBoundary({
        reason: "tool_result_marked_untrusted",
        toolCallId,
        toolName,
      });
    }
    // If not blocked or sanitized, no update needed (original content remains)
  }

  logger.debug(
    {
      agentId,
      updateCount: Object.keys(toolResultUpdates).length,
      contextIsTrusted: !hasUntrustedData,
      usedDualLlm,
      dualLlmAnalysisCount: dualLlmAnalyses.length,
    },
    "[trustedData] evaluateIfContextIsTrusted: evaluation complete",
  );

  return {
    toolResultUpdates,
    contextIsTrusted: !hasUntrustedData,
    usedDualLlm,
    dualLlmAnalyses,
    unsafeContextBoundary,
  };
}

/**
 * Map the tracked unsafe-context boundary to the origin descriptor embedded in
 * sensitive-context policy block reasons, so the refusal names what flipped
 * the session (a specific tool's result, agent config, or delegation).
 */
export function sensitiveContextOriginFromBoundary(
  boundary: UnsafeContextBoundary | undefined,
): SensitiveContextOrigin | undefined {
  if (!boundary) {
    return undefined;
  }
  if (boundary.kind === "tool_result") {
    return { kind: "tool_result", toolName: boundary.toolName };
  }
  if (boundary.reason === UNSAFE_CONTEXT_BOUNDARY_REASON.inheritedFromParent) {
    return { kind: "inherited_from_parent" };
  }
  return { kind: "agent_configured" };
}

/**
 * Extract the user's original request from messages
 * Looks for the last user message that contains actual content
 */
function extractUserRequest(messages: CommonMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user" && message.content?.trim()) {
      return message.content.trim();
    }
  }

  return "process this data";
}

function createToolResultBoundary(params: {
  reason: UnsafeContextBoundaryReason;
  toolCallId: string;
  toolName: string;
}): UnsafeContextBoundary {
  return {
    kind: "tool_result",
    reason: params.reason,
    toolCallId: params.toolCallId,
    toolName: params.toolName,
  };
}
