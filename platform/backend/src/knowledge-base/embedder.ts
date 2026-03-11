import type { EmbeddingModel } from "@shared";
import { EMBEDDING_BATCH_SIZE } from "@shared";
import OpenAI from "openai";
import logger from "@/logging";
import { KbChunkModel, KbDocumentModel } from "@/models";
import {
  buildEmbeddingInteraction,
  withKbObservability,
} from "./kb-interaction";
import { getDefaultOrgEmbeddingConfig } from "./kb-llm-client";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

interface EmbeddingContext {
  client: OpenAI;
  model: EmbeddingModel;
  dimensions: number;
}

class EmbeddingService {
  async processDocument(
    documentId: string,
    ctx: EmbeddingContext,
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
          chunkCount: 0,
        });
        return;
      }

      const allUpdates: Array<{ chunkId: string; embedding: number[] }> = [];

      for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
        const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
        const texts = batch.map((c) => c.content);

        const response = await this.callEmbeddingApiWithRetry(ctx, texts);

        for (let j = 0; j < batch.length; j++) {
          allUpdates.push({
            chunkId: batch[j].id,
            embedding: response.data[j].embedding,
          });
        }
      }

      await KbChunkModel.updateEmbeddings(allUpdates);

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
  ): Promise<void> {
    // 1. Load all documents in one query, filter to pending, gather chunks
    const documents = await KbDocumentModel.findByIds(documentIds);
    const documentsById = new Map(documents.map((d) => [d.id, d]));

    const docChunkMap: Array<{
      documentId: string;
      chunkIds: string[];
      chunkCount: number;
    }> = [];
    const allChunks: Array<{ chunkId: string; text: string }> = [];

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
          chunkCount: 0,
        });
        continue;
      }

      const chunkIds = chunks.map((c) => c.id);
      docChunkMap.push({ documentId, chunkIds, chunkCount: chunks.length });

      for (const chunk of chunks) {
        allChunks.push({ chunkId: chunk.id, text: chunk.content });
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

    for (let i = 0; i < allChunks.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = allChunks.slice(i, i + EMBEDDING_BATCH_SIZE);
      try {
        const response = await this.callEmbeddingApiWithRetry(
          ctx,
          batch.map((c) => c.text),
        );
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
        }
      }
    }

    // 3. Write embeddings and update document statuses
    const successfulUpdates = [...embeddingResults.entries()].map(
      ([chunkId, embedding]) => ({ chunkId, embedding }),
    );
    if (successfulUpdates.length > 0) {
      await KbChunkModel.updateEmbeddings(successfulUpdates);
    }

    for (const { documentId, chunkIds, chunkCount } of docChunkMap) {
      const anyFailed = chunkIds.some((id) => failedChunkIds.has(id));
      if (anyFailed) {
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
  }

  private async callEmbeddingApiWithRetry(
    ctx: EmbeddingContext,
    texts: string[],
  ): Promise<OpenAI.Embeddings.CreateEmbeddingResponse> {
    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await withKbObservability({
          operationName: "embedding",
          provider: "openai",
          model: ctx.model,
          source: "knowledge:embedding",
          type: "openai:embeddings",
          callback: () =>
            ctx.client.embeddings.create({
              model: ctx.model,
              input: texts,
              dimensions: ctx.dimensions,
            }),
          buildInteraction: (resp) =>
            buildEmbeddingInteraction({
              model: ctx.model,
              input: texts,
              dimensions: ctx.dimensions,
              response: resp,
            }),
        });

        return response;
      } catch (error) {
        const isLastAttempt = attempt === RETRY_MAX_ATTEMPTS;
        if (isLastAttempt || !this.isRetryableError(error)) {
          throw error;
        }

        const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
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

  private isRetryableError(error: unknown): boolean {
    if (error instanceof OpenAI.APIError) {
      return error.status === 429 || (error.status ?? 0) >= 500;
    }
    // Network-level errors (ECONNRESET, ETIMEDOUT, etc.)
    if (error instanceof Error && "code" in error) {
      return true;
    }
    return false;
  }
}

export const embeddingService = new EmbeddingService();
