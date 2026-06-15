import {
  BUILT_IN_AGENT_IDS,
  TOOL_APP_LLM_COMPLETE_SHORT_NAME,
} from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { APICallError, generateText } from "ai";
import { z } from "zod";
import { createLLMModel, isApiKeyRequired } from "@/clients/llm-client";
import logger from "@/logging";
import { AgentModel } from "@/models";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

/**
 * `archestra.llm.complete()` — a single LLM completion an MCP App requests from
 * the host. The org's APP_RUNTIME built-in agent is the proxy identity (so the
 * call goes through the limit-enforcing LLM proxy), while the viewer's userId is
 * carried for per-user attribution — usage counts against existing per-user/org
 * limits and is recorded like any other interaction. The model is the
 * host-resolved default (the app cannot pick one); the app supplies only the
 * prompt, an optional system instruction, and a JSON-output hint.
 */
const PROMPT_MAX_LENGTH = 100_000;
const SYSTEM_MAX_LENGTH = 10_000;

// Provider-agnostic steer (not a per-model response_format knob): the call
// still returns raw text and the app parses it, mirroring Spark's jsonMode.
const JSON_MODE_DIRECTIVE =
  "Respond with a single valid JSON value and nothing else — no prose, no markdown, no code fences.";

const CompleteSchema = z.strictObject({
  prompt: z
    .string()
    .min(1)
    .max(PROMPT_MAX_LENGTH)
    .describe("The prompt to complete."),
  system: z
    .string()
    .max(SYSTEM_MAX_LENGTH)
    .optional()
    .describe("Optional system instruction that frames the completion."),
  jsonMode: z
    .boolean()
    .optional()
    .describe(
      "When true, steer the model to return a single valid JSON value (the caller still parses the returned string).",
    ),
});

const CompleteOutputSchema = z.object({ text: z.string() });

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_APP_LLM_COMPLETE_SHORT_NAME,
    title: "App LLM Completion",
    description:
      "Run a single LLM completion for the calling app (backs archestra.llm.complete).",
    schema: CompleteSchema,
    outputSchema: CompleteOutputSchema,
    async handler({ args, context }) {
      return runAppLlmCompletion(args, context);
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

// =============================================================================
// Internal helpers
// =============================================================================

async function runAppLlmCompletion(
  args: z.infer<typeof CompleteSchema>,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { appId, userId, organizationId } = context;
  if (!appId) {
    return errorResult("LLM completion is only available to a running app.");
  }
  if (!userId || !organizationId) {
    return errorResult("LLM completion requires an authenticated viewer.");
  }

  const agent = await AgentModel.getBuiltInAgent(
    BUILT_IN_AGENT_IDS.APP_RUNTIME,
    organizationId,
  );
  if (!agent) {
    return llmErrorResult(
      "llm_unavailable",
      "The app runtime LLM agent is not configured for this organization.",
    );
  }

  const selection = await resolveAgentLlmOrDefault({
    agent,
    organizationId,
    userId,
  });
  if (isApiKeyRequired(selection.provider, selection.apiKey)) {
    return llmErrorResult(
      "llm_unavailable",
      "No LLM provider API key is configured for this organization.",
    );
  }

  const model = createLLMModel({
    provider: selection.provider,
    apiKey: selection.apiKey,
    agentId: agent.id,
    modelName: selection.modelName,
    userId,
    source: "app:llm_complete",
    baseUrl: selection.baseUrl,
  });

  const system = args.jsonMode
    ? [args.system, JSON_MODE_DIRECTIVE].filter(Boolean).join("\n\n")
    : args.system;

  try {
    const result = await generateText({
      model,
      system: system || undefined,
      prompt: args.prompt,
    });
    return structuredSuccessResult({ text: result.text }, result.text);
  } catch (error) {
    // 429 covers both the org token-cost limit and an upstream provider rate
    // limit; both warrant the same app action (back off and retry), so the
    // message does not assert a single cause.
    if (APICallError.isInstance(error) && error.statusCode === 429) {
      return llmErrorResult(
        "llm_quota",
        "The LLM call was rate-limited or has reached its usage limit — back off and retry.",
      );
    }
    logger.error({ err: error, appId }, "App LLM completion failed");
    return llmErrorResult(
      "llm_unavailable",
      "The LLM completion could not be produced.",
    );
  }
}

// Mirrors app-data's typed-error envelope: a machine-readable code in both
// _meta.archestraError and structuredContent.archestraError so the guest SDK
// can throw a typed { code } the app branches on.
function llmErrorResult(
  type: "llm_quota" | "llm_unavailable",
  message: string,
): CallToolResult {
  const archestraError = { type, message } as const;
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    structuredContent: { archestraError },
    _meta: { archestraError },
    isError: true,
  };
}
