import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { chunkAndStoreDocument } from "@/knowledge-base/chunk-and-store";
import { extractText } from "@/knowledge-base/file-upload/extract";
import { resolveOcrConfig } from "@/knowledge-base/kb-llm-client";
import {
  OCR_RUN_PAGE_BUDGET,
  type OcrRunContext,
} from "@/knowledge-base/pdf-ocr";
import logger from "@/logging";
import { KbChunkModel, KbDocumentModel, KbFileModel } from "@/models";
import { readRowBytes } from "@/skills-sandbox/file-storage";
import { taskQueueService } from "@/task-queue";
import { type AclEntry, ApiError } from "@/types";
import type { KnowledgeFileVisibility } from "@/types/knowledge-file";

/**
 * Audience tokens a document indexed from a repository file carries.
 *
 * These are DIRECT tokens, deliberately not a `container:` token pointing at a
 * `kb_container_acls` row: that table is owned by the permission-sync pass, and
 * an ordinary connector ACL refresh deletes every container row for its
 * connector — which would silently strip an authored audience and fail-close
 * the documents whose only grant it was. Direct tokens are already in every
 * user's base token set, so they also need no cache invalidation when a
 * visibility changes.
 */
function buildFileAcl(params: {
  visibility: KnowledgeFileVisibility;
  teamIds: string[];
  uploaderEmail: string | null;
}): AclEntry[] {
  switch (params.visibility) {
    case "org-wide":
      return ["org:*"];
    case "team-scoped":
      return params.teamIds.map((teamId): AclEntry => `team:${teamId}`);
    case "private":
      // No uploader means an offboarded user; an empty ACL fails closed rather
      // than silently widening a file that was meant to be private.
      return params.uploaderEmail ? [`user_email:${params.uploaderEmail}`] : [];
  }
}

/**
 * The internal connector backing a knowledge base's uploaded files, created on
 * first use.
 *
 * One per knowledge base rather than one per organization: connectors are
 * assigned to knowledge bases wholesale, so a shared connector would expose its
 * entire corpus through every base it was assigned to. Racing callers contend
 * on `kb_upload_connector`'s primary key, so exactly one connector is created.
 */
async function resolveUploadConnector(params: {
  knowledgeBaseId: string;
  organizationId: string;
}): Promise<string> {
  const [existing] = await db
    .select({ connectorId: schema.kbUploadConnectorsTable.connectorId })
    .from(schema.kbUploadConnectorsTable)
    .where(
      eq(
        schema.kbUploadConnectorsTable.knowledgeBaseId,
        params.knowledgeBaseId,
      ),
    )
    .limit(1);
  if (existing) return existing.connectorId;

  return db.transaction(async (tx) => {
    const [connector] = await tx
      .insert(schema.knowledgeBaseConnectorsTable)
      .values({
        organizationId: params.organizationId,
        name: "Uploaded files",
        connectorType: "file_upload",
        config: {} as never,
        visibility: "org-wide",
      })
      .returning();

    const claimed = await tx
      .insert(schema.kbUploadConnectorsTable)
      .values({
        knowledgeBaseId: params.knowledgeBaseId,
        connectorId: connector.id,
      })
      .onConflictDoNothing()
      .returning({ connectorId: schema.kbUploadConnectorsTable.connectorId });

    if (claimed.length === 0) {
      // Lost the race: another request already created the connector for this
      // knowledge base. Drop ours and use theirs rather than leaving an
      // orphaned connector behind.
      await tx
        .delete(schema.knowledgeBaseConnectorsTable)
        .where(eq(schema.knowledgeBaseConnectorsTable.id, connector.id));

      const [winner] = await tx
        .select({ connectorId: schema.kbUploadConnectorsTable.connectorId })
        .from(schema.kbUploadConnectorsTable)
        .where(
          eq(
            schema.kbUploadConnectorsTable.knowledgeBaseId,
            params.knowledgeBaseId,
          ),
        )
        .limit(1);
      return winner.connectorId;
    }

    await tx
      .insert(schema.knowledgeBaseConnectorAssignmentsTable)
      .values({
        knowledgeBaseId: params.knowledgeBaseId,
        connectorId: connector.id,
      })
      .onConflictDoNothing();

    return connector.id;
  });
}

/**
 * Index repository files into a knowledge base.
 *
 * Re-indexing the same file is an upsert on `(connector_id, source_id)`, so a
 * repeated call refreshes content rather than duplicating the document.
 * Embedding is enqueued, never run inline: a directory of several hundred files
 * would otherwise hold a request open for the whole corpus.
 */
