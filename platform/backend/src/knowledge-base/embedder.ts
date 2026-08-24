import { addNomicTaskPrefix, EMBEDDING_BATCH_SIZE } from "@archestra/shared";
import logger from "@/logging";
import { KbDocumentModel } from "@/models";
import {
  callEmbedding,
  type EmbeddingApiResponse,
  type EmbeddingInput,
  getEmbeddingDiscriminator,
  getEmbeddingRetryDelayMs,
  isRetryableEmbeddingError,
  PartialEmbeddingError,
} from "./embedding-clients";
import { normalizeEmbeddingError, toKnowledgeBaseUserMessage } from "./errors";
import {
  buildEmbeddingInteraction,
  withKbObservability,
} from "./kb-interaction";
import {
  type EmbeddingConfig,
  getDefaultOrgEmbeddingConfig,
} from "./kb-llm-client";
import { parseImageDataUrl } from "./media-chunk";
import { knowledgeRetrievalBackend } from "./retrieval-backends/registry";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

/**
 * The outcome of an embedding batch, reported to the connector run so a failure's
 * cause is visible (not just server logs). `errorMessage` carries the same typed,
 * user-facing message the query path surfaces. `skippedImageChunkCount` counts
 * image chunks the configured embedding model can't take, which are skipped
 * (documents complete without them) rather than sent to a certain rejection.
 */
interface EmbeddingBatchOutcome {
  failedDocumentCount: number;
  errorMessage: string | null;
  skippedImageChunkCount: number;
}

