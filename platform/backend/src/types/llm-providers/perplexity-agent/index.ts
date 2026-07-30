/**
 * Perplexity Agent LLM Provider Types
 *
 * Perplexity's Agent API at https://api.perplexity.ai/v1, a Responses-shaped
 * surface kept separate from the `perplexity` provider's `sonar*`
 * chat-completions models: different wire format, different catalog, and —
 * the reason it exists here — tool calling.
 *
 * @see https://docs.perplexity.ai/api-reference/agent-post
 */
import type {
  Response,
  ResponseCreateParams,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { z } from "zod";
import * as PerplexityAgentAPI from "./api";

namespace PerplexityAgent {
  export const API = PerplexityAgentAPI;

  export namespace Types {
    export type ResponsesHeaders = z.infer<
      typeof PerplexityAgentAPI.ResponsesHeadersSchema
    >;
    export type ResponsesRequest = ResponseCreateParams & { model: string };
    export type ResponsesResponse = Response;
    export type ResponsesUsage = z.infer<
      typeof PerplexityAgentAPI.ResponsesUsageSchema
    >;
    export type ResponseObject = Response;
    export type ResponseChunk = ResponseStreamEvent;
  }
}

export default PerplexityAgent;
