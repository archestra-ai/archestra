import { addNomicTaskPrefix, EMBEDDING_BATCH_SIZE } from "@archestra/shared";
import logger from "@/logging";
import { KbChunkModel, KbDocumentModel } from "@/models";
import type { EmbeddingError } from "@/types";
import {
  AzureEmbeddingError,
  callEmbedding,
  type EmbeddingApiResponse,
  type EmbeddingInput,
  GeminiEmbeddingError,
  getEmbeddingDiscriminator,
  getEmbeddingRetryDelayMs,
  isRetryableEmbeddingError,
  OpenAIEmbeddingError,
} from "./embedding-clients";
import {
  buildEmbeddingInteraction,
  withKbObservability,
} from "./kb-interaction";
import {
  type EmbeddingConfig,
  getDefaultOrgEmbeddingConfig,
} from "./kb-llm-client";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

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
      const chunks = await KbChunkModel.findByDocument(documentId);

      if (chunks.length === 0) {
        await KbDocumentModel.update(documentId, {
          embeddingStatus: "completed",
          embeddingError: null,
          chunkCount: 0,
        });
        return;
      }

      const allUpdates: Array<{ chunkId: string; embedding: number[] }> = [];

      for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
        const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
        const inputs = batch.map((c) =>
          chunkToEmbeddingInput(ctx.model, c.content, c.metadataSuffixSemantic),
        );

        const response = await this.callEmbeddingApiWithRetry(ctx, inputs);

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

      await KbChunkModel.updateEmbeddings(allUpdates, ctx.dimensions);

      await KbDocumentModel.update(documentId, {
        embeddingStatus: "completed",
        embeddingError: null,
        chunkCount: chunks.length,
      });

      logger.info(
        { documentId, chunkCount: chunks.length },
        "[Embedder] Document embeddings completed",
      );
    } catch (error) {
      const embeddingError = classifyEmbeddingError(error);
      await KbDocumentModel.update(documentId, {
        embeddingStatus: "failed",
        embeddingError,
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
  ): Promise<void> {
    // 1. Load all documents in one query, filter to pending, gather chunks
    const documents = await KbDocumentModel.findByIds(documentIds);
    const documentsById = new Map(documents.map((d) => [d.id, d]));

    const docChunkMap: Array<{
      documentId: string;
      chunkIds: string[];
      chunkCount: number;
    }> = [];
    // Store raw chunk data; inputs are built after the embedding config is resolved.
    const allChunks: Array<{
      chunkId: string;
      content: string;
      metadataSuffix: string | null;
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

      const chunks = await KbChunkModel.findByDocument(documentId);

      if (chunks.length === 0) {
        await KbDocumentModel.update(documentId, {
          embeddingStatus: "completed",
          embeddingError: null,
          chunkCount: 0,
        });
        continue;
      }

      const chunkIds = chunks.map((c) => c.id);
      docChunkMap.push({ documentId, chunkIds, chunkCount: chunks.length });

      for (const chunk of chunks) {
        allChunks.push({
          chunkId: chunk.id,
          content: chunk.content,
          metadataSuffix: chunk.metadataSuffixSemantic,
        });
      }
    }

    if (allChunks.length === 0) return;

    // 2. Get embedding config
    const orgConfig = await getDefaultOrgEmbeddingConfig();
    if (!orgConfig) {
      logger.debug(
        { runId: connectorRunId },
        "[Embedder] No embedding API key configured, skipping",
      );
      for (const { documentId } of docChunkMap) {
        await KbDocumentModel.update(documentId, {
          embeddingStatus: "pending",
        });
      }
      return;
    }

    const ctx = orgConfig.config;
    const embeddingResults = new Map<string, number[]>();
    const failedChunkIds = new Set<string>();
    const chunkIdToError = new Map<string, unknown>();

    for (let i = 0; i < allChunks.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = allChunks.slice(i, i + EMBEDDING_BATCH_SIZE);
      try {
        const inputs = batch.map((c) =>
          chunkToEmbeddingInput(ctx.model, c.content, c.metadataSuffix),
        );
        const response = await this.callEmbeddingApiWithRetry(ctx, inputs);
        if (response.data.length !== batch.length) {
          throw new Error(
            `Embedding API returned ${response.data.length} results for ${batch.length} inputs`,
          );
        }
        for (let j = 0; j < batch.length; j++) {
          embeddingResults.set(batch[j].chunkId, response.data[j].embedding);
        }
      } catch (error) {
        logger.error(
          {
            runId: connectorRunId,
            batchStart: i,
            batchSize: batch.length,
            error: error instanceof Error ? error.message : String(error),
          },
          "[Embedder] Batch embedding API call failed",
        );
        for (const chunk of batch) {
          failedChunkIds.add(chunk.chunkId);
          chunkIdToError.set(chunk.chunkId, error);
        }
      }
    }

    // 3. Write embeddings and update document statuses
    const successfulUpdates = [...embeddingResults.entries()].map(
      ([chunkId, embedding]) => ({ chunkId, embedding }),
    );
    if (successfulUpdates.length > 0) {
      try {
        await KbChunkModel.updateEmbeddings(successfulUpdates, ctx.dimensions);
      } catch (error) {
        logger.error(
          {
            runId: connectorRunId,
            error: error instanceof Error ? error.message : String(error),
          },
          "[Embedder] Database update of embeddings failed",
        );
        for (const update of successfulUpdates) {
          failedChunkIds.add(update.chunkId);
          chunkIdToError.set(update.chunkId, error);
        }
      }
    }

    for (const { documentId, chunkIds, chunkCount } of docChunkMap) {
      const anyFailed = chunkIds.some((id) => failedChunkIds.has(id));
      if (anyFailed) {
        const failedChunkId = chunkIds.find((id) => failedChunkIds.has(id));
        const chunkError = failedChunkId
          ? chunkIdToError.get(failedChunkId)
          : undefined;
        const embeddingError = classifyEmbeddingError(
          chunkError ?? new Error("Batch failure"),
        );

        await KbDocumentModel.update(documentId, {
          embeddingStatus: "failed",
          embeddingError,
        });
        logger.error(
          { documentId, runId: connectorRunId },
          "[Embedder] Failed to embed document (batch failure)",
        );
      } else {
        await KbDocumentModel.update(documentId, {
          embeddingStatus: "completed",
          embeddingError: null,
          chunkCount,
        });
        logger.info(
          { documentId, runId: connectorRunId, chunkCount },
          "[Embedder] Document embeddings completed",
        );
      }
    }
  }

  private async callEmbeddingApiWithRetry(
    ctx: EmbeddingConfig,
    inputs: EmbeddingInput[],
  ): Promise<EmbeddingApiResponse> {
    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        return await withKbObservability({
          operationName: "embedding",
          provider: ctx.provider,
          model: ctx.model,
          source: "knowledge:embedding",
          type: getEmbeddingDiscriminator(ctx.provider),
          callback: () =>
            callEmbedding({
              inputs,
              model: ctx.model,
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
              dimensions: ctx.dimensions,
              provider: ctx.provider,
            }),
          buildInteraction: (resp) =>
            buildEmbeddingInteraction({
              model: ctx.model,
              input: inputs.map((i) =>
                typeof i === "string" ? i : `[image:${i.mimeType}]`,
              ),
              dimensions: ctx.dimensions,
              response: resp,
            }),
        });
      } catch (error) {
        const isLastAttempt = attempt === RETRY_MAX_ATTEMPTS;
        if (isLastAttempt || !isRetryableEmbeddingError(error)) {
          throw error;
        }

        const delayMs = getEmbeddingRetryDelayMs(
          error,
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
      }
    }

    // Unreachable, but satisfies TypeScript
    throw new Error("Retry loop exited unexpectedly");
  }
}

