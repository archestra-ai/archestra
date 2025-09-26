import type { LanguageModelV2Middleware } from '@ai-sdk/provider';

import DynamicAutonomyPolicyEvaluatorFactory from './security/dynamic';
import {
  StaticInvocationPolicyEvaluator,
  StaticResponsePolicyEvaluator,
} from './security/static';
import {
  SupportedDynamicAutonomyPolicyEvaluators,
  ToolStaticAutonomyPolicy,
} from './security/types';

interface AutonomyPolicyMiddlewareConfig {
  staticPolicies: ToolStaticAutonomyPolicy[];
  dynamicEvaluatorType?: SupportedDynamicAutonomyPolicyEvaluators;
  onPolicyViolation?: (
    reason: string,
    phase: 'invocation' | 'response' | 'dynamic'
  ) => void;
}

/**
 * Creates a language model middleware that enforces autonomy policies
 *
 * Evaluates:
 * 1. Tool invocation that the model has made
 * 2. Tool responses from the tool invocations that the model has made
 * 3. Dynamic evaluation of the entire conversation context thus far
 */
export const autonomyPolicyGuardrailsMiddleware = ({
  staticPolicies,
  dynamicEvaluatorType = 'dual-llm',
  onPolicyViolation = (reason, phase) => {
    console.warn(`⚠️ Policy violation (${phase}): ${reason}`);
  },
}: AutonomyPolicyMiddlewareConfig): LanguageModelV2Middleware => ({
  wrapGenerate: async ({ doGenerate, model }) => {
    // Generate the response
    const response = await doGenerate();

    const toolCalls = response.content.filter(
      (content) => content.type === 'tool-call'
    );

    /**
     * NOTE: the types here are a bit janky for now.. because LanguageModelV2ToolResult is not exported..
     */
    const toolResults = response.content.filter(
      (content) => content.type === 'tool-result'
    ) as any;

    // Ensure that the tool call invocations are allowed by the invocation policies
    const invocationEvaluator = new StaticInvocationPolicyEvaluator(
      toolCalls,
      staticPolicies
    );

    const invocationResult = invocationEvaluator.evaluate();

    if (!invocationResult.isAllowed) {
      onPolicyViolation(invocationResult.denyReason, 'invocation');

      // Block the tool execution by replacing the response
      return {
        ...response,
        content: [
          {
            type: 'text',
            text: `Tool execution blocked: ${invocationResult.denyReason}`,
          },
        ],
        finishReason: 'error',
      };
    }

    // Ensure that the tool calls are allowed by the invocation policies
    const staticResponseEvaluator = new StaticResponsePolicyEvaluator(
      toolResults,
      staticPolicies
    );

    const staticResponseResult = staticResponseEvaluator.evaluate();

    if (!staticResponseResult.isAllowed) {
      onPolicyViolation(staticResponseResult.denyReason, 'response');
      return {
        ...response,
        content: [
          ...response.content,
          {
            type: 'text',
            text: `Tool execution blocked: ${staticResponseResult.denyReason}`,
          },
        ],
      };
    }

    const dynamicEvaluator = new DynamicAutonomyPolicyEvaluatorFactory(
      response.content,
      model,
      dynamicEvaluatorType
    );

    const dynamicResult = await dynamicEvaluator.evaluate();

    if (!dynamicResult.isAllowed) {
      onPolicyViolation(dynamicResult.denyReason, 'dynamic');

      // Block execution based on dynamic evaluation
      return {
        ...response,
        content: [
          ...response.content,
          {
            type: 'text',
            text: `Tool execution blocked by security analysis: ${dynamicResult.denyReason}`,
          },
        ],
        finishReason: 'error',
      };
    }

    return response;
  },

  /**
   * TODO: implement wrapStream
   *
   * As mentioned in the Vercel SDK docs (https://ai-sdk.dev/docs/ai-sdk-core/middleware#guardrails):
   *
   * Note: streaming guardrails are difficult to implement, because
   * you do not know the full content of the stream until it's finished.
   */
  wrapStream: async ({ doStream, params }) => {
    return doStream();
  },
});
