import { DualLlmSubagent } from "@/agents/subagents/dual-llm";
import logger from "@/logging";
import { TrustedDataPolicyModel } from "@/models";
import type { PolicyEvaluationContext } from "@/models/tool-invocation-policy";
import type {
  CommonMessage,
  DualLlmAnalysis,
  GlobalToolPolicy,
  ToolResultUpdates,
} from "@/types";

/**
 * Evaluate if context is trusted and return updates for tool results
 *
 * @param messages - Messages in common format
 * @param agentId - The agent ID
 * @param apiKey - API key for the LLM provider (optional for Gemini with Vertex AI)
 * @param provider - The LLM provider
 * @param considerContextUntrusted - If true, marks context as untrusted from the beginning
 * @param globalToolPolicy - The organization's global tool policy ("permissive" or "restrictive")
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
  globalToolPolicy: GlobalToolPolicy = "restrictive",
  policyContext: PolicyEvaluationContext,
  onDualLlmStart?: () => void,
  onDualLlmProgress?: (progress: {
    question: string;
    options: string[];
    answer: string;
  }) => void,
): Promise<{
  toolResultUpdates: ToolResultUpdates;
  contextIsTrusted: boolean;
  usedDualLlm: boolean;
  dualLlmAnalyses: DualLlmAnalysis[];
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
  let hasUntrustedData = false;
  let usedDualLlm = false;

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
    };
  }

  // First, collect all tool calls from all messages
  const allToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    // biome-ignore lint/suspicious/noExplicitAny: tool outputs can be any shape
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
    };
  }

  // Bulk evaluate all tool calls for trusted data policies
  logger.debug(
    { agentId, toolCallCount: allToolCalls.length, globalToolPolicy },
    "[trustedData] evaluateIfContextIsTrusted: bulk evaluating trusted data policies",
  );
  const evaluationResults = await TrustedDataPolicyModel.evaluateBulk(
    agentId,
    allToolCalls.map(({ toolName, toolResult }) => ({
      toolName,
      toolOutput: toolResult,
    })),
    globalToolPolicy,
    policyContext,
  );

  logger.debug(
    { agentId, evaluationResultCount: evaluationResults.size },
    "[trustedData] evaluateIfContextIsTrusted: evaluation results received",
  );

  // Process evaluation results
  for (let i = 0; i < allToolCalls.length; i++) {
    const { toolCallId, toolResult, toolName } = allToolCalls[i];
    const evaluation = evaluationResults.get(i.toString());

    if (!evaluation) {
      // Tool not found - treat as untrusted
      logger.debug(
        { agentId, toolCallId, toolName },
        "[trustedData] evaluateIfContextIsTrusted: no evaluation result, treating as untrusted",
      );
      hasUntrustedData = true;
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
      toolResultUpdates[toolCallId] =
        `[Content blocked by policy${reason ? `: ${reason}` : ""}]`;
      toolResultIsTrusted = false;
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
  };
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