export const embeddingService = new EmbeddingService();

// ===== Internal helpers =====

/**
 * Convert a raw chunk content string to an EmbeddingInput.
 * Image data URLs (`data:image/...;base64,...`) are returned as inline image objects;
 * all other content is returned as text with the appropriate nomic task prefix.
 */
function chunkToEmbeddingInput(
  model: string,
  content: string,
  metadataSuffix: string | null | undefined,
): EmbeddingInput {
  if (content.startsWith("data:image/")) {
    // Parse the data URL: data:<mimeType>;base64,<data>
    const semicolonIdx = content.indexOf(";base64,");
    if (semicolonIdx > 5) {
      const mimeType = content.slice(5, semicolonIdx);
      const data = content.slice(semicolonIdx + 8); // len(";base64,") === 8
      return { mimeType, data };
    }
  }
  return addNomicTaskPrefix(
    model,
    content + (metadataSuffix ?? ""),
    "search_document",
  );
}

/**
 * Helper to classify embedding errors into structured enum categories.
 */
function classifyEmbeddingError(error: unknown): EmbeddingError {
  if (!error) return "unknown";

  const errMsg = error instanceof Error ? error.message : String(error);
  const errMsgLower = errMsg.toLowerCase();

  // 1. Check database/vector dimension mismatch errors first
  if (
    errMsgLower.includes("dimension") ||
    errMsgLower.includes("different vector") ||
    errMsgLower.includes("vector")
  ) {
    return "dimensions_mismatch";
  }

  // 2. Check specific embedding client errors
  if (
    error instanceof AzureEmbeddingError ||
    error instanceof GeminiEmbeddingError ||
    error instanceof OpenAIEmbeddingError
  ) {
    const status = error.status;
    if (status === 429) {
      return "rate_limit";
    }
    if (status === 401 || status === 403) {
      return "api_key";
    }
    if (status === 404) {
      return "model_not_found";
    }
    if (status >= 500) {
      return "provider_error";
    }
  }

  // 3. Fallback to message-based heuristic checks
  if (
    errMsgLower.includes("rate limit") ||
    errMsgLower.includes("too many requests") ||
    errMsgLower.includes("429")
  ) {
    return "rate_limit";
  }
  if (
    errMsgLower.includes("api key") ||
    errMsgLower.includes("api_key") ||
    errMsgLower.includes("unauthorized") ||
    errMsgLower.includes("forbidden") ||
    errMsgLower.includes("401") ||
    errMsgLower.includes("403")
  ) {
    return "api_key";
  }
  if (
    errMsgLower.includes("model not found") ||
    errMsgLower.includes("model_not_found") ||
    errMsgLower.includes("does not exist") ||
    (errMsgLower.includes("model") && errMsgLower.includes("found")) ||
    errMsgLower.includes("404")
  ) {
    return "model_not_found";
  }
  if (
    errMsgLower.includes("500") ||
    errMsgLower.includes("502") ||
    errMsgLower.includes("503") ||
    errMsgLower.includes("504") ||
    errMsgLower.includes("bad gateway") ||
    errMsgLower.includes("service unavailable") ||
    errMsgLower.includes("server error")
  ) {
    return "provider_error";
  }

  return "unknown";
}
