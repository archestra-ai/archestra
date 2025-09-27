import type { LanguageModelV2Middleware } from '@ai-sdk/provider';

import { SupportedDynamicAutonomyPolicyEvaluators } from './security/types';

/**
 * Creates a language model middleware that checks the credibility of the context
 *
 * TODO: basically we need to check if any tool calls that have been made thus far have tainted the context
 * (this is done via the wrapped tool calls)
 */
export const contextCredibilityMiddleware = ({
  dynamicEvaluatorType = 'dual-llm',
}: {
  dynamicEvaluatorType?: SupportedDynamicAutonomyPolicyEvaluators;
}): LanguageModelV2Middleware => ({
  wrapGenerate: async ({ doGenerate, model }) => {
    // Generate the response
    const response = await doGenerate();

    // TODO: see if we've made any tool calls which have tainted the context and then
    // evaluate the dynamic policies
    //
    // const dynamicEvaluator = new DynamicAutonomyPolicyEvaluatorFactory(
    //   response.content,
    //   model,
    //   dynamicEvaluatorType
    // );

    // const dynamicResult = await dynamicEvaluator.evaluate();
    // if (!dynamicResult.isAllowed) {
    //   return {
    //     ...response,
    //     content: [
    //       {
    //         type: 'text',
    //         text: `⚠️ Tool execution blocked - Autonomy Policy violation (Archestra.ai): ${dynamicResult.denyReason}`,
    //       },
    //     ],
    //     finishReason: 'error',
    //   };
    // }

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
