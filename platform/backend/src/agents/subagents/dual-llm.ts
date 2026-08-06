import {
  BUILT_IN_AGENT_IDS,
  DUAL_LLM_DEFAULT_MAX_ROUNDS,
  type SupportedProvider,
  TimeInMs,
} from "@archestra/shared";
import { APICallError, generateText, RetryError } from "ai";
import { z } from "zod";
import {
  buildDualLlmCallSettings,
  type DualLlmCallSettings,
} from "@/agents/subagents/dual-llm-call-settings";
import { type AllowedCacheKey, cacheManager } from "@/cache-manager";
import {
  createLLMModel,
  isApiKeyRequired,
  type LLMModel,
} from "@/clients/llm-client";
import logger from "@/logging";
import { AgentModel } from "@/models";
import { renderSystemPrompt } from "@/templating";
import type {
  Agent,
  CommonDualLlmParams,
  DualLlmAnalysis,
  DualLlmMessage,
} from "@/types";
import { ApiError, DualLlmMessageSchema } from "@/types";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";

/**
 * A failed LLM call inside the Dual LLM workflow, tagged with the provider
 * and model the workflow actually resolved to. The chat request may run on a
 * different provider than the sanitization subagents, so error surfaces must
 * attribute the failure to this provider — not the request's.
 */
export class DualLlmAgentCallError extends Error {
  readonly provider: SupportedProvider;
  readonly modelName: string;

  constructor(params: {
    provider: SupportedProvider;
    modelName: string;
    cause: unknown;
  }) {
    super(
      params.cause instanceof Error
        ? params.cause.message
        : String(params.cause),
    );
    this.name = "DualLlmAgentCallError";
    this.provider = params.provider;
    this.modelName = params.modelName;
    this.cause = params.cause;
  }
}

export class DualLlmSubagent {
  private constructor(
    private readonly callingAgentId: string,
    private readonly organizationId: string,
    private readonly userId: string | undefined,
    private readonly toolCallId: string,
    private readonly originalUserRequest: string,
    private readonly toolResult: unknown,
    private readonly toolDescriptor: string,
    private readonly mainAgent: Agent,
    private readonly quarantineAgent: Agent,
    private readonly maxRounds: number,
    private readonly partialTranscriptCacheKey: AllowedCacheKey | undefined,
  ) {}

  static async create(params: {
    dualLlmParams: CommonDualLlmParams;
    callingAgentId: string;
    organizationId: string;
    userId?: string;
    /**
     * Where to persist completed Q&A rounds when the analysis fails
     * mid-flight, so a retry resumes the interrogation instead of repeating
     * it. Omitted = no resume (the workflow still runs normally).
     */
    partialTranscriptCacheKey?: AllowedCacheKey;
  }): Promise<DualLlmSubagent> {
    const { dualLlmParams, callingAgentId, organizationId, userId } = params;

    const [mainAgent, quarantineAgent] = await Promise.all([
      AgentModel.getBuiltInAgent(
        BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN,
        organizationId,
      ),
      AgentModel.getBuiltInAgent(
        BUILT_IN_AGENT_IDS.DUAL_LLM_QUARANTINE,
        organizationId,
      ),
    ]);

    if (!mainAgent || !quarantineAgent) {
      throw new Error(
        "Dual LLM built-in agents are not seeded for this organization",
      );
    }

    const maxRounds =
      mainAgent.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.DUAL_LLM_MAIN
        ? mainAgent.builtInAgentConfig.maxRounds
        : DUAL_LLM_DEFAULT_MAX_ROUNDS;

    return new DualLlmSubagent(
      callingAgentId,
      organizationId,
      userId,
      dualLlmParams.toolCallId,
      dualLlmParams.userRequest,
      dualLlmParams.toolResult,
      formatToolDescriptor({
        toolName: dualLlmParams.toolName,
        toolArguments: dualLlmParams.toolArguments,
      }),
      mainAgent,
      quarantineAgent,
      maxRounds,
      params.partialTranscriptCacheKey,
    );
  }

