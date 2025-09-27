import type { LanguageModelV2Middleware } from '@ai-sdk/provider';
import DynamicAutonomyPolicyEvaluatorFactory from './security/dynamic';
import { SupportedDynamicAutonomyPolicyEvaluators } from './security/types';
import { globalTaintContextMap } from './tools';

/**
 * Creates a language model middleware that checks the credibility of the context
 * using the dual LLM pattern when tainted data is detected
 */
export const contextCredibilityMiddleware = ({
  dynamicEvaluatorType = 'dual-llm',
  debug,
}: {
  dynamicEvaluatorType?: SupportedDynamicAutonomyPolicyEvaluators;
  debug?: boolean;
}): LanguageModelV2Middleware => ({
  wrapGenerate: async ({ doGenerate, model }) => {
    // Generate the response
    const response = await doGenerate();

    // Check if we have any tainted data from tool responses
    if (globalTaintContextMap.hasTaintedData()) {
      if (debug) {
        console.log(
          '[SECURITY] Tainted data detected, running dual LLM evaluation...'
        );
      }

      // Get all tainted contexts
      const taintedContexts = globalTaintContextMap.getTaintedContexts();

      // Create the dynamic evaluator with the response content and tainted contexts
      const dynamicEvaluator = new DynamicAutonomyPolicyEvaluatorFactory(
        response.content, // Pass the full message history
        model,
        dynamicEvaluatorType,
        taintedContexts
      );

      // Evaluate using the dual LLM pattern
      const dynamicResult = await dynamicEvaluator.evaluate();

      // If the evaluation fails, block the tool execution
      if (!dynamicResult.isAllowed) {
        if (debug) {
          console.error(
            '[SECURITY] Tool execution blocked by dual LLM evaluation:',
            dynamicResult.denyReason
          );
        }

        // Clear the tainted contexts after evaluation
        globalTaintContextMap.clear();

        return {
          ...response,
          text: undefined,
          toolCalls: [], // Remove any tool calls
          toolResults: [], // Remove any tool results
          content: [
            {
              type: 'text',
              text: `⚠️ Security Alert: Potential prompt injection detected!\n\n${dynamicResult.denyReason}\n\nThe requested action has been blocked for your safety. If you believe this is a false positive, please review the content and try rephrasing your request.`,
            },
          ],
          finishReason: 'error',
        };
      }

      if (debug) {
        console.log(
          '[SECURITY] Dual LLM evaluation passed, proceeding with response'
        );
      }

      // Clear the tainted contexts after successful evaluation
      globalTaintContextMap.clear();
    }

    return response;
  },

  /**
   * Streaming implementation - more challenging due to incremental nature
   * For now, we'll perform evaluation at the end of the stream
   */
  wrapStream: async ({ doStream, model, params }) => {
    const stream = await doStream();

    // TODO: Implement streaming evaluation
    // This is complex because we need to wait for the full stream to complete
    // before we can evaluate tainted data. For now, we return the stream as-is
    // and rely on the wrapGenerate method for non-streaming requests

    return stream;
  },
});
