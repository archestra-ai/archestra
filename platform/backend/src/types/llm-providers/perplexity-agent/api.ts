/**
 * Perplexity Agent API schemas
 *
 * The Agent API is Responses-shaped and OpenAI-compatible: it is served at
 * `POST /v1/agent`, with `POST /v1/responses` as the alias the OpenAI SDKs
 * target. It takes an `input` rather than `messages` and answers with a typed
 * `output` array. It is the only Perplexity surface that accepts `tools` — the
 * `sonar*` chat-completions models take none (see inferPerplexityCapabilities
 * in services/model-sync.ts).
 *
 * The OpenAI Responses schemas are reused rather than restated, because the
 * shapes that matter here are identical: custom functions are declared flat as
 * `{ type: "function", name, parameters }`, calls come back as
 * `{ type: "function_call", call_id, name, arguments }`, and results go back as
 * `{ type: "function_call_output", call_id, output }`. Both schemas also pass
 * through unknown fields, which is what lets the Agent API's own request fields
 * (`preset`, `max_steps`, `models`) and its extra output items
 * (`search_results`, `sandbox_results`, `mcp_call`, …) survive a round trip
 * untouched instead of needing a schema arm each.
 *
 * @see https://docs.perplexity.ai/api-reference/agent-post
 * @see https://docs.perplexity.ai/docs/agent-api/tools/custom-functions
 */

import { z } from "zod";
import {
  ResponsesRequestSchema,
  ResponsesResponseSchema,
  ResponsesUsageSchema,
} from "../openai/api";

export {
  ResponsesRequestSchema,
  ResponsesResponseSchema,
  ResponsesUsageSchema,
};

export const ResponsesHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z
    .string()
    .optional()
    .describe("Bearer token for the Perplexity Agent API")
    .transform((authorization) =>
      authorization ? authorization.replace("Bearer ", "") : undefined,
    ),
});
