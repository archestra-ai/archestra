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

/**
 * Creates a language model middleware that enforces autonomy policies
 *
 * Evaluates:
 * 1. Tool invocation that the model has made
 * 2. Tool responses from the tool invocations that the model has made
 * 3. Dynamic evaluation of the entire conversation context thus far
 *
 * TODO: this isn't entirely correct atm.. Ideally for the tool invocation validation, we would
 * do these checks BEFORE the call to doGenerate.. but I don't see how we can do that at the moment?
 */
export const autonomyPolicyGuardrailsMiddleware = ({
  staticPolicies,
  dynamicEvaluatorType = 'dual-llm',
}: {
  staticPolicies: ToolStaticAutonomyPolicy[];
  dynamicEvaluatorType?: SupportedDynamicAutonomyPolicyEvaluators;
}): LanguageModelV2Middleware => ({
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
      return {
        ...response,
        content: [
          {
            type: 'text',
            text: `⚠️ Tool execution blocked - Autonomy Policy violation (invocation): ${invocationResult.denyReason}`,
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
      return {
        ...response,
        content: [
          {
            type: 'text',
            text: `⚠️ Tool execution blocked - Autonomy Policy violation (response): ${staticResponseResult.denyReason}`,
          },
        ],
        finishReason: 'error',
      };
    }

    const dynamicEvaluator = new DynamicAutonomyPolicyEvaluatorFactory(
      response.content,
      model,
      dynamicEvaluatorType
    );

    const dynamicResult = await dynamicEvaluator.evaluate();
    if (!dynamicResult.isAllowed) {
      return {
        ...response,
        content: [
          {
            type: 'text',
            text: `⚠️ Tool execution blocked - Autonomy Policy violation (Archestra.ai): ${dynamicResult.denyReason}`,
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
