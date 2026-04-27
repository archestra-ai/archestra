import type { SupportedProvider } from "@shared";
import { generateObject } from "ai";
import {
  createDirectLLMModel,
  detectProviderFromModel,
} from "@/clients/llm-client";
import config, { getProviderEnvApiKey } from "@/config";
import { resolveApiKeyFromChatApiKey } from "@/knowledge-base/kb-llm-client";
import logger from "@/logging";
import { screenCandidateBeforePersist } from "@/memory/policy/screen-candidate-before-persist";
import {
  type MemoryExtractionOutcome,
  type MemoryExtractionUnavailableReason,
  reportMemoryCandidates,
  reportMemoryExtractionDuration,
  reportMemoryExtractionUnavailable,
} from "@/memory/telemetry/metrics";
import {
  setMemorySpanAttributes,
  withMemorySpan,
} from "@/memory/telemetry/spans";
import {
  ConversationModel,
  MemoryItemModel,
  MemoryTombstoneModel,
  OrganizationModel,
} from "@/models";
import type { ChatMessage } from "@/types";
import {
  ExtractorOutputSchema,
  type MemoryCandidate,
  UnsafeContextBoundarySchema,
} from "@/types";

export type ExtractionResult =
  | {
      status: "completed";
      insertedCount: number;
      skippedCount: number;
    }
  | {
      status: "skipped";
      reason:
        | "conversation_not_found"
        | "agent_not_found"
        | "transcript_empty"
        | "model_unavailable";
    };

class MemoryExtractor {
  async extract(params: {
    conversationId: string;
    userId: string;
    organizationId: string;
    agentId: string;
  }): Promise<ExtractionResult> {
    const extractionStartMs = Date.now();

    return withMemorySpan(
      "extract",
      async (span) => {
        setMemorySpanAttributes(span, {
          scopeType: "user",
          scopeId: params.userId,
        });

        const finish = (
          result: ExtractionResult,
          outcome: MemoryExtractionOutcome,
        ): ExtractionResult => {
          reportMemoryExtractionDuration({
            scopeType: "user",
            outcome,
            durationSeconds: getDurationSeconds(extractionStartMs),
          });
          return result;
        };

        try {
          const conversation = await ConversationModel.findById({
            id: params.conversationId,
            userId: params.userId,
            organizationId: params.organizationId,
          });
          if (!conversation) {
            return finish(
              { status: "skipped", reason: "conversation_not_found" },
              "skipped",
            );
          }
          if (!conversation.agentId || !conversation.agent) {
            return finish(
              { status: "skipped", reason: "agent_not_found" },
              "skipped",
            );
          }

          const messages = asChatMessages(conversation.messages);
          const transcript = buildTranscript(messages);
          if (!transcript) {
            return finish(
              { status: "skipped", reason: "transcript_empty" },
              "skipped",
            );
          }

          const modelConfig = await this.resolveModelConfig({
            organizationId: params.organizationId,
          });
          if (!modelConfig) {
            reportMemoryExtractionUnavailable("missing_model");
            return finish(
              { status: "skipped", reason: "model_unavailable" },
              "skipped",
            );
          }

          let extractorModel: ReturnType<typeof createDirectLLMModel>;
          try {
            extractorModel = createDirectLLMModel({
              provider: modelConfig.provider,
              apiKey: modelConfig.apiKey,
              modelName: modelConfig.modelName,
              baseUrl: modelConfig.baseUrl,
            });
          } catch (error) {
            reportMemoryExtractionUnavailable(
              inferExtractionUnavailableReason(error),
            );
            logger.info(
              {
                conversationId: params.conversationId,
                organizationId: params.organizationId,
                agentId: params.agentId,
                modelName: modelConfig.modelName,
                provider: modelConfig.provider,
                source: modelConfig.source,
                error: error instanceof Error ? error.message : String(error),
              },
              "[memory] extract: model unavailable",
            );
            return finish(
              { status: "skipped", reason: "model_unavailable" },
              "skipped",
            );
          }

          logger.info(
            {
              conversationId: params.conversationId,
              organizationId: params.organizationId,
              agentId: params.agentId,
              modelName: modelConfig.modelName,
              provider: modelConfig.provider,
              source: modelConfig.source,
            },
            "[memory] extract: started",
          );

          const extraction = await generateObject({
            model: extractorModel,
            schema: ExtractorOutputSchema,
            prompt: buildExtractionPrompt({
              transcript,
              maxCandidates: Math.min(
                config.memory.maxCandidatesPerExtraction,
                5,
              ),
            }),
          });
          const parsedOutput = ExtractorOutputSchema.parse(extraction.object);

          const approvedHashes = new Set(
            await MemoryItemModel.listApprovedContentHashesForScope({
              organizationId: params.organizationId,
              scopeType: "user",
              scopeId: params.userId,
            }),
          );

          const seenHashes = new Set<string>();
          const sourceMessageIds = collectSourceMessageIds(messages);
          const candidates = parsedOutput.candidates.slice(
            0,
            Math.min(config.memory.maxCandidatesPerExtraction, 5),
          );

          let insertedCount = 0;
          let skippedCount = 0;
          let acceptedByPolicyScreenCount = 0;

          for (const candidate of candidates) {
            const preparedCandidate = prepareCandidate(candidate);
            if (!preparedCandidate) {
              skippedCount += 1;
              continue;
            }

            const contentHash = MemoryTombstoneModel.getContentHash(
              preparedCandidate.content,
            );
            if (
              seenHashes.has(contentHash) ||
              approvedHashes.has(contentHash)
            ) {
              // Skip duplicates both within this run and against already-approved memory.
              skippedCount += 1;
              continue;
            }

            const policyScreen = await screenCandidateBeforePersist({
              organizationId: params.organizationId,
              scopeType: "user",
              scopeId: params.userId,
              content: preparedCandidate.content,
              source: "extractor",
            });
            if (!policyScreen.allowed) {
              skippedCount += 1;
              continue;
            }
            acceptedByPolicyScreenCount += 1;

            await MemoryItemModel.create({
              organizationId: params.organizationId,
              scopeType: "user",
              scopeId: params.userId,
              kind: preparedCandidate.kind,
              status: "candidate",
              content: preparedCandidate.content,
              createdBy: null,
              extractorVersion: EXTRACTOR_PROMPT_VERSION,
              policyFlags: policyScreen.policyFlags,
              sourceConversationId: params.conversationId,
              sourceMessageIds:
                sourceMessageIds.length > 0 ? sourceMessageIds : null,
              confidenceBand: preparedCandidate.confidenceBand,
            });

            reportMemoryCandidates({
              scopeType: "user",
              extractorVersion: EXTRACTOR_PROMPT_VERSION,
              policyFlags: policyScreen.policyFlags,
            });

            seenHashes.add(contentHash);
            insertedCount += 1;
          }

          setMemorySpanAttributes(span, {
            candidatesProposed: candidates.length,
            candidatesAcceptedByPolicyScreen: acceptedByPolicyScreenCount,
          });

          return finish(
            {
              status: "completed",
              insertedCount,
              skippedCount,
            },
            "success",
          );
        } catch (error) {
          reportMemoryExtractionDuration({
            scopeType: "user",
            outcome: "error",
            durationSeconds: getDurationSeconds(extractionStartMs),
          });
          throw error;
        }
      },
      {
        scopeType: "user",
        scopeId: params.userId,
      },
    );
  }

