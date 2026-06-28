import { createHash } from "node:crypto";
import type { ModelInputModality } from "@archestra/shared";
import type pino from "pino";
import defaultLogger from "@/logging";
import {
  ConnectorRunModel,
  KbChunkModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
} from "@/models";
import * as metrics from "@/observability/metrics";
import { taskQueueService } from "@/task-queue";
import type {
  AclEntry,
  ConnectorDocument,
  KnowledgeBaseConnector,
  KnowledgeSourceVisibility,
} from "@/types";
import { IdentityResolutionService } from "./identity-resolution";
import { AclMaterializer } from "./acl-materializer";
import { chunkDocument } from "./chunker";
import { resolveConnectorCredentials } from "./connector-credentials";
import {
  BaseConnector,
  extractErrorMessage,
} from "./connectors/base-connector";
import { getConnector } from "./connectors/registry";
import { resolveEmbeddingConfig } from "./kb-llm-client";
import { knowledgeSourceAccessControlService } from "./source-access-control";

/**
 * Service that orchestrates the sync of data from external connectors
 * (e.g., Jira, Confluence) into kb_documents.
 *
 * Documents are stored once per connector. The knowledge_base_connector_assignment
 * junction table resolves which KBs a document belongs to.
 */
class ConnectorSyncService {
  async executeSync(
    connectorId: string,
    options?: {
      logger?: pino.Logger;
      getLogOutput?: () => string;
      maxDurationMs?: number;
    },
  ): Promise<{ runId: string; status: string }> {
    const log = options?.logger ?? defaultLogger;

    const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
    if (!connector) {
      throw new Error(`Connector not found: ${connectorId}`);
    }

    // Load credentials from secrets manager
    const [credentials, documentAcl] = await Promise.all([
      resolveConnectorCredentials(connector),
      this.buildDocumentAccessControlList(connector),
    ]);

    // Get the connector implementation
    const connectorImpl = getConnector(connector.connectorType);

    // Interrupt any stale "running" runs left by previous attempts
    const interrupted =
      await ConnectorRunModel.interruptActiveRuns(connectorId);
    if (interrupted > 0) {
      log.info(
        {
          connectorId,
          connectorName: connector.name,
          connectorType: connector.connectorType,
          interrupted,
        },
        "Interrupted stale running runs",
      );
    }

    // Create a connector run record
    const run = await ConnectorRunModel.create({
      connectorId,
      status: "running",
      startedAt: new Date(),
      documentsProcessed: 0,
      documentsIngested: 0,
    });

    // Bind runId, connectorName, and connectorType to logger so every log line in this sync includes them
    const runLog = log.child({
      runId: run.id,
      connectorId,
      connectorName: connector.name,
      connectorType: connector.connectorType,
    });

    // Propagate the run-scoped logger into the connector implementation
    if (connectorImpl instanceof BaseConnector) {
      connectorImpl.setLogger(runLog);
    }

    // Update connector lastSyncStatus to running.
    // Also set lastSyncAt optimistically so the scheduler doesn't re-trigger
    // this connector while batch_embedding tasks are still running (the task
    // queue marks connector_sync as "completed" before embeddings finish, but
    // lastSyncAt is only finalized by the last batch_embedding task).
    await KnowledgeBaseConnectorModel.update(connectorId, {
      lastSyncStatus: "running",
      lastSyncAt: new Date(),
    });

    let documentsProcessed = 0;
    let documentsIngested = 0;
    let itemErrors = 0;
    let itemsSkipped = 0;
    let batchCount = 0;
    const startTime = Date.now();
    let stoppedEarly = false;

    // Resolve the embedding model's supported input modalities so connectors
    // can conditionally ingest non-text content (e.g. images).
    // Must happen before estimateTotalItems so the estimate matches sync behavior.
    let embeddingInputModalities: ModelInputModality[] | undefined;
    try {
      const embeddingConfig = await resolveEmbeddingConfig(
        connector.organizationId,
      );
      embeddingInputModalities = embeddingConfig?.inputModalities ?? undefined;
    } catch {
      // Non-fatal: proceed without modality info
    }

    // Estimate total items for progress display
    try {
      const totalItems = await connectorImpl.estimateTotalItems({
        config: connector.config as Record<string, unknown>,
        credentials,
        checkpoint: connector.checkpoint as Record<string, unknown> | null,
        embeddingInputModalities,
      });

      if (totalItems !== null && totalItems > 0) {
        await ConnectorRunModel.update(run.id, { totalItems });
        runLog.info({ totalItems }, "Estimated total items");
      }
    } catch (error) {
      runLog.warn(
        {
          error: extractErrorMessage(error),
        },
        "Failed to estimate total items, continuing without",
      );
    }

    try {
      const syncGenerator = connectorImpl.sync({
        config: connector.config as Record<string, unknown>,
        credentials,
        checkpoint: connector.checkpoint as Record<string, unknown> | null,
        embeddingInputModalities,
      });

      for await (const batch of syncGenerator) {
        const ingestedDocumentIds: string[] = [];
        for (const doc of batch.documents) {
          documentsProcessed++;
          try {
            if (
              connector.visibility === "auto-sync-permissions" &&
              typeof connectorImpl.resolveDocumentPermissions === "function"
            ) {
              try {
                doc.permissions = await connectorImpl.resolveDocumentPermissions(doc, {
                  config: connector.config as Record<string, unknown>,
                  credentials,
                });
              } catch (err) {
                runLog.warn(
                  { docId: doc.id, error: extractErrorMessage(err) },
                  "Failed to resolve permissions for document",
                );
              }
            }

            const result = await this.ingestDocument({
              doc,
              connectorId,
              connectorType: connector.connectorType,
              organizationId: connector.organizationId,
              acl: documentAcl,
              log: runLog,
              visibility: connector.visibility,
              connector,
            });
            if (result.ingested) {
              documentsIngested++;
            }
            if (result.ingested && result.documentId) {
              ingestedDocumentIds.push(result.documentId);
            }
          } catch (docError) {
            itemErrors++;
            runLog.warn(
              {
                documentId: doc.id,
                error: extractErrorMessage(docError),
              },
              "Failed to ingest document",
            );
          }
        }

        // Enqueue embedding as a separate task
        if (ingestedDocumentIds.length > 0) {
          batchCount++;
          await taskQueueService.enqueue({
            taskType: "batch_embedding",
            payload: {
              documentIds: ingestedDocumentIds,
              connectorRunId: run.id,
            },
          });
        }

        // Track item-level failures from this batch
        if (batch.failures?.length) {
          itemErrors += batch.failures.length;
        }

        // Track skipped items from this batch
        if (batch.skipped?.length) {
          itemsSkipped += batch.skipped.length;
          documentsProcessed += batch.skipped.length;
          for (const s of batch.skipped) {
            runLog.debug(
              { itemId: s.itemId, name: s.name, reason: s.reason },
              "Item skipped",
            );
          }
        }

        // Update run progress + flush logs after each batch
        await ConnectorRunModel.update(run.id, {
          documentsProcessed,
          documentsIngested,
          itemErrors,
          itemsSkipped,
          logs: options?.getLogOutput?.() ?? null,
        });

        // Update connector checkpoint
        await KnowledgeBaseConnectorModel.update(connectorId, {
          checkpoint: batch.checkpoint,
        });

        // Check time budget: stop early if we've used 90% of maxDurationMs and there's more data
        if (options?.maxDurationMs && batch.hasMore) {
          const elapsed = Date.now() - startTime;
          if (elapsed > options.maxDurationMs * 0.9) {
            stoppedEarly = true;
            runLog.info(
              {
                elapsedMs: elapsed,
                maxDurationMs: options.maxDurationMs,
                documentsProcessed,
              },
              "Time budget exceeded, stopping early for continuation",
            );
            break;
          }
        }
      }

      // Set totalBatches so batch_embedding handlers can coordinate
      if (batchCount > 0) {
        await ConnectorRunModel.update(run.id, { totalBatches: batchCount });
      }

      if (stoppedEarly) {
        // Partial completion — will be continued by a follow-up run
        await ConnectorRunModel.update(run.id, {
          status: "partial",
          completedAt: new Date(),
          documentsProcessed,
          documentsIngested,
          itemErrors,
          itemsSkipped,
          logs: options?.getLogOutput?.() ?? null,
        });

        await KnowledgeBaseConnectorModel.update(connectorId, {
          lastSyncStatus: "partial",
          lastSyncError: null,
        });

        const durationSeconds = (Date.now() - startTime) / 1000;
        metrics.rag.reportConnectorSync({
          connectorType: connector.connectorType,
          status: "partial",
          durationSeconds,
          documentsProcessed,
          documentsIngested,
        });

        runLog.info(
          { documentsProcessed, documentsIngested },
          "Partial sync completed, continuation needed",
        );

        return { runId: run.id, status: "partial" };
      }

      if (batchCount === 0) {
        // No documents ingested — finalize immediately
        const now = new Date();
        const finalStatus =
          itemErrors > 0 ? "completed_with_errors" : "success";
        await ConnectorRunModel.update(run.id, {
          status: finalStatus,
          completedAt: now,
          documentsProcessed,
          documentsIngested,
          itemErrors,
          itemsSkipped,
          logs: options?.getLogOutput?.() ?? null,
        });

        await KnowledgeBaseConnectorModel.update(connectorId, {
          lastSyncStatus: finalStatus,
          lastSyncAt: now,
          lastSyncError: null,
        });
      } else {
        // Batches were enqueued — update progress but leave status as "running"
        // The last batch_embedding task will finalize the run
        await ConnectorRunModel.update(run.id, {
          documentsProcessed,
          documentsIngested,
          logs: options?.getLogOutput?.() ?? null,
        });

        // Handle edge case: all batches may have completed before totalBatches was set.
        // finalizeBatchesIfComplete atomically checks and transitions if ready.
        const finalizedRun = await ConnectorRunModel.finalizeBatchesIfComplete(
          run.id,
        );
        if (
          finalizedRun &&
          (finalizedRun.status === "success" ||
            finalizedRun.status === "completed_with_errors")
        ) {
          await KnowledgeBaseConnectorModel.update(connectorId, {
            lastSyncStatus: finalizedRun.status,
            lastSyncAt: finalizedRun.completedAt ?? new Date(),
          });
        }
      }

      metrics.rag.reportConnectorSync({
        connectorType: connector.connectorType,
        status: "success",
        durationSeconds: (Date.now() - startTime) / 1000,
        documentsProcessed,
        documentsIngested,
      });

      runLog.info(
        {
          documentsProcessed,
          documentsIngested,
          batchCount,
        },
        "Sync completed successfully",
      );

      return { runId: run.id, status: "success" };
    } catch (error) {
      const errorMessage = extractErrorMessage(error);

      await ConnectorRunModel.update(run.id, {
        status: "failed",
        completedAt: new Date(),
        documentsProcessed,
        documentsIngested,
        itemErrors,
        itemsSkipped,
        error: errorMessage,
        logs: options?.getLogOutput?.() ?? null,
      });

      await KnowledgeBaseConnectorModel.update(connectorId, {
        lastSyncStatus: "failed",
        lastSyncError: errorMessage,
        lastSyncAt: new Date(),
      });

      const durationSeconds = (Date.now() - startTime) / 1000;
      metrics.rag.reportConnectorSync({
        connectorType: connector.connectorType,
        status: "failed",
        durationSeconds,
        documentsProcessed,
        documentsIngested,
      });

      runLog.error({ error: errorMessage }, "Sync failed");

      return { runId: run.id, status: "failed" };
    }
  }