  async processWithMainAgent(
    onProgress?: (progress: {
      question: string;
      options: string[];
      answer: string;
    }) => void,
  ): Promise<DualLlmAnalysis> {
    logger.debug(
      {
        callingAgentId: this.callingAgentId,
        toolCallId: this.toolCallId,
        maxRounds: this.maxRounds,
      },
      "[dualLlmSubagent] starting built-in agent workflow",
    );

    // A retry after a mid-flight failure resumes from the persisted completed
    // rounds (progress for those is not replayed; the returned analysis still
    // carries the full transcript).
    const conversation: DualLlmMessage[] = await this.loadPartialTranscript();
    const resumedAnswers = conversation.filter(
      (message) => message.role === "user",
    ).length;

    try {
      const alreadyDone = conversation.at(-1)?.content.trim() === "DONE";
      for (
        let round = alreadyDone ? this.maxRounds : resumedAnswers;
        round < this.maxRounds;
        round++
      ) {
        const response = await this.executeTextAgent({
          agent: this.mainAgent,
          prompt: buildQuestionPrompt({
            originalUserRequest: this.originalUserRequest,
            toolDescriptor: this.toolDescriptor,
            conversation,
            round: round + 1,
            maxRounds: this.maxRounds,
          }),
        });

        conversation.push({ role: "assistant", content: response });

        if (response.trim() === "DONE") {
          break;
        }

        const { question, options } = parseQuestionResponse(response);
        if (!question || options.length === 0) {
          // response is verbatim LLM output derived from user content — size
          // only at warn, payload at debug.
          logger.warn(
            {
              toolCallId: this.toolCallId,
              responseLength: response.length,
            },
            "[dualLlmSubagent] main agent returned invalid question format",
          );
          logger.debug(
            { toolCallId: this.toolCallId, response },
            "[dualLlmSubagent] invalid question response payload",
          );
          break;
        }

        const answerIndex = await this.answerQuestion(question, options);
        const selectedOption = options[answerIndex];

        if (onProgress) {
          onProgress({
            question,
            options,
            answer: `${answerIndex}`,
          });
        }

        conversation.push({
          role: "user",
          content: `Answer: ${answerIndex} (${selectedOption})`,
        });
      }

      const result = await this.executeTextAgent({
        agent: this.mainAgent,
        prompt: buildSummaryPrompt({
          originalUserRequest: this.originalUserRequest,
          toolDescriptor: this.toolDescriptor,
          conversation,
        }),
      });

      await this.clearPartialTranscript();

      return {
        toolCallId: this.toolCallId,
        conversations: conversation,
        result,
      };
    } catch (error) {
      await this.savePartialTranscript(conversation);
      throw error;
    }
  }

  private async answerQuestion(
    question: string,
    options: string[],
  ): Promise<number> {
    const response = await this.executeTextAgent({
      agent: this.quarantineAgent,
      prompt: buildQuarantinePrompt({
        toolResult: this.toolResult,
        question,
        options,
      }),
    });

    const answer = parseAnswerIndex(response);
    if (answer === null || answer < 0 || answer >= options.length) {
      return options.length - 1;
    }

    return answer;
  }

  private async executeTextAgent(params: {
    agent: Agent;
    prompt: string;
  }): Promise<string> {
    const { model, systemPrompt, provider, modelName, callSettings } =
      await resolveBuiltInAgentModel({
        agent: params.agent,
        organizationId: this.organizationId,
        userId: this.userId,
      });

    const attempt = async (settings: DualLlmCallSettings) => {
      const result = await generateText({
        model,
        system: systemPrompt ?? undefined,
        prompt: params.prompt,
        temperature: 0,
        maxOutputTokens: settings.maxOutputTokens,
        providerOptions: settings.providerOptions,
        headers: settings.headers,
      });
      return result.text.trim();
    };

    try {
      return await attempt(callSettings);
    } catch (cause) {
      // The reasoning knobs are per-model gated on catalog knowledge that can
      // lag reality; when the upstream rejects the request shape, retry once
      // without them so a wrong gate degrades to default-effort reasoning
      // instead of failing the guardrail closed.
      const hasReasoningTuning =
        callSettings.providerOptions !== undefined ||
        callSettings.headers !== undefined;
      if (hasReasoningTuning && isParameterRejection(cause)) {
        logger.warn(
          { provider, modelName, toolCallId: this.toolCallId },
          "[dualLlmSubagent] upstream rejected reasoning tuning; retrying without it",
        );
        try {
          return await attempt({
            maxOutputTokens: callSettings.maxOutputTokens,
          });
        } catch (retryCause) {
          throw new DualLlmAgentCallError({
            provider,
            modelName,
            cause: retryCause,
          });
        }
      }
      throw new DualLlmAgentCallError({ provider, modelName, cause });
    }
  }