  private async resolveModelConfig(params: {
    organizationId: string;
  }): Promise<ResolvedExtractorModel | null> {
    const override = await this.resolveModelSource({
      source: "override",
      organizationId: params.organizationId,
      modelName: config.memory.extractorModelOverride,
      provider: undefined,
      chatApiKeyId: config.memory.extractorApiKeyIdOverride,
    });
    if (override) {
      return override;
    }

    const organization = await OrganizationModel.getById(params.organizationId);
    const organizationDefault = await this.resolveModelSource({
      source: "organization_default",
      organizationId: params.organizationId,
      modelName: organization?.defaultLlmModel ?? undefined,
      provider: organization?.defaultLlmProvider ?? undefined,
      chatApiKeyId: organization?.defaultLlmApiKeyId ?? undefined,
    });
    if (organizationDefault) {
      return organizationDefault;
    }

    return await this.resolveModelSource({
      source: "fallback",
      organizationId: params.organizationId,
      modelName: config.memory.extractorFallbackModel,
      provider: undefined,
      chatApiKeyId: config.memory.extractorFallbackApiKeyId,
    });
  }

  private async resolveModelSource(params: {
    source: ExtractorModelSource;
    organizationId: string;
    modelName: string | undefined;
    provider: SupportedProvider | undefined;
    chatApiKeyId: string | undefined;
  }): Promise<ResolvedExtractorModel | null> {
    if (!params.modelName) {
      return null;
    }

    const provider =
      params.provider ??
      (detectProviderFromModel(params.modelName) as SupportedProvider);

    if (params.chatApiKeyId) {
      const keyResolution = await resolveApiKeyFromChatApiKey(
        params.chatApiKeyId,
      );
      if (!keyResolution) {
        return null;
      }

      return {
        source: params.source,
        modelName: params.modelName,
        provider: keyResolution.provider,
        apiKey: keyResolution.apiKey,
        baseUrl: keyResolution.baseUrl,
      };
    }

    return {
      source: params.source,
      modelName: params.modelName,
      provider,
      apiKey: getProviderEnvApiKey(provider),
      baseUrl: null,
    };
  }
}

