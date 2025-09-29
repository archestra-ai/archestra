import type { LanguageModelV2Middleware } from '@ai-sdk/provider';
import { context } from './persistence';

export const sessionPersistenceMiddleware = (
  sessionId: string
): LanguageModelV2Middleware => ({
  wrapGenerate: async ({ doGenerate }) => {
    // Generate the response
    const doGenerateResponse = await doGenerate();

    /**
     * The full context history, in this case, is equivalent to the request sent to the model
     * + the response from the model
     */
    context.updateSessionContext(sessionId, [
      ...((doGenerateResponse.request?.body as any)?.input || []),
      ...((doGenerateResponse.response?.body as any).output || []),
    ]);

    return doGenerateResponse;
  },

  /**
   * TODO: Streaming implementation - more challenging due to incremental nature
   * See https://ai-sdk.dev/docs/ai-sdk-core/middleware#guardrails
   */
  wrapStream: async ({ doStream, model, params }) => {
    return doStream();
  },
});