  private async loadPartialTranscript(): Promise<DualLlmMessage[]> {
    if (!this.partialTranscriptCacheKey) {
      return [];
    }
    try {
      const cached = await cacheManager.get<DualLlmMessage[]>(
        this.partialTranscriptCacheKey,
      );
      const parsed = z.array(DualLlmMessageSchema).safeParse(cached);
      if (!parsed.success || parsed.data.length === 0) {
        return [];
      }
      logger.info(
        {
          toolCallId: this.toolCallId,
          resumedMessages: parsed.data.length,
        },
        "[dualLlmSubagent] resuming interrogation from a partial transcript",
      );
      return parsed.data;
    } catch (error) {
      // A failed read only costs re-asking the questions.
      logger.warn(
        { error, toolCallId: this.toolCallId },
        "[dualLlmSubagent] failed to read partial transcript",
      );
      return [];
    }
  }

  private async savePartialTranscript(
    conversation: DualLlmMessage[],
  ): Promise<void> {
    if (!this.partialTranscriptCacheKey) {
      return;
    }
    // Keep only completed rounds: a trailing question whose answer never
    // arrived would desync the resume round counter. A trailing DONE is
    // terminal and worth keeping — the resume skips straight to the summary.
    const completed = [...conversation];
    while (
      completed.length > 0 &&
      completed.at(-1)?.role === "assistant" &&
      completed.at(-1)?.content.trim() !== "DONE"
    ) {
      completed.pop();
    }
    if (completed.length === 0) {
      return;
    }
    try {
      await cacheManager.set(
        this.partialTranscriptCacheKey,
        completed,
        PARTIAL_TRANSCRIPT_TTL_MS,
      );
    } catch (error) {
      // A failed write only costs a full re-interrogation on retry.
      logger.warn(
        { error, toolCallId: this.toolCallId },
        "[dualLlmSubagent] failed to persist partial transcript",
      );
    }
  }

  private async clearPartialTranscript(): Promise<void> {
    if (!this.partialTranscriptCacheKey) {
      return;
    }
    try {
      await cacheManager.delete(this.partialTranscriptCacheKey);
    } catch (error) {
      // Stale leftovers expire on their own TTL.
      logger.warn(
        { error, toolCallId: this.toolCallId },
        "[dualLlmSubagent] failed to clear partial transcript",
      );
    }
  }
}

// Failures that interrupt an analysis (credential expiry, provider outage)
// are typically retried within minutes; a short TTL keeps a stale transcript
// from outliving the situation that produced it.
const PARTIAL_TRANSCRIPT_TTL_MS = 30 * TimeInMs.Minute;

/**
 * True for upstream request-shape rejections (400/404/422) — the signature of
 * a reasoning knob the model doesn't accept. Auth, rate-limit, and server
 * errors are not retried without tuning: the knob isn't the cause there.
 */
function isParameterRejection(error: unknown): boolean {
  const candidate = RetryError.isInstance(error) ? error.lastError : error;
  return (
    APICallError.isInstance(candidate) &&
    candidate.statusCode !== undefined &&
    [400, 404, 422].includes(candidate.statusCode)
  );
}

async function resolveBuiltInAgentModel(params: {
  agent: Agent;
  organizationId: string;
  userId?: string;
}): Promise<{
  model: LLMModel;
  systemPrompt: string | null;
  provider: SupportedProvider;
  modelName: string;
  callSettings: DualLlmCallSettings;
}> {
  const { agent, organizationId, userId } = params;

  // The shared built-in-subagent chain: the agent's explicitly configured
  // model/key, then the ORGANIZATION DEFAULT model (Settings → Chat), then
  // the best available key, then the env fallback.
  const selection = await resolveAgentLlmOrDefault({
    agent: { llmApiKeyId: agent.llmApiKeyId, modelId: agent.modelId },
    organizationId,
    userId,
  });

  if (isApiKeyRequired(selection.provider, selection.apiKey)) {
    throw new DualLlmAgentCallError({
      provider: selection.provider,
      modelName: selection.modelName,
      cause: new ApiError(
        400,
        `No ${selection.provider} API key is available for the dual LLM security workflow.`,
      ),
    });
  }

  return {
    // Like every other built-in subagent flow (compaction, app LLM, skill
    // description), the model talks to the local LLM proxy loopback: the
    // proxy's provider adapters own the credential transports, so per-user
    // subscription credentials (ChatGPT/Codex, GitHub & Microsoft Copilot)
    // work here too. Recursion into sanitization is impossible — these
    // requests carry no tool results, so trusted data evaluation on the
    // loopback request finds nothing to analyze.
    model: createLLMModel({
      provider: selection.provider,
      apiKey: selection.apiKey,
      // Attribution label for the proxy call (logging/virtual-key label,
      // not an agent the call runs "as").
      agentId: agent.id,
      modelName: selection.modelName,
      userId,
      source: "guardrail:dual_llm",
      baseUrl: selection.baseUrl,
      // The proxy must know which key row supplied the credential: Codex
      // refresh tokens rotate on every redemption, and a loopback call
      // without the row id would discard the rotation and burn the stored
      // credential.
      chatApiKeyId: selection.chatApiKeyId,
    }),
    systemPrompt: renderSystemPrompt(agent.systemPrompt),
    provider: selection.provider,
    modelName: selection.modelName,
    // Interrogation calls disable (or floor) reasoning and cap output —
    // reasoning is pure latency here, and unbounded reasoning tokens were
    // the dominant wall-clock cost of a sanitization pass.
    callSettings: buildDualLlmCallSettings({
      provider: selection.provider,
      modelName: selection.modelName,
      apiKey: selection.apiKey,
    }),
  };
}

