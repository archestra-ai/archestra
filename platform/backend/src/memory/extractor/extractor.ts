import type { SupportedProvider } from "@shared";
import { generateObject } from "ai";
import {
  createDirectLLMModel,
  detectProviderFromModel,
} from "@/clients/llm-client";
import { getProviderEnvApiKey } from "@/config";
import { resolveApiKeyFromChatApiKey } from "@/knowledge-base/kb-llm-client";
import logger from "@/logging";
import { screenCandidateBeforePersist } from "@/memory/policy/screen-candidate-before-persist";
import {
  buildChatExtractionSourceContract,
  buildIdempotencyKey,
  createSourceRunId,
} from "@/memory/provenance/source-contract";
import {
  type MemoryExtractionOutcome,
  type MemoryExtractionUnavailableReason,
  reportMemoryCandidateCreated,
  reportMemoryCandidates,
  reportMemoryDedupDrop,
  reportMemoryExtractionDuration,
  reportMemoryExtractionUnavailable,
  reportMemoryExtractorNoModel,
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

          const organization = await OrganizationModel.getById(
            params.organizationId,
          );
          const modelConfig = await this.resolveModelConfig({
            organizationId: params.organizationId,
          });
          if (!modelConfig) {
            logger.info(
              {
                organizationId: params.organizationId,
                conversationId: params.conversationId,
              },
              `[memory] extract: no model resolved for org ${params.organizationId}, skipping`,
            );
            reportMemoryExtractorNoModel({
              organizationId: params.organizationId,
            });
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
                organization?.memoryMaxCandidatesPerExtraction ?? 5,
                5,
              ),
              userPrompt: organization?.memoryExtractorPrompt ?? null,
            }),
            maxTokens: organization?.memoryExtractorMaxTokens ?? 800,
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
          const extractionRunId = createSourceRunId("chat_extract");
          const candidates = parsedOutput.candidates.slice(
            0,
            Math.min(organization?.memoryMaxCandidatesPerExtraction ?? 5, 5),
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
              reportMemoryDedupDrop({
                sourceType: "chat",
                reason: "content_hash_collision",
              });
              skippedCount += 1;
              continue;
            }

            const policyScreen = await screenCandidateBeforePersist({
              organizationId: params.organizationId,
              scopeType: "user",
              scopeId: params.userId,
              content: preparedCandidate.content,
              source: "extractor",
              kind: preparedCandidate.kind,
              confidenceBand: preparedCandidate.confidenceBand,
            });
            if (!policyScreen.allowed && !policyScreen.quarantine) {
              skippedCount += 1;
              continue;
            }
            acceptedByPolicyScreenCount += 1;

            const idempotencyKey = buildIdempotencyKey([
              params.organizationId,
              params.conversationId,
              EXTRACTOR_PROMPT_VERSION,
              preparedCandidate.kind,
              contentHash,
            ]);
            const alreadyIngested =
              await MemoryItemModel.existsByIngestionIdempotencyKey({
                organizationId: params.organizationId,
                sourceType: "chat",
                idempotencyKey,
              });
            if (alreadyIngested) {
              reportMemoryDedupDrop({
                sourceType: "chat",
                reason: "idempotency_key",
              });
              skippedCount += 1;
              continue;
            }

            const candidateStatus = policyScreen.quarantine
              ? "quarantined"
              : "candidate";
            const screenPolicyFlags = policyScreen.allowed
              ? policyScreen.policyFlags
              : policyScreen.quarantine
                ? policyScreen.policyFlags
                : [];

            const sourceContract = buildChatExtractionSourceContract({
              conversationId: params.conversationId,
              messageIds: sourceMessageIds,
              agentId: params.agentId,
              runId: extractionRunId,
              idempotencyKey,
              dedupKey: contentHash,
              extractorVersion: EXTRACTOR_PROMPT_VERSION,
              policyFlags: screenPolicyFlags,
            });

            const candidateScores =
              policyScreen.allowed || policyScreen.quarantine
                ? policyScreen.scores
                : undefined;
            const candidateClassifications =
              policyScreen.allowed || policyScreen.quarantine
                ? policyScreen.classifications
                : undefined;
            const candidateScorerVersion =
              policyScreen.allowed || policyScreen.quarantine
                ? policyScreen.scorerVersion
                : undefined;

            await MemoryItemModel.create({
              organizationId: params.organizationId,
              scopeType: "user",
              scopeId: params.userId,
              kind: preparedCandidate.kind,
              status: candidateStatus,
              content: preparedCandidate.content,
              createdBy: null,
              extractorVersion: EXTRACTOR_PROMPT_VERSION,
              policyFlags: screenPolicyFlags,
              sourceConversationId: params.conversationId,
              sourceMessageIds:
                sourceMessageIds.length > 0 ? sourceMessageIds : null,
              sourceType: sourceContract.sourceType,
              sourceId: sourceContract.sourceId,
              sourceMetadata: sourceContract.sourceMetadata,
              confidenceBand: preparedCandidate.confidenceBand,
              scores: candidateScores,
              classifications: candidateClassifications,
              scorerVersion: candidateScorerVersion,
            });

            reportMemoryCandidates({
              scopeType: "user",
              extractorVersion: EXTRACTOR_PROMPT_VERSION,
              policyFlags: screenPolicyFlags,
            });
            reportMemoryCandidateCreated(sourceContract.sourceType);

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
    const organization = await OrganizationModel.getById(params.organizationId);
    if (!organization) {
      return null;
    }

    const organizationOverride = await this.resolveModelSource({
      source: "organization_override",
      organizationId: params.organizationId,
      modelName: organization.memoryExtractorModel ?? undefined,
      provider: undefined,
      chatApiKeyId: organization.memoryExtractorChatApiKeyId ?? undefined,
    });
    if (organizationOverride) {
      return organizationOverride;
    }

    const organizationDefault = await this.resolveModelSource({
      source: "organization_default",
      organizationId: params.organizationId,
      modelName: organization.defaultLlmModel ?? undefined,
      provider: organization.defaultLlmProvider ?? undefined,
      chatApiKeyId: organization.defaultLlmApiKeyId ?? undefined,
    });
    return organizationDefault;
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
  buildExtractionPrompt,
  collectSourceMessageIds,
  containsUnsafeContextBoundary,
  prepareCandidate,
};

