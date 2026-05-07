import db, { schema } from "@/database";
import { knowledgeSourceAccessControlService } from "@/knowledge-base";
import { chunkDocument } from "@/knowledge-base/chunker";
import {
  extractTextFiles,
  isSupportedMimeType,
} from "@/knowledge-base/connectors/file-upload/file-processor";
import logger from "@/logging";
import { KbUploadedFileModel, KnowledgeBaseConnectorModel } from "@/models";
import { taskQueueService } from "@/task-queue";

/**
 * Background handler for processing uploaded files.
 *
 * Payload: { connectorId: string, fileIds: string[] }
 *
 * For each file:
 *   1. Load raw bytes from DB
 *   2. Extract text (PDF/DOCX/etc.)
 *   3. Chunk the document
 *   4. Insert document + chunks
 *   5. Update file processingStatus → "completed"
 *
 * After all files are processed, enqueue a single batch_embedding task
 * for all generated document IDs.
 */
export async function handleProcessUploadedFiles(
  payload: Record<string, unknown>,
): Promise<void> {
  const connectorId = payload.connectorId as string;
  const fileIds = payload.fileIds as string[];

  if (!connectorId || !fileIds?.length) {
    throw new Error(
      "Missing connectorId or fileIds in process_uploaded_files payload",
    );
  }

  const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
  if (!connector) {
    logger.warn(
      { connectorId },
      "[ProcessUploadedFiles] Connector not found, skipping",
    );
    return;
  }

  const acl =
    knowledgeSourceAccessControlService.buildConnectorDocumentAccessControlList(
      { connector },
    );

  const files = await KbUploadedFileModel.findByIdsWithData(fileIds);
  const documentIds: string[] = [];

  for (const file of files) {
    try {
      await KbUploadedFileModel.updateProcessingStatus(file.id, "processing");

      if (!isSupportedMimeType(file.originalName, file.mimeType)) {
        await KbUploadedFileModel.updateProcessingStatus(
          file.id,
          "failed",
          "Unsupported file type",
        );
        continue;
      }

      let extraction: Awaited<ReturnType<typeof extractTextFiles>>;
      try {
        extraction = await extractTextFiles(
          file.fileData,
          file.mimeType,
          file.originalName,
        );
      } catch (error) {
        logger.warn(
          { err: error, fileId: file.id, filename: file.originalName },
          "[ProcessUploadedFiles] Failed to extract text",
        );
        await KbUploadedFileModel.updateProcessingStatus(
          file.id,
          "failed",
          "Text extraction failed",
        );
        continue;
      }

      if (extraction.extracted.length === 0) {
        await KbUploadedFileModel.updateProcessingStatus(
          file.id,
          "failed",
          extraction.skipped.length > 0
            ? `Skipped: ${extraction.skipped[0].reason}`
            : "No text could be extracted",
        );
        continue;
      }

      const extractedFile = extraction.extracted[0];

      const title = extractedFile.filename;
      const chunks = await chunkDocument({
        title,
        content: extractedFile.text,
        metadata: {
          originalFilename: extractedFile.filename,
          mimeType: extractedFile.mimeType,
        },
      });

      const contentHash = KbUploadedFileModel.computeContentHash(
        extractedFile.text,
      );

      const txResult = await db.transaction(async (tx) => {
        const [doc] = await tx
          .insert(schema.kbDocumentsTable)
          .values({
            organizationId: file.organizationId,
            connectorId,
            sourceId: file.id,
            title,
            content: extractedFile.text,
            contentHash,
            acl,
            metadata: {
              originalFilename: extractedFile.filename,
              mimeType: extractedFile.mimeType,
            },
          })
          .returning();

        if (chunks.length > 0) {
          await tx.insert(schema.kbChunksTable).values(
            chunks.map((chunk) => ({
              documentId: doc.id,
              content: chunk.content,
              chunkIndex: chunk.chunkIndex,
              metadataSuffixSemantic: chunk.metadataSuffixSemantic,
              metadataSuffixKeyword: chunk.metadataSuffixKeyword,
              acl,
            })),
          );
        }

        return { documentId: doc.id };
      });

      documentIds.push(txResult.documentId);
      await KbUploadedFileModel.updateProcessingStatus(file.id, "completed");

      logger.info(
        {
          fileId: file.id,
          documentId: txResult.documentId,
          chunks: chunks.length,
        },
        "[ProcessUploadedFiles] File processed successfully",
      );
    } catch (error) {
      logger.error(
        { err: error, fileId: file.id },
        "[ProcessUploadedFiles] Unexpected error processing file",
      );
      await KbUploadedFileModel.updateProcessingStatus(
        file.id,
        "failed",
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  }

  if (documentIds.length > 0) {
    await taskQueueService.enqueue({
      taskType: "batch_embedding",
      payload: {
        documentIds,
        connectorRunId: null,
      },
    });

    logger.info(
      { connectorId, documentCount: documentIds.length },
      "[ProcessUploadedFiles] Enqueued batch embedding for all processed files",
    );
  }
}
