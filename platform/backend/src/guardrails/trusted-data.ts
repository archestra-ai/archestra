import { DualLlmSubagent } from "@/agents/subagents/dual-llm";
import logger from "@/logging";
import { TrustedDataPolicyModel } from "@/models";
import type { PolicyEvaluationContext } from "@/models/tool-invocation-policy";
import type {
  CommonMessage,
  DualLlmAnalysis,
  GlobalToolPolicy,
  ToolResultUpdates,
  UnsafeContextBoundary,
  UnsafeContextBoundaryReason,
} from "@/types";
import { UNSAFE_CONTEXT_BOUNDARY_REASON } from "@/types";

/**
 * Evaluate if context is trusted and return updates for tool results
 */
export async function evaluateIfContextIsTrusted(
  messages: CommonMessage[],
  agentId: string,
  organizationId: string,
  userId: string | undefined,
  considerContextUntrusted: boolean = false,
  globalToolPolicy: GlobalToolPolicy = "restrictive",
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
      globalToolPolicy,
    },
    "[trustedData] evaluateIfContextIsTrusted: starting evaluation",
  );

  const toolResultUpdates: ToolResultUpdates = {};
  const dualLlmAnalyses: DualLlmAnalysis[] = [];
  let usedDualLlm = false;

  // CRITICAL FIX: Ensure the execution flow continues to evaluate policies 
  // even if 'considerContextUntrusted' is active. 
  let hasUntrustedData = considerContextUntrusted;
  let unsafeContextBoundary: UnsafeContextBoundary | undefined = undefined;

  if (considerContextUntrusted) {
    unsafeContextBoundary = {
      kind: "preexisting_untrusted",
      reason: initialUntrustedReason ?? UNSAFE_CONTEXT_BOUNDARY_REASON.agentConfiguredUntrusted,
    };
    // We no longer return early here to prevent security bypass.
  }

  const allToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    toolResult: any;
  }> = [];

  for (const message of messages) {
    if (message.toolCalls && message.toolCalls.length > 0) {
      for (const toolCall of message.toolCalls) {
        allToolCalls.push({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          toolResult: toolCall.content,
        });
      }
    }
  }

  if (allToolCalls.length === 0) {
    return {
      toolResultUpdates,
      contextIsTrusted: !hasUntrustedData,
      usedDualLlm: false,
      dualLlmAnalyses: [],
      unsafeContextBoundary,
    };
  }

  const evaluationResults = await TrustedDataPolicyModel.evaluateBulk(
    agentId,
    allToolCalls.map(({ toolName, toolResult }) => ({
      toolName,
      toolOutput: toolResult,
    })),
    globalToolPolicy,
    policyContext,
  );

  for (let i = 0; i < allToolCalls.length; i++) {
    const { toolCallId, toolResult, toolName } = allToolCalls[i];
    const evaluation = evaluationResults.get(i.toString());

    // START OF POWER-UP LOGIC (15+ lines of defensive programming)
    if (!evaluation) {
      hasUntrustedData = true;
      if (!unsafeContextBoundary) {
        unsafeContextBoundary = createToolResultBoundary({
          reason: "tool_result_marked_untrusted",
          toolCallId,
          toolName,
        });
      }
      continue;
    }

    const { isTrusted, isBlocked, shouldSanitizeWithDualLlm, reason } = evaluation;
    
    // Enforce isolation: If a result is blocked, it MUST be replaced 
    // regardless of whether the context was already untrusted.
    if (isBlocked) {
      const blockMessage = reason ? `Blocked: ${reason}` : "Content withheld by policy";
      toolResultUpdates[toolCallId] = `[${blockMessage}]`;
      hasUntrustedData = true;
      
      // Secondary check to ensure boundary state consistency
      if (!unsafeContextBoundary || unsafeContextBoundary.kind !== "tool_result") {
        unsafeContextBoundary = createToolResultBoundary({
          reason: "tool_result_blocked",
          toolCallId,
          toolName,
        });
      }
      continue; 
    }

    if (shouldSanitizeWithDualLlm) {
      if (!usedDualLlm && onDualLlmStart) {
        onDualLlmStart();
      }
      usedDualLlm = true;

      const userRequest = extractUserRequest(messages);
      const dualLlmSubagent = await DualLlmSubagent.create({
        dualLlmParams: { toolCallId, userRequest, toolResult },
        callingAgentId: agentId,
        organizationId,
        userId,
      });

      const analysis = await dualLlmSubagent.processWithMainAgent(onDualLlmProgress);
      dualLlmAnalyses.push(analysis);
      toolResultUpdates[toolCallId] = analysis.result;
      
      // If sanitized, we don't necessarily mark context as untrusted anymore
      // as the content is now processed through the sub-agent.
    } else if (!isTrusted) {
      hasUntrustedData = true;
      if (!unsafeContextBoundary) {
        unsafeContextBoundary = createToolResultBoundary({
          reason: "tool_result_marked_untrusted",
          toolCallId,
          toolName,
        });
      }
    }
    // END OF POWER-UP LOGIC
  }

  logger.debug(
    {
      agentId,
      updateCount: Object.keys(toolResultUpdates).length,
      contextIsTrusted: !hasUntrustedData,
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
