import { BUILT_IN_AGENT_IDS, TOOL_ADVISOR_SHORT_NAME } from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { APICallError, generateText } from "ai";
import { z } from "zod";
import { createLLMModel, isApiKeyRequired } from "@/clients/llm-client";
import config from "@/config";
import logger from "@/logging";
import { AgentModel, ModelModel } from "@/models";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";
import {
  defineArchestraTool,
  defineArchestraTools,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

/**
 * `advisor` — a second opinion a working model asks for mid-task. The org's
 * ADVISOR built-in agent supplies the model and credential, so the advisor can
 * be a stronger model on an entirely different provider from the caller's; the
 * call goes through the limit-enforcing LLM proxy under its own interaction
 * source, and is billed at the advisor model's rates rather than the caller's.
 *
 * The advisor sees only what the caller passes. It is deliberately not given
 * the conversation: the same definition serves in-app chat and every external
 * MCP client, and an external client's transcript is not Archestra's to read.
 */
const QUESTION_MAX_LENGTH = 4_000;
const CONTEXT_MAX_LENGTH = 50_000;

/** Advice is a decision plus its reasoning; past this it is writing the code. */
const ADVISOR_MAX_OUTPUT_TOKENS = 2048;

/**
 * A consultation blocks the caller's turn, and `generateText` has no timeout of
 * its own — without this a stalled provider stalls the whole conversation.
 */
const ADVISOR_TIMEOUT_MS = 60_000;

const AdvisorSchema = z.strictObject({
  question: z
    .string()
    .min(1)
    .max(QUESTION_MAX_LENGTH)
    .describe("The decision or problem you want a second opinion on."),
  context: z
    .string()
    .max(CONTEXT_MAX_LENGTH)
    .optional()
    .describe(
      "What the advisor needs to answer well: what you have already tried, the options you are weighing, constraints, and evidence. The advisor cannot see your conversation, files, or tools.",
    ),
});

const AdvisorOutputSchema = z.object({ guidance: z.string() });

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_ADVISOR_SHORT_NAME,
    title: "Advisor",
    // Describes WHEN to consult, not just what the tool is: a model that is
    // only told the advisor exists either never calls it or calls it every
    // turn. The "cannot see your conversation" line is load-bearing — without
    // it callers send a bare question and get advice built on a guess.
    description: `Ask a stronger model for a second opinion before you commit to something.

Consult it:
- before committing to an approach, when more than one is viable and the wrong one is expensive to undo
- when an approach is not converging — you have tried the same thing twice and it still fails, or you are about to change tack
- before you declare the work done, to have the result reviewed

The advisor cannot see your conversation, your files, or your tools, and it cannot run anything or ask you a follow-up question. Put everything it needs in the question and context: the options you are weighing, what you already tried, and the constraints that matter.

It returns a recommendation and the reasoning behind it. It does not edit anything. If it answers that it is missing something, that is a real gap in what you sent — supply it and ask again, rather than acting on an answer built without it.

Consult it a few times in a task, at the decisions that matter — not every step, and not for syntax, lookups, or things you already know.`,
    schema: AdvisorSchema,
    outputSchema: AdvisorOutputSchema,
    async handler({ args, context }) {
      return runAdvisorConsultation(args, context);
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

// =============================================================================
// Internal helpers
// =============================================================================

async function runAdvisorConsultation(
  args: z.infer<typeof AdvisorSchema>,
  context: ArchestraContext,
): Promise<CallToolResult> {
  // The tool is unregistered while the beta gate is off, but an assigned tool
  // row outlives the flag — so a direct call or run_tool can still land here.
  if (!config.advisor.enabled) {
    return advisorErrorResult(
      "advisor_unavailable",
      "Advisor Mode is not enabled on this deployment.",
    );
  }

  const { userId, organizationId, sessionId } = context;
  if (!userId || !organizationId) {
    return advisorErrorResult(
      "advisor_unavailable",
      "A consultation requires an authenticated caller.",
    );
  }

  const agent = await AgentModel.getBuiltInAgent(
    BUILT_IN_AGENT_IDS.ADVISOR,
    organizationId,
  );
  if (!agent) {
    return advisorErrorResult(
      "advisor_unavailable",
      "The advisor agent is not configured for this organization.",
    );
  }

  // An unset model resolves to the org default, which is usually the model
  // already asking — the caller would be advised by itself and told it was a
  // second opinion. Configuring a model is what turns the advisor on.
  if (!agent.modelId) {
    return advisorErrorResult(
      "advisor_unavailable",
      "No advisor model is configured. An administrator sets one on the Advisor agent; until then there is no second opinion to give.",
    );
  }

  const configuredModel = await ModelModel.findById(agent.modelId);
  if (!configuredModel) {
    return advisorErrorResult(
      "advisor_unavailable",
      "The configured advisor model no longer exists.",
    );
  }

  const selection = await resolveAgentLlmOrDefault({
    agent,
    organizationId,
    userId,
  });

  // Resolution falls back to the org default whenever the agent's own model
  // and credential fail to resolve together — a deleted key row is enough. That
  // default is usually the model already asking, so accepting the fallback here
  // would answer the caller with itself and call it a second opinion. Only a
  // selection that actually landed on the configured model is a consultation.
  if (
    selection.modelName !== configuredModel.modelId ||
    selection.provider !== configuredModel.provider
  ) {
    return advisorErrorResult(
      "advisor_unavailable",
      "The configured advisor model could not be resolved — check that its provider credential is still available.",
    );
  }

  if (isApiKeyRequired(selection.provider, selection.apiKey)) {
    return advisorErrorResult(
      "advisor_unavailable",
      "No API key is available for the configured advisor model.",
    );
  }

  const model = createLLMModel({
    provider: selection.provider,
    apiKey: selection.apiKey,
    agentId: agent.id,
    modelName: selection.modelName,
    userId,
    sessionId,
    source: "advisor:consultation",
    baseUrl: selection.baseUrl,
    // Binds per-key state to the row that supplied the credential. Omitting it
    // makes the proxy redeem a rotating subscription token bare and discard the
    // rotation, burning the stored credential.
    chatApiKeyId: selection.chatApiKeyId,
  });

  const timeout = AbortSignal.timeout(ADVISOR_TIMEOUT_MS);
  const abortSignal = context.abortSignal
    ? AbortSignal.any([context.abortSignal, timeout])
    : timeout;

  try {
    const result = await generateText({
      model,
      system: agent.systemPrompt || undefined,
      prompt: buildConsultationPrompt(args),
      maxOutputTokens: ADVISOR_MAX_OUTPUT_TOKENS,
      abortSignal,
      // No tools: an advisor that could consult an advisor turns one decision
      // point into a chain of them, each billed.
    });
    // A cut-off answer reads like a whole one: the executor would act on half
    // an argument believing it had the rest. Say so in the guidance itself,
    // which is the only part the calling model reads.
    const guidance =
      result.finishReason === "length"
        ? `${result.text}\n\n[The advisor reached its output limit — this guidance is cut off. Treat it as partial, and ask a narrower question if you need the rest.]`
        : result.text;

    return structuredSuccessResult({ guidance }, guidance);
  } catch (error) {
    if (
      APICallError.isInstance(error) &&
      (error.statusCode === 429 || error.statusCode === 402)
    ) {
      return advisorErrorResult(
        "advisor_quota",
        "The advisor was rate-limited or has reached its usage limit — continue without it.",
      );
    }
    if (timeout.aborted) {
      return advisorErrorResult(
        "advisor_unavailable",
        "The advisor did not answer in time — continue without it.",
      );
    }
    logger.error(
      {
        err: error,
        organizationId,
        provider: selection.provider,
        model: selection.modelName,
        statusCode: APICallError.isInstance(error)
          ? error.statusCode
          : undefined,
      },
      "Advisor consultation failed",
    );
    return advisorErrorResult(
      "advisor_unavailable",
      advisorFailureMessage(error),
    );
  }
}

/**
 * The advisor is told plainly which part the caller wrote as its question and
 * which as supporting context, so a long context block cannot read as the
 * question itself.
 */
function buildConsultationPrompt(args: z.infer<typeof AdvisorSchema>): string {
  if (!args.context) return `Question:\n${args.question}`;
  return `Question:\n${args.question}\n\nContext from the model asking:\n${args.context}`;
}

/**
 * Mirrors app-llm's envelope rather than reusing `structuredToolErrorResult`:
 * that one carries `McpToolError`, a closed union the frontend renders, and
 * widening it for advisor codes would pull those renderers into this feature.
 */
function advisorErrorResult(
  type: "advisor_quota" | "advisor_unavailable",
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

const UNKNOWN_FAILURE_MESSAGE = "The consultation could not be completed.";

/** Long enough to carry a real reason, short enough that an echoed request cannot become the message. */
const UPSTREAM_REASON_MAX_LENGTH = 300;

/**
 * What the calling model is told when a consultation fails. Assembled from the
 * status code and the provider's own body only — never `APICallError.message`
 * or `.url`, which embed the resolved endpoint. How Archestra routes its LLM
 * calls is not the caller's business.
 */
function advisorFailureMessage(error: unknown): string {
  if (!APICallError.isInstance(error)) return UNKNOWN_FAILURE_MESSAGE;

  const status = error.statusCode;
  const cause =
    status === undefined
      ? UNKNOWN_FAILURE_MESSAGE
      : status === 400 || status === 422
        ? "The advisor model rejected the request — the question and context may be too long for it."
        : status === 401 || status === 403
          ? "The advisor model rejected this organization's credential."
          : status === 404
            ? "The configured advisor model is not available from its provider."
            : status >= 500
              ? "The advisor model is unavailable right now."
              : UNKNOWN_FAILURE_MESSAGE;

  const reason = redactUrls(error.responseBody?.trim())?.slice(
    0,
    UPSTREAM_REASON_MAX_LENGTH,
  );
  return reason ? `${cause} (provider said: ${reason})` : cause;
}

/**
 * The body reaches us from the internal proxy, so it can echo the request URL
 * back — a provider that quotes the endpoint it was called on would otherwise
 * hand the caller the proxy address through the one field we do pass through.
 */
function redactUrls(text: string | undefined): string | undefined {
  return text?.replace(/\bhttps?:\/\/\S+/gi, "[url]");
}