export async function indexFilesIntoKnowledgeBase(params: {
  fileIds: string[];
  knowledgeBaseId: string;
  organizationId: string;
  uploaderEmailById: Map<string, string | null>;
}): Promise<{
  indexed: number;
  failures: { fileId: string; error: string }[];
}> {
  const connectorId = await resolveUploadConnector({
    knowledgeBaseId: params.knowledgeBaseId,
    organizationId: params.organizationId,
  });

  // Loaded once for its `ftsLanguage`: the keyword half of retrieval stems
  // chunks with it, so chunks written with the wrong language quietly answer
  // fewer keyword queries than the connector's own documents would.
  const [connector] = await db
    .select({ ftsLanguage: schema.knowledgeBaseConnectorsTable.ftsLanguage })
    .from(schema.knowledgeBaseConnectorsTable)
    .where(eq(schema.knowledgeBaseConnectorsTable.id, connectorId))
    .limit(1);
  if (!connector) {
    throw new ApiError(404, "Knowledge base not found");
  }

  const documentIds: string[] = [];
  const failures: { fileId: string; error: string }[] = [];

  // Arm OCR once for the whole request when the organization has it
  // configured, sharing one page budget across every file — the same
  // spend-bounding shape connector syncs use. Degraded, never fatal: an
  // unusable OCR configuration indexes text-layer files normally, and a
  // scanned file then fails with a reason naming the OCR outcome.
  let ocr: OcrRunContext | undefined;
  try {
    const ocrConfig = await resolveOcrConfig(params.organizationId);
    if (ocrConfig) {
      ocr = {
        config: ocrConfig,
        connectorId,
        // Indexing runs inside one HTTP request with a bounded file count;
        // the page budget is the spend ceiling, not wall clock.
        deadlineAt: Number.POSITIVE_INFINITY,
        budget: { remainingPages: OCR_RUN_PAGE_BUDGET },
        log: logger,
        connectorType: "file_upload",
      };
    }
  } catch (error) {
    logger.warn(
      {
        organizationId: params.organizationId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[KnowledgeFiles] OCR is configured but unusable — indexing without it",
    );
  }

  for (const fileId of params.fileIds) {
    try {
      const [file] = await db
        .select()
        .from(schema.kbFilesTable)
        .where(
          and(
            eq(schema.kbFilesTable.id, fileId),
            eq(schema.kbFilesTable.organizationId, params.organizationId),
          ),
        )
        .limit(1);
      if (!file) {
        failures.push({ fileId, error: "File not found" });
        continue;
      }

      const bytes = await readRowBytes(file);
      const { text } = await extractText({
        buffer: bytes,
        filename: file.filename,
        ocr,
      });

      const acl = buildFileAcl({
        visibility: file.visibility,
        teamIds: await KbFileModel.findTeamIds(file.id),
        uploaderEmail: params.uploaderEmailById.get(file.id) ?? null,
      });

      const existing = await KbDocumentModel.findBySourceId({
        connectorId,
        sourceId: file.id,
      });

      const document = existing
        ? await KbDocumentModel.update(existing.id, {
            title: file.filename,
            content: text,
            contentHash: file.contentHash,
            acl,
            containerKey: file.directoryId,
            embeddingStatus: "pending",
          })
        : await KbDocumentModel.create({
            organizationId: params.organizationId,
            connectorId,
            sourceId: file.id,
            title: file.filename,
            content: text,
            contentHash: file.contentHash,
            acl,
            // Grouping only — never resolved as a `container:` ACL token.
            containerKey: file.directoryId,
          });

      if (!document) {
        failures.push({ fileId, error: "Could not write the document" });
        continue;
      }

      // Chunks — not the document row — are what retrieval searches, and the
      // embedding pass only reads them. Without this the document fails with
      // zero chunks and cannot be retrieved. Re-indexing replaces the previous
      // chunks rather than appending to them.
      if (existing) {
        await KbChunkModel.deleteByDocument(document.id);
      }
      await chunkAndStoreDocument({
        documentId: document.id,
        title: file.filename,
        content: text,
        connectorType: "file_upload",
        connectorId,
        organizationId: params.organizationId,
        ftsLanguage: connector.ftsLanguage,
        acl,
        log: logger,
      });

      await KbFileModel.linkDocument({
        kbFileId: file.id,
        kbDocumentId: document.id,
      });
      documentIds.push(document.id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not index the file";
      logger.warn(
        { fileId, knowledgeBaseId: params.knowledgeBaseId, error: message },
        "[KnowledgeFiles] Failed to index file",
      );
      failures.push({ fileId, error: message });
    }
  }

  if (documentIds.length > 0) {
    await taskQueueService.enqueue({
      taskType: "batch_embedding",
      payload: { documentIds },
    });
  }

  return { indexed: documentIds.length, failures };
}

/** Stable identity for dedupe and for the document's content hash. */
export function hashFileContent(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
