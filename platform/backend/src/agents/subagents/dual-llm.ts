import {
  BUILT_IN_AGENT_IDS,
  providerRequiresPerUserCredential,
  type SupportedProvider,
} from "@archestra/shared";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { createDirectLLMModel } from "@/clients/llm-client";
import config, { getProviderEnvApiKey } from "@/config";
import logger from "@/logging";
import { AgentModel } from "@/models";
import { renderSystemPrompt } from "@/templating";
import type {
  Agent,
  CommonDualLlmParams,
  DualLlmAnalysis,
  DualLlmMessage,
} from "@/types";
import {
  resolveBestAvailableLlm,
  resolveConfiguredAgentLlm,
} from "@/utils/llm-resolution";

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
  ) {}

  static async create(params: {
    dualLlmParams: CommonDualLlmParams;
    callingAgentId: string;
    organizationId: string;
    userId?: string;
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
        : 5;

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

    const conversation: DualLlmMessage[] = [];

    for (let round = 0; round < this.maxRounds; round++) {
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
      const selectedOption =
        options[answerIndex] ?? options[options.length - 1];

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

    return {
      toolCallId: this.toolCallId,
      conversations: conversation,
      result,
    };
  }

  private async answerQuestion(
    question: string,
    options: string[],
  ): Promise<number> {
    const parsed = await this.executeObjectAgent({
      agent: this.quarantineAgent,
      prompt: buildQuarantinePrompt({
        toolResult: this.toolResult,
        question,
        options,
      }),
      schema: z.object({
        answer: z.number().int(),
      }),
    });

    if (
      typeof parsed.answer !== "number" ||
      parsed.answer < 0 ||
      parsed.answer >= options.length
    ) {
      return options.length - 1;
    }

    return parsed.answer;
  }

  private async executeTextAgent(params: {
    agent: Agent;
    prompt: string;
  }): Promise<string> {
    const { model, systemPrompt, provider, modelName } =
      await resolveBuiltInAgentModel({
        agent: params.agent,
        organizationId: this.organizationId,
        userId: this.userId,
      });

    try {
      const result = await generateText({
        model,
        system: systemPrompt ?? undefined,
        prompt: params.prompt,
        temperature: 0,
      });
      return result.text.trim();
    } catch (cause) {
      throw new DualLlmAgentCallError({ provider, modelName, cause });
    }
  }

  private async executeObjectAgent<TSchema extends z.ZodTypeAny>(params: {
    agent: Agent;
    prompt: string;
    schema: TSchema;
  }): Promise<z.infer<TSchema>> {
    const { model, systemPrompt, provider, modelName } =
      await resolveBuiltInAgentModel({
        agent: params.agent,
        organizationId: this.organizationId,
        userId: this.userId,
      });

    try {
      const result = await generateObject({
        model,
        system: systemPrompt ?? undefined,
        prompt: params.prompt,
        schema: params.schema,
        temperature: 0,
      });
      return result.object as z.infer<TSchema>;
    } catch (cause) {
      throw new DualLlmAgentCallError({ provider, modelName, cause });
    }
  }
}

async function resolveBuiltInAgentModel(params: {
  agent: Agent;
  organizationId: string;
  userId?: string;
}): Promise<{
  model: ReturnType<typeof createDirectLLMModel>;
  systemPrompt: string | null;
  provider: SupportedProvider;
  modelName: string;
}> {
  const { agent, organizationId, userId } = params;

  const resolved = await resolveBuiltInAgentSelection({
    agent,
    organizationId,
    userId,
  });

  return {
    model: createDirectLLMModel({
      provider: resolved.provider,
      apiKey: resolved.apiKey,
      modelName: resolved.modelName,
      baseUrl: resolved.baseUrl,
    }),
    systemPrompt: renderSystemPrompt(agent.systemPrompt),
    provider: resolved.provider,
    modelName: resolved.modelName,
  };
}

async function resolveBuiltInAgentSelection(params: {
  agent: Agent;
  organizationId: string;
  userId?: string;
}): Promise<{
  provider: SupportedProvider;
  apiKey: string | undefined;
  modelName: string;
  baseUrl: string | null;
}> {
  const { agent, organizationId, userId } = params;

  // Agent's explicitly configured model/key, then the best available LLM
  // across the org's keys.
  const configured = await resolveConfiguredAgentLlm({
    llmApiKeyId: agent.llmApiKeyId,
    modelId: agent.modelId,
  });
  if (configured) {
    return configured;
  }

  const bestAvailable = await resolveBestAvailableLlm({
    organizationId,
    userId,
  });
  if (bestAvailable) {
    return bestAvailable;
  }

  return {
    provider: config.chat.defaultProvider,
    // Per-user providers (GitHub Copilot) must never use the shared env token —
    // it would be one account's token for this system subagent.
    apiKey: providerRequiresPerUserCredential(config.chat.defaultProvider)
      ? undefined
      : getProviderEnvApiKey(config.chat.defaultProvider),
    modelName: config.chat.defaultModel,
    baseUrl: null,
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

Return the best option index.`;
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
