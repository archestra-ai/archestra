import { BUILT_IN_AGENT_IDS, type SupportedProvider } from "@shared";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import {
  createDirectLLMModel,
  detectProviderFromModel,
  resolveProviderApiKey,
} from "@/clients/llm-client";
import config, { getProviderEnvApiKey } from "@/config";
import logger from "@/logging";
import { AgentModel, ApiKeyModelModel, ChatApiKeyModel } from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { renderSystemPrompt } from "@/templating";
import type {
  Agent,
  CommonDualLlmParams,
  DualLlmAnalysis,
  DualLlmMessage,
} from "@/types";
import { resolveSmartDefaultLlm } from "@/utils/llm-resolution";

export class DualLlmSubagent {
  private constructor(
    private readonly callingAgentId: string,
    private readonly organizationId: string,
    private readonly userId: string | undefined,
    private readonly toolCallId: string,
    private readonly originalUserRequest: string,
    private readonly toolResult: unknown,
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
        logger.warn(
          {
            toolCallId: this.toolCallId,
            response,
          },
          "[dualLlmSubagent] main agent returned invalid question format",
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
    const { model, systemPrompt } = await resolveBuiltInAgentModel({
      agent: params.agent,
      organizationId: this.organizationId,
      userId: this.userId,
    });

    const result = await generateText({
      model,
      system: systemPrompt ?? undefined,
      prompt: params.prompt,
      temperature: 0,
    });

    return result.text.trim();
  }

  private async executeObjectAgent<TSchema extends z.ZodTypeAny>(params: {
    agent: Agent;
    prompt: string;
    schema: TSchema;
  }): Promise<z.infer<TSchema>> {
    const { model, systemPrompt } = await resolveBuiltInAgentModel({
      agent: params.agent,
      organizationId: this.organizationId,
      userId: this.userId,
    });

    const result = await generateObject({
      model,
      system: systemPrompt ?? undefined,
      prompt: params.prompt,
      schema: params.schema,
      temperature: 0,
    });

    return result.object as z.infer<TSchema>;
  }
}

async function resolveBuiltInAgentModel(params: {
  agent: Agent;
  organizationId: string;
  userId?: string;
}): Promise<{
  model: ReturnType<typeof createDirectLLMModel>;
  systemPrompt: string | null;
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

  if (agent.llmApiKeyId) {
    const apiKey = await ChatApiKeyModel.findById(agent.llmApiKeyId);
    if (apiKey) {
      const bestModel = await ApiKeyModelModel.getBestModel(apiKey.id);
      const secretValue = apiKey.secretId
        ? await getSecretValueForLlmProviderApiKey(apiKey.secretId)
        : undefined;

      return {
        provider: apiKey.provider,
        apiKey: secretValue,
        modelName:
          agent.llmModel ?? bestModel?.modelId ?? config.chat.defaultModel,
        baseUrl: apiKey.baseUrl,
      };
    }
  }

  if (agent.llmModel) {
    const provider = detectProviderFromModel(agent.llmModel);
    const resolvedApiKey = await resolveProviderApiKey({
      organizationId,
      userId,
      provider,
    });

    return {
      provider,
      apiKey: resolvedApiKey.apiKey,
      modelName: agent.llmModel,
      baseUrl: resolvedApiKey.baseUrl,
    };
  }

  const smartDefault = await resolveSmartDefaultLlm({ organizationId, userId });
  if (smartDefault) {
    return smartDefault;
  }

  return {
    provider: config.chat.defaultProvider,
    apiKey: getProviderEnvApiKey(config.chat.defaultProvider),
    modelName: config.chat.defaultModel,
    baseUrl: null,
  };
}

function buildQuestionPrompt(params: {
  originalUserRequest: string;
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

Current round: ${params.round} of ${params.maxRounds}

Transcript so far:
${transcript}

Decide the next multiple-choice question, or reply with DONE if the transcript is sufficient.`;
}

function buildSummaryPrompt(params: {
  originalUserRequest: string;
  conversation: DualLlmMessage[];
}): string {
  const transcript =
    params.conversation.length > 0
      ? params.conversation.map((message) => message.content).join("\n\n")
      : "No transcript available.";

  return `SUMMARY MODE

Original user request:
${params.originalUserRequest}

Transcript:
${transcript}

Write the final safe summary.`;
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