class EmbeddingService {
  async processDocument(
    documentId: string,
    ctx: EmbeddingConfig,
  ): Promise<void> {
    const document = await KbDocumentModel.findById(documentId);
    if (!document) {
      logger.warn({ documentId }, "[Embedder] Document not found");
      return;
    }

    if (document.embeddingStatus !== "pending") {
      logger.debug(
        { documentId, status: document.embeddingStatus },
        "[Embedder] Document not pending, skipping",
      );
      return;
    }

    await KbDocumentModel.update(documentId, { embeddingStatus: "processing" });

    try {
      const chunks =
        await knowledgeRetrievalBackend.getDocumentChunks(documentId);

      if (chunks.length === 0) {
        await KbDocumentModel.update(documentId, {
          embeddingStatus: "failed",
          chunkCount: 0,
        });
        logger.warn(
          { documentId, title: document.title },
          "[Embedder] Document produced no chunks and cannot be retrieved",
        );
        return;
      }

      const { embeddable, skippedImageChunkCount } = partitionEmbeddableChunks(
        chunks,
        ctx,
      );
      if (skippedImageChunkCount > 0) {
        logger.warn(
          {
            documentId,
            skippedImageChunkCount,
            provider: ctx.provider,
            model: ctx.model,
          },
          "[Embedder] Skipped image chunks the configured embedding model can't embed",
        );
      }

      const allUpdates: Array<{ chunkId: string; embedding: number[] }> = [];

      for (let i = 0; i < embeddable.length; i += EMBEDDING_BATCH_SIZE) {
        const batch = embeddable.slice(i, i + EMBEDDING_BATCH_SIZE);
        const inputs = batch.map((c) =>
          chunkToEmbeddingInput({
            model: ctx.model,
            content: c.content,
            metadataSuffix: c.metadataSuffixSemantic,
            contextualHeader: c.contextualHeader,
          }),
        );

        const response = await this.callEmbeddingApiWithRetry({
          ctx,
          inputs,
          connectorId: document.connectorId,
        });

        if (response.data.length !== batch.length) {
          throw new Error(
            `Embedding API returned ${response.data.length} results for ${batch.length} inputs`,
          );
        }

        for (let j = 0; j < batch.length; j++) {
          allUpdates.push({
            chunkId: batch[j].id,
            embedding: response.data[j].embedding,
          });
        }
      }

      await knowledgeRetrievalBackend.indexEmbeddings({
        updates: allUpdates,
        dimensions: ctx.dimensions,
      });

      await KbDocumentModel.update(documentId, {
        embeddingStatus: "completed",
        chunkCount: chunks.length,
      });

      logger.info(
        { documentId, chunkCount: chunks.length },
        "[Embedder] Document embeddings completed",
      );
    } catch (error) {
      await KbDocumentModel.update(documentId, {
        embeddingStatus: "failed",
      });
      logger.error(
        {
          documentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "[Embedder] Failed to embed document",
      );
    }
  }

  /**
   * Embed multiple documents in a single pass, batching chunks across documents
   * into groups of EMBEDDING_BATCH_SIZE for fewer API calls.
   * Per-document error isolation: if embedding fails, only the affected documents
   * are marked as "failed"; the rest still complete.
   */
  async processDocuments(
    documentIds: string[],
    connectorRunId?: string,
  ): Promise<EmbeddingBatchOutcome> {
    // 1. Load all documents in one query, filter to pending, gather chunks
    const documents = await KbDocumentModel.findByIds(documentIds);
    const documentsById = new Map(documents.map((d) => [d.id, d]));

    const docChunkMap: Array<{
      documentId: string;
      chunkIds: string[];
      chunkCount: number;
    }> = [];
    const zeroChunkDocuments: Array<{ documentId: string; title: string }> = [];
    // Store raw chunk data; inputs are built after the embedding config is resolved.
    const allChunks: Array<{
      chunkId: string;
      content: string;
      metadataSuffix: string | null;
      contextualHeader: string | null;
      connectorId: string;
    }> = [];

    for (const documentId of documentIds) {
      const document = documentsById.get(documentId);
      if (!document) {
        logger.warn(
          { documentId, runId: connectorRunId },
          "[Embedder] Document not found",
        );
        continue;
      }
      if (document.embeddingStatus !== "pending") {
        logger.debug(
          {
            documentId,
            runId: connectorRunId,
            status: document.embeddingStatus,
          },
          "[Embedder] Document not pending, skipping",
        );
        continue;
      }

      await KbDocumentModel.update(documentId, {
        embeddingStatus: "processing",
      });

      const chunks =
        await knowledgeRetrievalBackend.getDocumentChunks(documentId);

      if (chunks.length === 0) {
        await KbDocumentModel.update(documentId, {
          embeddingStatus: "failed",
          chunkCount: 0,
        });
        zeroChunkDocuments.push({
          documentId,
          title: document.title,
        });
        logger.warn(
          { documentId, runId: connectorRunId, title: document.title },
          "[Embedder] Document produced no chunks and cannot be retrieved",
        );
        continue;
      }

      const chunkIds = chunks.map((c) => c.id);
      docChunkMap.push({ documentId, chunkIds, chunkCount: chunks.length });

      for (const chunk of chunks) {
        allChunks.push({
          chunkId: chunk.id,
          content: chunk.content,
          metadataSuffix: chunk.metadataSuffixSemantic,
          contextualHeader: chunk.contextualHeader,
          connectorId: document.connectorId,
        });
      }
    }

    const zeroChunkError = describeZeroChunkDocuments(zeroChunkDocuments);

    if (allChunks.length === 0) {
      return {
        failedDocumentCount: zeroChunkDocuments.length,
        errorMessage: zeroChunkError,
        skippedImageChunkCount: 0,
      };
    }

    // 2. Get embedding config
    let orgConfig: Awaited<ReturnType<typeof getDefaultOrgEmbeddingConfig>>;
    try {
      orgConfig = await getDefaultOrgEmbeddingConfig();
    } catch (error) {
      // Configured but unresolvable (e.g. an undecryptable credential) is a real,
      // diagnosable fault — fail the documents and surface the cause on the run,
      // rather than crashing the task (which would retry a config retry can't fix).
      const message = embeddingFailureMessage(error);
      logger.error(
        { runId: connectorRunId, error: message },
        "[Embedder] Embedding configuration could not be resolved",
      );
      for (const { documentId } of docChunkMap) {
        await KbDocumentModel.update(documentId, { embeddingStatus: "failed" });
      }
      return {
        failedDocumentCount: docChunkMap.length + zeroChunkDocuments.length,
        errorMessage: combineEmbeddingErrors(zeroChunkError, message),
        skippedImageChunkCount: 0,
      };
    }
    if (!orgConfig) {
      // Not configured (vs unresolvable): defer, keep the documents pending so a
      // later run embeds them once an embedding model is set.
      logger.debug(
        { runId: connectorRunId },
        "[Embedder] No embedding API key configured, skipping",
      );
      for (const { documentId } of docChunkMap) {
        await KbDocumentModel.update(documentId, {
          embeddingStatus: "pending",
        });
      }
      return {
        failedDocumentCount: zeroChunkDocuments.length,
        errorMessage: zeroChunkError,
        skippedImageChunkCount: 0,
      };
    }

    const ctx = orgConfig.config;

    // Image chunks the configured embedding model can't take (already-ingested
    // media after a model switch, or a mid-sync config change) are skipped, not
    // sent to a certain rejection: their documents complete with the remaining
    // chunks — a media document simply embeds none — instead of sticking in
    // "failed" with a cause only visible in server logs. The count is surfaced
    // on the connector run.
    const { embeddable, skippedImageChunkCount } = partitionEmbeddableChunks(
      allChunks,
      ctx,
    );
    if (skippedImageChunkCount > 0) {
      logger.warn(
        {
          runId: connectorRunId,
          skippedImageChunkCount,
          provider: ctx.provider,
          model: ctx.model,
        },
        "[Embedder] Skipped image chunks the configured embedding model can't embed",
      );
    }

    const embeddingResults = new Map<string, number[]>();
    const failedChunkIds = new Set<string>();
    let firstErrorMessage: string | null = null;

    for (let i = 0; i < embeddable.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = embeddable.slice(i, i + EMBEDDING_BATCH_SIZE);
      try {
        const inputs = batch.map((c) =>
          chunkToEmbeddingInput({
            model: ctx.model,
            content: c.content,
            metadataSuffix: c.metadataSuffix,
            contextualHeader: c.contextualHeader,
          }),
        );
        const response = await this.callEmbeddingApiWithRetry({
          ctx,
          inputs,
          connectorId: singleConnectorId(batch),
        });
        if (response.data.length !== batch.length) {
          throw new Error(
            `Embedding API returned ${response.data.length} results for ${batch.length} inputs`,
          );
        }
        for (let j = 0; j < batch.length; j++) {
          embeddingResults.set(batch[j].chunkId, response.data[j].embedding);
        }
      } catch (error) {
        const message = embeddingFailureMessage(error, {
          provider: ctx.provider,
          model: ctx.model,
        });
        firstErrorMessage ??= message;
        logger.error(
          {
            runId: connectorRunId,
            batchStart: i,
            batchSize: batch.length,
            error: message,
          },
          "[Embedder] Batch embedding API call failed",
        );
        if (error instanceof PartialEmbeddingError) {
          for (const success of error.successes) {
            const chunk = batch[success.index];
            if (chunk) {
              embeddingResults.set(chunk.chunkId, success.embedding);
            }
          }
          for (const failure of error.failures) {
            const chunk = batch[failure.index];
            if (chunk) {
              failedChunkIds.add(chunk.chunkId);
            }
          }
        } else {
          for (const chunk of batch) {
            failedChunkIds.add(chunk.chunkId);
          }
        }
      }
    }

    // 3. Write embeddings and update document statuses
    const successfulUpdates = [...embeddingResults.entries()].map(
      ([chunkId, embedding]) => ({ chunkId, embedding }),
    );
    if (successfulUpdates.length > 0) {
      try {
        await knowledgeRetrievalBackend.indexEmbeddings({
          updates: successfulUpdates,
          dimensions: ctx.dimensions,
        });
      } catch (error) {
        // Persistence failed (e.g. a pgvector dimension error on write). Fail the
        // affected documents and surface the cause rather than crashing.
        firstErrorMessage ??= embeddingFailureMessage(error, {
          provider: ctx.provider,
          model: ctx.model,
        });
        logger.error(
          { runId: connectorRunId, error: firstErrorMessage },
          "[Embedder] Failed to persist embeddings",
        );
        for (const { chunkId } of successfulUpdates) {
          failedChunkIds.add(chunkId);
        }
      }
    }

    let failedDocumentCount = 0;
    for (const { documentId, chunkIds, chunkCount } of docChunkMap) {
      const anyFailed = chunkIds.some((id) => failedChunkIds.has(id));
      if (anyFailed) {
        failedDocumentCount++;
        await KbDocumentModel.update(documentId, {
          embeddingStatus: "failed",
        });
        logger.error(
          { documentId, runId: connectorRunId },
          "[Embedder] Failed to embed document (batch failure)",
        );
      } else {
        await KbDocumentModel.update(documentId, {
          embeddingStatus: "completed",
          chunkCount,
        });
        logger.info(
          { documentId, runId: connectorRunId, chunkCount },
          "[Embedder] Document embeddings completed",
        );
      }
    }

    return {
      failedDocumentCount: failedDocumentCount + zeroChunkDocuments.length,
      errorMessage: combineEmbeddingErrors(
        zeroChunkError,
        failedDocumentCount > 0 ? firstErrorMessage : null,
      ),
      skippedImageChunkCount,
    };
  }

  private async callEmbeddingApiWithRetry(params: {
    ctx: EmbeddingConfig;
    inputs: EmbeddingInput[];
    connectorId: string | null;
  }): Promise<EmbeddingApiResponse> {
    const { ctx, inputs, connectorId } = params;
    let pending = inputs.map((input, index) => ({ input, index }));
    const successes = new Map<number, number[]>();
    const terminalFailures: Array<{ index: number; reason: unknown }> = [];
    let promptTokens = 0;

    const callObserved = (attemptInputs: EmbeddingInput[]) =>
      withKbObservability({
        operationName: "embedding",
        provider: ctx.provider,
        model: ctx.model,
        source: "knowledge:embedding",
        connectorId,
        type: getEmbeddingDiscriminator(ctx.provider),
        callback: () =>
          callEmbedding({
            inputs: attemptInputs,
            model: ctx.model,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            dimensions: ctx.dimensions,
            provider: ctx.provider,
          }),
        buildInteraction: (resp) =>
          buildEmbeddingInteraction({
            model: ctx.model,
            input: attemptInputs.map(embeddingInputLogValue),
            dimensions: ctx.dimensions,
            response: resp,
          }),
        buildInteractionOnError: (error) => {
          if (
            !(error instanceof PartialEmbeddingError) ||
            error.successes.length === 0
          ) {
            return null;
          }
          return buildEmbeddingInteraction({
            model: ctx.model,
            input: error.successes
              .map((success) => attemptInputs[success.index])
              .filter((input): input is EmbeddingInput => input !== undefined)
              .map(embeddingInputLogValue),
            dimensions: ctx.dimensions,
            response: {
              object: "list",
              data: error.successes.map((success, index) => ({
                object: "embedding",
                embedding: success.embedding,
                index,
              })),
              model: ctx.model,
              usage: {
                prompt_tokens: error.tokens,
                total_tokens: error.tokens,
              },
            },
          });
        },
      });

    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      let response: EmbeddingApiResponse;
      try {
        response = await callObserved(pending.map(({ input }) => input));
      } catch (error) {
        let retryReason: unknown = error;
        if (error instanceof PartialEmbeddingError) {
          promptTokens += error.tokens;
          for (const success of error.successes) {
            const original = pending[success.index];
            if (original) {
              successes.set(original.index, success.embedding);
            }
          }

          const retryable: typeof pending = [];
          for (const failure of error.failures) {
            const original = pending[failure.index];
            if (!original) continue;
            if (isRetryableEmbeddingError(failure.reason)) {
              retryable.push(original);
              retryReason = failure.reason;
            } else {
              terminalFailures.push({
                index: original.index,
                reason: failure.reason,
              });
            }
          }
          pending = retryable;
        }

        const isLastAttempt = attempt === RETRY_MAX_ATTEMPTS;
        const canRetry =
          !isLastAttempt &&
          (error instanceof PartialEmbeddingError
            ? pending.length > 0
            : isRetryableEmbeddingError(error));
        if (!canRetry) {
          if (
            error instanceof PartialEmbeddingError ||
            successes.size > 0 ||
            terminalFailures.length > 0
          ) {
            if (!(error instanceof PartialEmbeddingError)) {
              terminalFailures.push(
                ...pending.map(({ index }) => ({ index, reason: error })),
              );
            } else {
              terminalFailures.push(
                ...pending.map(({ index }) => ({
                  index,
                  reason: retryReason,
                })),
              );
            }
            throw aggregatePartialEmbeddingError({
              successes,
              failures: terminalFailures,
              tokens: promptTokens,
            });
          }
          throw error;
        }

        const delayMs = getEmbeddingRetryDelayMs(
          retryReason,
          RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        );
        logger.warn(
          {
            attempt,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          },
          "[Embedder] Retryable embedding error, backing off",
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      promptTokens += response.usage.prompt_tokens;
      for (const result of response.data) {
        const original = pending[result.index];
        if (original) {
          successes.set(original.index, result.embedding);
        }
      }
      pending = [];

      if (terminalFailures.length > 0) {
        throw aggregatePartialEmbeddingError({
          successes,
          failures: terminalFailures,
          tokens: promptTokens,
        });
      }

      return {
        ...response,
        data: [...successes.entries()]
          .sort(([a], [b]) => a - b)
          .map(([index, embedding]) => ({
            object: "embedding" as const,
            embedding,
            index,
          })),
        usage: {
          prompt_tokens: promptTokens,
          total_tokens: promptTokens,
        },
      };
    }

    // Unreachable, but satisfies TypeScript
    throw new Error("Retry loop exited unexpectedly");
  }
}

export const embeddingService = new EmbeddingService();

// ===== Internal helpers =====

function describeZeroChunkDocuments(
  documents: Array<{ documentId: string; title: string }>,
): string | null {
  if (documents.length === 0) return null;

  const names = documents
    .map((document) => `"${document.title}" (${document.documentId})`)
    .join(", ");
  return `${documents.length} document${documents.length === 1 ? "" : "s"} produced no chunks and cannot be retrieved: ${names}`;
}

function combineEmbeddingErrors(
  first: string | null,
  second: string | null,
): string | null {
  if (first && second) return `${first}; ${second}`;
  return first ?? second;
}

function embeddingInputLogValue(input: EmbeddingInput): string {
  return typeof input === "string" ? input : `[image:${input.mimeType}]`;
}

function aggregatePartialEmbeddingError(params: {
  successes: Map<number, number[]>;
  failures: Array<{ index: number; reason: unknown }>;
  tokens: number;
}): PartialEmbeddingError {
  // Reasons are already the clients' typed errors (or raw network errors) —
  // kept as-is so the caller sees the original cause.
  return new PartialEmbeddingError({
    successes: [...params.successes.entries()].map(([index, embedding]) => ({
      index,
      embedding,
    })),
    failures: params.failures,
    tokens: params.tokens,
  });
}

/**
 * A cause-specific, user-facing message for an embedding failure. When the
 * embedding context (provider/model) is known, a raw provider/network error is
 * first normalized into the typed taxonomy — the same messages the query path
 * surfaces — so connector runs never expose opaque SDK/SQL text.
 */
function embeddingFailureMessage(
  error: unknown,
  ctx?: { provider: string; model: string },
): string {
  const normalized = ctx ? normalizeEmbeddingError(error, ctx) : error;
  return (
    toKnowledgeBaseUserMessage(normalized) ??
    (error instanceof Error ? error.message : String(error))
  );
}

/**
 * The connector every chunk in the batch belongs to, or null when they span
 * several — a batch is grouped by size, not by connector, so the recovery sweep
 * can mix them.
 */
function singleConnectorId(
  batch: Array<{ connectorId: string }>,
): string | null {
  const first = batch[0]?.connectorId ?? null;
  return batch.every((c) => c.connectorId === first) ? first : null;
}

/**
 * Convert a raw chunk content string to an EmbeddingInput.
 * Image data URLs (`data:image/...;base64,...`) are returned as inline image objects;
 * all other content is returned as text with the appropriate nomic task prefix.
 *
 * The embedded text is the chunk sandwiched between its contextual header
 * (document-level context, when contextual retrieval is on) and its metadata
 * suffix. Only the chunk's own `content` is returned to the model at query
 * time; the header and suffix exist purely to make the vector easier to hit.
 */
function chunkToEmbeddingInput(params: {
  model: string;
  content: string;
  metadataSuffix: string | null | undefined;
  contextualHeader: string | null | undefined;
}): EmbeddingInput {
  const { model, content, metadataSuffix, contextualHeader } = params;

  const image = parseImageDataUrl(content);
  if (image) {
    return image;
  }
  return addNomicTaskPrefix(
    model,
    (contextualHeader ?? "") + content + (metadataSuffix ?? ""),
    "search_document",
  );
}

/**
 * Split chunks into ones the configured embedding model can embed and image
 * chunks it can't: `inputModalities` excludes "image" (including `null`, which
 * means the model's capabilities are unknown and image support can't be
 * assumed), or the image's format is outside the model's accepted MIME types
 * (Bedrock's multimodal models take JPEG/PNG only). Connectors gate NEW image
 * ingestion on the same resolved capability, so this catches what ingested
 * earlier under a different configuration.
 */
function partitionEmbeddableChunks<T extends { content: string }>(
  chunks: T[],
  ctx: EmbeddingConfig,
): { embeddable: T[]; skippedImageChunkCount: number } {
  const imageAllowed = ctx.inputModalities?.includes("image") ?? false;
  const acceptedMimeTypes = ctx.acceptedImageMimeTypes;
  if (imageAllowed && acceptedMimeTypes === null) {
    return { embeddable: chunks, skippedImageChunkCount: 0 };
  }
  const embeddable = chunks.filter((chunk) => {
    const image = parseImageDataUrl(chunk.content);
    if (image === null) {
      return true;
    }
    if (!imageAllowed) {
      return false;
    }
    return (
      acceptedMimeTypes === null ||
      acceptedMimeTypes.includes(normalizeImageMimeType(image.mimeType))
    );
  });
  return {
    embeddable,
    skippedImageChunkCount: chunks.length - embeddable.length,
  };
}

/**
 * Canonicalize an image MIME type for capability checks: lowercase, with the
 * common non-standard "image/jpg" spelling mapped to "image/jpeg".
 */
function normalizeImageMimeType(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  return lower === "image/jpg" ? "image/jpeg" : lower;
}
