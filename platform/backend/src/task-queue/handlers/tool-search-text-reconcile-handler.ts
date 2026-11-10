import type { SupportedProvider } from "@archestra/shared";
import { generateObject, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import {
  hashToolDefinition,
  parseSearchText,
  TOOL_SEARCH_TEXT_PROMPT_VERSION,
  TOOL_SEARCH_TEXT_SYSTEM_PROMPT,
  type ToolDefinition,
} from "@/archestra-mcp-server/search-text";
import { createDirectLLMModel } from "@/clients/llm-client";
import {
  getProviderChatInteractionType,
  withKbObservability,
} from "@/knowledge-base/kb-interaction";
import { resolveApiKeyFromChatApiKey } from "@/knowledge-base/kb-llm-client";
import logger from "@/logging";
import {
  LlmProviderApiKeyModelLinkModel,
  OrganizationModel,
  ToolModel,
  ToolSearchTextModel,
} from "@/models";
import { metrics } from "@/observability";
import type { Organization } from "@/types";
import type { ParsedSearchText } from "@/types/tool-search-text";
import { repairStructuredOutputText } from "@/utils/structured-output-repair";

/**
 * One periodic pass: generate search text for catalog tool definitions that
 * need it and drop text no definition references. Logs its own outcome and
 * never throws, so the periodic chain always reschedules.
 */
export async function reconcileToolSearchTexts(): Promise<void> {
  try {
    const organization = await OrganizationModel.getFirst();
    const generator = organization
      ? await resolveGenerator(organization)
      : null;
    if (!organization || !generator) {
      logger.info("No system LLM for tool search text; skipping this pass");
      return;
    }

    const definitions = await listDefinitions(organization.id);
    const attempts = await ToolSearchTextModel.findAttempts();
    await ToolSearchTextModel.deleteExcept([...definitions.keys()]);

    const attemptByHash = new Map(
      attempts.map((attempt) => [attempt.definitionHash, attempt]),
    );
    const now = Date.now();
    const due = [...definitions.entries()]
      .filter(([hash]) =>
        isDue({
          attempt: attemptByHash.get(hash),
          generator: generator.id,
          now,
        }),
      )
      .slice(0, MAX_GENERATIONS_PER_PASS);

    const outcomes: ParsedSearchText["status"][] = [];
    for (let i = 0; i < due.length; i += CONCURRENCY) {
      if (Date.now() - now >= PASS_BUDGET_MS) break;
      outcomes.push(
        ...(await Promise.all(
          due
            .slice(i, i + CONCURRENCY)
            .map(([hash, definition]) =>
              generateAndRecord({ hash, definition, generator }),
            ),
        )),
      );
    }

    const covered = await ToolSearchTextModel.countWithText();
    metrics.toolSearchText.reportCoverage(
      definitions.size === 0 ? 1 : covered / definitions.size,
    );
    logger.info(
      {
        generator: generator.id,
        definitions: definitions.size,
        covered,
        attempted: outcomes.length,
        ready: outcomes.filter((outcome) => outcome === "ready").length,
        empty: outcomes.filter((outcome) => outcome === "empty").length,
        failed: outcomes.filter((outcome) => outcome === "failed").length,
      },
      "Reconciled tool search texts",
    );
  } catch (error) {
    logger.error(
      { err: error },
      "Tool search text reconcile failed; the next tick retries it",
    );
  }
}

// ===== Internal =====

const MAX_GENERATIONS_PER_PASS = 200;
const CONCURRENCY = 4;
const GENERATION_TIMEOUT_MS = 60_000;
// Keeps a slow provider from holding a shared system-lane slot.
const PASS_BUDGET_MS = 5 * 60 * 1000;
const MAX_OUTPUT_TOKENS = 4096;
const FAILED_RETRY_MS = 24 * 60 * 60 * 1000;

const GeneratedSearchTextSchema = z.object({ search_text: z.string() });

type Generator = {
  id: string;
  provider: SupportedProvider;
  modelName: string;
  llmModel: ReturnType<typeof createDirectLLMModel>;
};

async function resolveGenerator(
  organization: Organization,
): Promise<Generator | null> {
  const chatApiKeyId = organization.defaultLlmApiKeyId;
  if (!chatApiKeyId) return null;
  const resolved = await resolveApiKeyFromChatApiKey(chatApiKeyId);
  if (!resolved) return null;

  const linkedModels =
    await LlmProviderApiKeyModelLinkModel.getModelsForApiKey(chatApiKeyId);
  const model =
    linkedModels.find(({ id }) => id === organization.defaultFastModelId) ??
    linkedModels.find(({ id }) => id === organization.defaultModelId);
  if (!model) return null;

  return {
    id: `${resolved.provider}/${model.modelId}`,
    provider: resolved.provider,
    modelName: model.modelId,
    llmModel: createDirectLLMModel({
      provider: resolved.provider,
      apiKey: resolved.apiKey ?? undefined,
      modelName: model.modelId,
      baseUrl: resolved.baseUrl,
      chatApiKeyId,
    }),
  };
}

async function listDefinitions(
  organizationId: string,
): Promise<Map<string, ToolDefinition>> {
  const tools = await ToolModel.findSearchTextDefinitions(organizationId);
  return new Map(tools.map((tool) => [hashToolDefinition(tool), tool]));
}

function isDue(params: {
  attempt:
    | {
        status: ParsedSearchText["status"];
        promptVersion: number;
        generator: string;
        updatedAt: Date;
      }
    | undefined;
  generator: string;
  now: number;
}): boolean {
  const { attempt, generator, now } = params;
  if (!attempt) return true;
  if (
    attempt.promptVersion !== TOOL_SEARCH_TEXT_PROMPT_VERSION ||
    attempt.generator !== generator
  ) {
    return true;
  }
  return (
    attempt.status === "failed" &&
    now - attempt.updatedAt.getTime() >= FAILED_RETRY_MS
  );
}

async function generateAndRecord(params: {
  hash: string;
  definition: ToolDefinition;
  generator: Generator;
}): Promise<ParsedSearchText["status"]> {
  const { definition, generator, hash } = params;
  const result = await generate({ definition, generator });
  await ToolSearchTextModel.recordAttempt({
    definitionHash: hash,
    promptVersion: TOOL_SEARCH_TEXT_PROMPT_VERSION,
    generator: generator.id,
    result,
  });
  metrics.toolSearchText.reportGeneration(result.status);
  return result.status;
}

async function generate(params: {
  definition: ToolDefinition;
  generator: Generator;
}): Promise<ParsedSearchText> {
  const { definition, generator } = params;
  const prompt = JSON.stringify(definition);
  const buildInteraction = (usage: Usage, content: string) => ({
    request: {
      model: generator.modelName,
      messages: [
        { role: "system" as const, content: TOOL_SEARCH_TEXT_SYSTEM_PROMPT },
        { role: "user" as const, content: prompt },
      ],
    },
    response: {
      id: `tool-search-text-${crypto.randomUUID()}`,
      object: "chat.completion" as const,
      created: Math.floor(Date.now() / 1000),
      model: generator.modelName,
      choices: [
        {
          index: 0,
          message: { role: "assistant" as const, content, refusal: null },
          finish_reason: "stop" as const,
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      },
    },
    model: generator.modelName,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  });

  try {
    const result = await withKbObservability({
      operationName: "chat",
      provider: generator.provider,
      model: generator.modelName,
      source: "tool_search_text:generation",
      type: getProviderChatInteractionType(generator.provider),
      callback: () =>
        generateObject({
          model: generator.llmModel,
          schema: GeneratedSearchTextSchema,
          system: TOOL_SEARCH_TEXT_SYSTEM_PROMPT,
          prompt,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          abortSignal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
          experimental_repairText: repairStructuredOutputText,
        }),
      buildInteraction: (response) =>
        buildInteraction(response.usage, JSON.stringify(response.object)),
      buildInteractionOnError: (error) =>
        NoObjectGeneratedError.isInstance(error) && error.usage
          ? buildInteraction(error.usage, error.text ?? "")
          : null,
    });
    return parseSearchText(result.object.search_text);
  } catch (error) {
    logger.warn(
      { err: error, toolName: definition.name },
      "Tool search text generation failed",
    );
    return { status: "failed" };
  }
}

type Usage = { inputTokens?: number; outputTokens?: number };