  /**
   * Ingest a single connector document into kb_documents.
   * Lookup by connectorId + sourceId. Compare contentHash to detect changes.
   * Returns false if the document already exists with the same content (skipped).
   */
  private async ingestDocument(params: {
    doc: ConnectorDocument;
    connectorId: string;
    connectorType: string;
    organizationId: string;
    acl: AclEntry[];
    log: pino.Logger;
    visibility: KnowledgeSourceVisibility;
    connector: KnowledgeBaseConnector;
  }): Promise<{ ingested: boolean; documentId: string | null }> {
    const { doc, connectorId, connectorType, organizationId, acl, log, visibility, connector } =
      params;

    // Include media data and permissions in hash so unchanged content/permissions are properly skipped.
    const permissionHashString = doc.permissions ? JSON.stringify(doc.permissions) : "";
    const hashInput = (doc.mediaContent
      ? `${doc.mediaContent.mimeType}:${doc.mediaContent.data}` +
        (doc.metadata
          ? "\n" +
            JSON.stringify(doc.metadata, Object.keys(doc.metadata).sort())
          : "")
      : doc.metadata
        ? doc.content +
          "\n" +
          JSON.stringify(doc.metadata, Object.keys(doc.metadata).sort())
        : doc.content) + (permissionHashString ? "\npermissions:" + permissionHashString : "");
    const contentHash = createHash("sha256").update(hashInput).digest("hex");

    // Lookup existing document by connector + source ID
    const existing = await KbDocumentModel.findBySourceId({
      connectorId,
      sourceId: doc.id,
    });

    let targetAcl = acl;
    let syncStatus: "synced" | "skipped_unresolvable" = "synced";
    let syncMetadata: Record<string, any> | null = null;

    if (visibility === "auto-sync-permissions") {
      if (!doc.permissions) {
        log.warn(`Skipping document ${doc.id} - missing permission metadata`);
        const errMetadata = {
          provider: connector.connectorType,
          error: "Missing upstream permission metadata",
          lastSyncedAt: new Date().toISOString(),
        };
        if (existing) {
          await KbDocumentModel.update(existing.id, {
            permissionSyncStatus: "skipped_unresolvable",
            permissionSyncMetadata: errMetadata,
          });
          return { ingested: false, documentId: existing.id };
        } else {
          const created = await KbDocumentModel.create({
            organizationId,
            sourceId: doc.id,
            connectorId,
            title: doc.title,
            content: "",
            contentHash,
            sourceUrl: doc.sourceUrl || null,
            acl: [],
            metadata: doc.metadata,
            permissionSyncStatus: "skipped_unresolvable",
            permissionSyncMetadata: errMetadata,
          });
          return { ingested: false, documentId: created.id };
        }
      }

      const materializer = new AclMaterializer(new IdentityResolutionService(organizationId));
      const resolved = await materializer.materialize(doc.permissions);

      syncMetadata = {
        provider: connector.connectorType,
        rawPermissions: doc.permissions,
        resolvedEmails: resolved.resolvedEmails,
        skippedGroups: resolved.skippedGroups,
        lastSyncedAt: new Date().toISOString(),
      };

      if (!resolved.complete) {
        log.warn({ docId: doc.id, skippedGroups: resolved.skippedGroups }, "Fail-closed check: unmapped groups. Skipping document.");
        if (existing) {
          await KbDocumentModel.update(existing.id, {
            permissionSyncStatus: "skipped_unresolvable",
            permissionSyncMetadata: syncMetadata,
          });
          return { ingested: false, documentId: existing.id };
        } else {
          const created = await KbDocumentModel.create({
            organizationId,
            sourceId: doc.id,
            connectorId,
            title: doc.title,
            content: "",
            contentHash,
            sourceUrl: doc.sourceUrl || null,
            acl: [],
            metadata: doc.metadata,
            permissionSyncStatus: "skipped_unresolvable",
            permissionSyncMetadata: syncMetadata,
          });
          return { ingested: false, documentId: created.id };
        }
      }

      targetAcl = resolved.acl;
      syncStatus = "synced";
    }

    if (existing) {
      // Same content hash → skip (unchanged)
      if (existing.contentHash === contentHash && existing.permissionSyncStatus !== "skipped_unresolvable") {
        const existingChunkCount = await KbChunkModel.countByDocument(
          existing.id,
        );

        if (existingChunkCount === 0) {
          await this.chunkAndStore({
            documentId: existing.id,
            title: doc.title,
            content: doc.content,
            mediaContent: doc.mediaContent,
            metadata: doc.metadata,
            connectorType,
            acl: targetAcl,
            log,
          });

          await KbDocumentModel.update(existing.id, {
            embeddingStatus: "pending",
          });

          log.warn(
            {
              documentId: doc.id,
              existingDocId: existing.id,
            },
            "Document had no chunks despite unchanged content, repaired and re-queued",
          );
          return { ingested: true, documentId: existing.id };
        }

        log.debug(
          {
            documentId: doc.id,
            existingDocId: existing.id,
          },
          "Document unchanged, skipping",
        );
        return { ingested: false, documentId: null };
      }

      // Content has changed or permission was skipped — update existing document
      await KbDocumentModel.update(existing.id, {
        title: doc.title,
        content: doc.content,
        contentHash,
        sourceUrl: doc.sourceUrl ?? null,
        acl: targetAcl,
        metadata: doc.metadata,
        embeddingStatus: "pending",
        permissionSyncStatus: syncStatus,
        permissionSyncMetadata: syncMetadata,
      });

      // Re-chunk: content changed, so replace stale chunks
      await KbChunkModel.deleteByDocument(existing.id);
      await this.chunkAndStore({
        documentId: existing.id,
        title: doc.title,
        content: doc.content,
        mediaContent: doc.mediaContent,
        metadata: doc.metadata,
        connectorType,
        acl: targetAcl,
        log,
      });

      log.debug(
        {
          documentId: doc.id,
          kbDocumentId: existing.id,
        },
        "Updated existing document with new content",
      );
      return { ingested: true, documentId: existing.id };
    }

    // Create new document
    const created = await KbDocumentModel.create({
      organizationId,
      sourceId: doc.id,
      connectorId,
      title: doc.title,
      content: doc.content,
      contentHash,
      sourceUrl: doc.sourceUrl,
      acl: targetAcl,
      metadata: doc.metadata,
      permissionSyncStatus: syncStatus,
      permissionSyncMetadata: syncMetadata,
    });

    await this.chunkAndStore({
      documentId: created.id,
      title: doc.title,
      content: doc.content,
      mediaContent: doc.mediaContent,
      metadata: doc.metadata,
      connectorType,
      acl: targetAcl,
      log,
    });

    log.debug(
      {
        documentId: doc.id,
      },
      "Document ingested into kb_documents",
    );
    return { ingested: true, documentId: created.id };
  }