export const memoryExtractor = new MemoryExtractor();

export function hasExternalContextBoundary(messages: ChatMessage[]): boolean {
  for (const message of messages) {
    if (!message.parts?.length) {
      continue;
    }

    for (const part of message.parts) {
      if (containsUnsafeContextBoundary(part)) {
        return true;
      }
    }
  }

  return false;
}

export const __test = {
  buildTranscript,
  collectSourceMessageIds,
  containsUnsafeContextBoundary,
  prepareCandidate,
};

// ===== Internal helpers =====

const EXTRACTOR_PROMPT_VERSION = "v1.0.0";
const MAX_TRANSCRIPT_CHARS = 20_000;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ExtractorModelSource = "override" | "organization_default" | "fallback";

type ResolvedExtractorModel = {
  source: ExtractorModelSource;
  modelName: string;
  provider: SupportedProvider;
  apiKey: string | undefined;
  baseUrl: string | null;
};

function asChatMessages(messages: unknown[]): ChatMessage[] {
  return messages as ChatMessage[];
}

function buildTranscript(messages: ChatMessage[]): string {
  const parts: string[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const text = extractTextFromMessage(message);
    if (!text) {
      continue;
    }

    parts.push(`${message.role}: ${text}`);
  }

  if (parts.length === 0) {
    return "";
  }

  const transcript = parts.join("\n");
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) {
    return transcript;
  }

  // Keep the newest turns, because recency is more relevant for memory extraction.
  return transcript.slice(-MAX_TRANSCRIPT_CHARS);
}

function extractTextFromMessage(message: ChatMessage): string {
  if (!message.parts?.length) {
    return "";
  }

  const textParts = message.parts
    .map((part) => {
      if (part.type !== "text" || typeof part.text !== "string") {
        return "";
      }
      return part.text.trim();
    })
    .filter(Boolean);

  return textParts.join("\n");
}

function buildExtractionPrompt(params: {
  transcript: string;
  maxCandidates: number;
}): string {
  return [
    "Extract durable memory candidates from the conversation transcript.",
    "Return only long-lived user-specific facts, preferences, or instructions.",
    "Do not include temporary tasks, one-off requests, or tool output details.",
    `Return at most ${params.maxCandidates} candidates.`,
    "Always set scopeType to 'user'.",
    "",
    "Conversation transcript:",
    params.transcript,
  ].join("\n");
}

function prepareCandidate(candidate: MemoryCandidate): MemoryCandidate | null {
  if (candidate.scopeType !== "user") {
    return null;
  }

  const content = candidate.content.trim();
  if (!content) {
    return null;
  }

  const parsed = ExtractorOutputSchema.shape.candidates.element.safeParse({
    ...candidate,
    content,
  });

  return parsed.success ? parsed.data : null;
}

function collectSourceMessageIds(messages: ChatMessage[]): string[] {
  return messages
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => message.id)
    .filter(
      (id): id is string => typeof id === "string" && UUID_REGEX.test(id),
    );
}

function containsUnsafeContextBoundary(value: unknown): boolean {
  const visited = new Set<object>();
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (visited.has(current)) {
      continue;
    }

    visited.add(current);
    const currentRecord = current as Record<string, unknown>;

    if (isUnsafeBoundary(currentRecord.unsafeContextBoundary)) {
      return true;
    }

    for (const nested of Object.values(currentRecord)) {
      if (nested && typeof nested === "object") {
        stack.push(nested);
      }
    }
  }

  return false;
}

function isUnsafeBoundary(value: unknown): boolean {
  return UnsafeContextBoundarySchema.safeParse(value).success;
}

function inferExtractionUnavailableReason(
  error: unknown,
): MemoryExtractionUnavailableReason {
  if (!(error instanceof Error)) {
    return "missing_model";
  }

  const message = error.message.toLowerCase();
  if (message.includes("api key")) {
    return "missing_api_key";
  }

  return "missing_model";
}

function getDurationSeconds(startedAtMs: number): number {
  return Math.max(0, (Date.now() - startedAtMs) / 1000);
}
