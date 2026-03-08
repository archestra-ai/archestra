import OpenAI from "openai";
import config from "@/config";
import logger from "@/logging";
import { KbChunkModel, KbDocumentModel } from "@/models";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_BATCH_SIZE = 100;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

class EmbeddingService {
  private openai: OpenAI | null = null;

  async processDocument(documentId: string): Promise<void> {
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

      const client = this.getOpenAIClient();
      const allUpdates: Array<{ chunkId: string; embedding: number[] }> = [];

      for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
        const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
        const texts = batch.map((c) => c.content);

        const response = await this.callEmbeddingApiWithRetry(client, texts);

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

  private async callEmbeddingApiWithRetry(
    client: OpenAI,
    texts: string[],
  ): Promise<OpenAI.Embeddings.CreateEmbeddingResponse> {
    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        return await client.embeddings.create({
          model: EMBEDDING_MODEL,
          input: texts,
        });
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

  private getOpenAIClient(): OpenAI {
    if (!this.openai) {
      this.openai = new OpenAI({ apiKey: config.kb.embeddingApiKey });
    }
    return this.openai;
  }
}

export const embeddingService = new EmbeddingService();