  private async chunkAndStore(params: {
    documentId: string;
    title: string;
    content: string;
    mediaContent?: { mimeType: string; data: string };
    metadata?: Record<string, unknown>;
    connectorType: string;
    acl: AclEntry[];
    log: pino.Logger;
  }): Promise<void> {
    const {
      documentId,
      title,
      content,
      mediaContent,
      metadata,
      connectorType,
      acl,
      log,
    } = params;

    // For media (image) documents: create a single chunk whose content is the
    // data URL. The embedding pipeline detects this prefix and routes to the
    // multimodal embedding API instead of text embedding.
    if (mediaContent) {
      const dataUrl = `data:${mediaContent.mimeType};base64,${mediaContent.data}`;
      await KbChunkModel.insertMany([
        {
          documentId,
          content: dataUrl,
          chunkIndex: 0,
          metadataSuffixSemantic: null,
          metadataSuffixKeyword: null,
          acl,
        },
      ]);
      metrics.rag.reportChunksCreated(connectorType, 1);
      log.debug({ documentId }, "Image document stored as single media chunk");
      return;
    }

    const chunks = await chunkDocument({ title, content, metadata });

    if (chunks.length === 0) return;

    await KbChunkModel.insertMany(
      chunks.map((chunk) => ({
        documentId,
        content: chunk.content,
        chunkIndex: chunk.chunkIndex,
        metadataSuffixSemantic: chunk.metadataSuffixSemantic,
        metadataSuffixKeyword: chunk.metadataSuffixKeyword,
        acl,
      })),
    );

    metrics.rag.reportChunksCreated(connectorType, chunks.length);

    log.debug(
      { documentId, chunkCount: chunks.length },
      "Document chunked and stored",
    );
  }

  private buildDocumentAccessControlList(
    connector: KnowledgeBaseConnector,
  ): AclEntry[] {
    return knowledgeSourceAccessControlService.buildConnectorDocumentAccessControlList(
      { connector },
    );
  }
}

export const connectorSyncService = new ConnectorSyncService();