function buildQuestionPrompt(params: {
  originalUserRequest: string;
  toolDescriptor: string;
  conversation: DualLlmMessage[];
  round: number;
  maxRounds: number;
}): string {
  const transcript =
    params.conversation.length > 0
      ? params.conversation.map((message) => message.content).join("\n\n")
      : "No prior questions yet.";

  return `QUESTION MODE

Original user request:
${params.originalUserRequest}

The hidden data is the result of this tool call, which you (the calling agent) authored, so its name and arguments are trustworthy context:
${params.toolDescriptor}

Current round: ${params.round} of ${params.maxRounds}

Transcript so far:
${transcript}

Ask about the content of that tool result — what it contains that is needed to fulfill the request. Decide the next multiple-choice question, or reply with DONE if the transcript is sufficient.`;
}

function buildSummaryPrompt(params: {
  originalUserRequest: string;
  toolDescriptor: string;
  conversation: DualLlmMessage[];
}): string {
  const transcript =
    params.conversation.length > 0
      ? params.conversation.map((message) => message.content).join("\n\n")
      : "No transcript available.";

  return `SUMMARY MODE

Original user request:
${params.originalUserRequest}

The hidden data is the result of this tool call:
${params.toolDescriptor}

Transcript:
${transcript}

Write the final safe summary.`;
}

// Arguments are privileged-authored but can be large (file bodies, page
// content); cap them so the descriptor stays a prompt anchor, not a payload.
const TOOL_DESCRIPTOR_ARGUMENTS_MAX_LENGTH = 2_000;

function formatToolDescriptor(params: {
  toolName: string;
  toolArguments?: Record<string, unknown>;
}): string {
  if (!params.toolArguments || Object.keys(params.toolArguments).length === 0) {
    return params.toolName;
  }

  let serializedArguments: string;
  try {
    serializedArguments = JSON.stringify(params.toolArguments);
  } catch {
    return params.toolName;
  }

  if (serializedArguments.length > TOOL_DESCRIPTOR_ARGUMENTS_MAX_LENGTH) {
    serializedArguments = `${serializedArguments.slice(0, TOOL_DESCRIPTOR_ARGUMENTS_MAX_LENGTH)}… (truncated)`;
  }

  return `${params.toolName}(${serializedArguments})`;
}

function buildQuarantinePrompt(params: {
  toolResult: unknown;
  question: string;
  options: string[];
}): string {
  return `Tool result:
${JSON.stringify(params.toolResult, null, 2)}

Question:
${params.question}

Options:
${params.options.map((option, index) => `${index}: ${option}`).join("\n")}

Respond with ONLY the index number of the best option (for example: 2). No other text.`;
}

/**
 * Extract the option index from the quarantine agent's reply. The prompt
 * demands a bare integer, but the format is enforced by instruction only (the
 * proxy loopback cannot guarantee structured output on every transport), so
 * accept the first integer anywhere in the reply — "2", "Answer: 2" and
 * `{"answer": 2}` all resolve. Anything else falls back to the caller's
 * safest-option default.
 */
function parseAnswerIndex(response: string): number | null {
  const match = response.match(/-?\d+/);
  return match ? Number.parseInt(match[0], 10) : null;
}

function parseQuestionResponse(response: string): {
  question: string | null;
  options: string[];
} {
  const questionMatch = response.match(/QUESTION:\s*(.+?)(?=\nOPTIONS:)/s);
  const optionsMatch = response.match(/OPTIONS:\s*([\s\S]+)/);

  if (!questionMatch || !optionsMatch) {
    return { question: null, options: [] };
  }

  return {
    question: questionMatch[1].trim(),
    options: optionsMatch[1]
      .trim()
      .split("\n")
      .map((line) => line.replace(/^\d+:\s*/, "").trim())
      .filter(Boolean),
  };
}