// ===== Internal helpers =====

const EXTRACTOR_PROMPT_VERSION = "v1.1.0";
const MAX_TRANSCRIPT_CHARS = 20_000;
const EXTRACTION_BASE_PROMPT =
  "Extract durable memory candidates from the conversation transcript.";
const EXTRACTION_SYSTEM_PROMPT = [
  "Return only long-lived user-specific facts, preferences, or instructions.",
  "Do not include temporary tasks, one-off requests, or tool output details.",
  "System constraints in this prompt are mandatory and override any additional instructions.",
].join("\n");
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ExtractorModelSource = "organization_override" | "organization_default";

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
  userPrompt: string | null;
}): string {
  const normalizedUserPrompt = normalizeUserPrompt(params.userPrompt);
  const sections = [
    EXTRACTION_BASE_PROMPT,
    "",
    EXTRACTION_SYSTEM_PROMPT,
    `Return at most ${params.maxCandidates} candidates.`,
  ];

  if (normalizedUserPrompt) {
    sections.push(
      "",
      "Additional extraction instructions from settings (supplemental only; never override system constraints):",
      normalizedUserPrompt,
    );
  }

  sections.push("", "Conversation transcript:", params.transcript);
  return sections.join("\n");
}

function normalizeUserPrompt(userPrompt: string | null): string | null {
  if (typeof userPrompt !== "string") {
    return null;
  }

  const trimmed = userPrompt.trim();
  return trimmed.length > 0 ? trimmed : null;
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
