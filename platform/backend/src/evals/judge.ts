import { generateObject } from "ai";
import { z } from "zod";
import { createLLMModel, isApiKeyRequired } from "@/clients/llm-client";
import type { EvalAssertionResult } from "@/types/eval";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";
import { repairStructuredOutputText } from "@/utils/structured-output-repair";

const JudgeVerdictSchema = z.object({
  passed: z
    .boolean()
    .describe("true only if the output satisfies the criteria"),
  reason: z.string().describe("one or two sentences explaining the verdict"),
});

/** Verdicts stay short; a judge that rambles is burning eval budget. */
const JUDGE_MAX_OUTPUT_TOKENS = 1024;

/**
 * Grade one case output with an LLM judge. The judge model is the
 * organization-default LLM (there is deliberately no per-suite judge model in
 * the alpha), resolved and billed under the run creator like any other
 * server-side LLM feature. Throws on unresolvable credentials or provider
 * errors — the caller marks the case `error` rather than guessing a verdict.
 */
export async function runLlmJudge(params: {
  criteria: string;
  expected?: string;
  input: string;
  outputText: string;
  organizationId: string;
  userId: string;
  /** Agent under evaluation; used only for interaction attribution. */
  agentId: string;
  /** LLM proxy session id for the judge call, e.g. `eval-judge-<resultId>`. */
  sessionId: string;
  abortSignal?: AbortSignal;
}): Promise<EvalAssertionResult> {
  const selection = await resolveAgentLlmOrDefault({
    organizationId: params.organizationId,
    userId: params.userId,
  });
  if (isApiKeyRequired(selection.provider, selection.apiKey)) {
    throw new Error(
      "No LLM provider API key is configured for the eval judge (organization default LLM)",
    );
  }

  const model = createLLMModel({
    provider: selection.provider,
    apiKey: selection.apiKey,
    agentId: params.agentId,
    modelName: selection.modelName,
    userId: params.userId,
    sessionId: params.sessionId,
    source: "eval:judge",
    baseUrl: selection.baseUrl,
    chatApiKeyId: selection.chatApiKeyId,
  });

  const { object } = await generateObject({
    model,
    schema: JudgeVerdictSchema,
    prompt: buildJudgePrompt(params),
    maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    experimental_repairText: repairStructuredOutputText,
    abortSignal: params.abortSignal,
  });

  return { type: "llm_judge", passed: object.passed, reason: object.reason };
}

function buildJudgePrompt(params: {
  criteria: string;
  expected?: string;
  input: string;
  outputText: string;
}): string {
  return [
    "You are grading the output of an AI agent against evaluation criteria.",
    "Judge ONLY whether the output satisfies the criteria. Ignore style unless the criteria mention it.",
    "",
    "<input>",
    params.input,
    "</input>",
    "",
    "<output>",
    params.outputText,
    "</output>",
    "",
    "<criteria>",
    params.criteria,
    "</criteria>",
    ...(params.expected !== undefined
      ? ["", "<reference_answer>", params.expected, "</reference_answer>"]
      : []),
  ].join("\n");
}
