import type { EmbeddingModel } from "@shared";
import { EMBEDDING_BATCH_SIZE } from "@shared";
import { Cron } from "croner";
import type OpenAI from "openai";
import logger from "@/logging";
import { KbChunkModel, KbDocumentModel } from "@/models";
import { getDefaultOrgEmbeddingConfig } from "./kb-llm-client";

interface EmbeddingContext {
  client: OpenAI;
  model: EmbeddingModel;
  dimensions: number;
}

class EmbeddingService {
  private processing = false;

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

        const response = await ctx.client.embeddings.create({
          model: ctx.model,
          input: texts,
          dimensions: ctx.dimensions,
        });

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

  async processPendingDocuments(params?: { limit?: number }): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      const documents = await KbDocumentModel.findPending({
        limit: params?.limit ?? 10,
      });

      if (documents.length === 0) {
        return;
      }

      const orgConfig = await getDefaultOrgEmbeddingConfig();
      if (!orgConfig) {
        logger.debug(
          "[Embedder] No embedding API key configured, skipping pending documents",
        );
        return;
      }

      for (const doc of documents) {
        try {
          await this.processDocument(doc.id, orgConfig.config);
        } catch (error) {
          logger.error(
            {
              documentId: doc.id,
              error: error instanceof Error ? error.message : String(error),
            },
            "[Embedder] Error processing document",
          );
        }
      }
    } finally {
      this.processing = false;
    }
  }
}

export const embeddingService = new EmbeddingService();

export function startEmbeddingCron(): void {
  new Cron("*/30 * * * * *", () => {
    embeddingService.processPendingDocuments().catch((error) => {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "[Embedder] Cron tick failed",
      );
    });
  });

  logger.info("[Embedder] Embedding cron started (every 30s)");
}
