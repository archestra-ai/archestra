import { createHash } from "node:crypto";
import type pino from "pino";
import defaultLogger from "@/logging";
import {
  ConnectorRunModel,
  KbChunkModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import type { KnowledgeBase } from "@/types";
import type { AclEntry } from "@/types/kb-document";
import type {
  ConnectorCredentials,
  ConnectorDocument,
} from "@/types/knowledge-connector";
import { buildDocumentAcl } from "./acl";
import { chunkDocument } from "./chunker";
import { getConnector } from "./connectors/registry";

/**
 * Service that orchestrates the sync of data from external connectors
 * (e.g., Jira, Confluence) into kb_documents.
 *
 * A connector can be assigned to multiple knowledge bases. During sync,
 * documents are ingested into ALL assigned knowledge bases.
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

    // Find all assigned knowledge bases
    const knowledgeBaseIds =
      await KnowledgeBaseConnectorModel.getKnowledgeBaseIds(connectorId);
    if (knowledgeBaseIds.length === 0) {
      throw new Error(
        `Connector ${connectorId} is not assigned to any knowledge base`,
      );
    }

    const knowledgeBases: KnowledgeBase[] = [];
    for (const kbId of knowledgeBaseIds) {
      const kb = await KnowledgeBaseModel.findById(kbId);
      if (!kb) {
        log.warn(
          { connectorId, knowledgeBaseId: kbId },
          "[ConnectorSync] Knowledge base not found, skipping",
        );
        continue;
      }
      knowledgeBases.push(kb);
    }

    if (knowledgeBases.length === 0) {
      throw new Error(
        `No valid knowledge bases found for connector ${connectorId}`,
      );
    }

    // Load credentials from secrets manager
    const credentials = await this.loadCredentials(connector.secretId, log);

    // Get the connector implementation
    const connectorImpl = getConnector(connector.connectorType);

    // Create a connector run record
    const run = await ConnectorRunModel.create({
      connectorId,
      status: "running",
      startedAt: new Date(),
      documentsProcessed: 0,
      documentsIngested: 0,
    });

    // Bind runId to logger so every log line in this sync includes it
    const runLog = log.child({ runId: run.id, connectorId });

    // Update connector lastSyncStatus to running
    await KnowledgeBaseConnectorModel.update(connectorId, {
      lastSyncStatus: "running",
    });

    // Estimate total items for progress display
    try {
      const totalItems = await connectorImpl.estimateTotalItems({
        config: connector.config as Record<string, unknown>,
        credentials,
        checkpoint: connector.checkpoint as Record<string, unknown> | null,
      });

      if (totalItems !== null && totalItems > 0) {
        await ConnectorRunModel.update(run.id, { totalItems });
        runLog.info({ totalItems }, "[ConnectorSync] Estimated total items");
      }
    } catch (error) {
      runLog.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "[ConnectorSync] Failed to estimate total items, continuing without",
      );
    }

    let documentsProcessed = 0;
    let documentsIngested = 0;
    const startTime = Date.now();
    let stoppedEarly = false;

    try {
      const syncGenerator = connectorImpl.sync({
        config: connector.config as Record<string, unknown>,
        credentials,
        checkpoint: connector.checkpoint as Record<string, unknown> | null,
      });

      for await (const batch of syncGenerator) {
        for (const doc of batch.documents) {
          documentsProcessed++;
          // Ingest document into all assigned knowledge bases
          for (const kb of knowledgeBases) {
            try {
              const ingested = await this.ingestDocument({
                doc,
                knowledgeBase: kb,
                connectorId,
                connectorType: connector.connectorType,
                log: runLog,
              });
              if (ingested) {
                documentsIngested++;
              }
            } catch (docError) {
              runLog.warn(
                {
                  knowledgeBaseId: kb.id,
                  documentId: doc.id,
                  error:
                    docError instanceof Error
                      ? docError.message
                      : String(docError),
                },
                "[ConnectorSync] Failed to ingest document into knowledge base",
              );
            }
          }
        }

        // Update run progress + flush logs after each batch
        await ConnectorRunModel.update(run.id, {
          documentsProcessed,
          documentsIngested,
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
              "[ConnectorSync] Time budget exceeded, stopping early for continuation",
            );
            break;
          }
        }
      }

      if (stoppedEarly) {
        // Partial completion — will be continued by a follow-up run
        await ConnectorRunModel.update(run.id, {
          status: "partial",
          completedAt: new Date(),
          documentsProcessed,
          documentsIngested,
          logs: options?.getLogOutput?.() ?? null,
        });

        await KnowledgeBaseConnectorModel.update(connectorId, {
          lastSyncStatus: "partial",
        });

        runLog.info(
          { documentsProcessed, documentsIngested },
          "[ConnectorSync] Partial sync completed, continuation needed",
        );

        return { runId: run.id, status: "partial" };
      }

      // On success
      const now = new Date();
      await ConnectorRunModel.update(run.id, {
        status: "success",
        completedAt: now,
        documentsProcessed,
        documentsIngested,
        logs: options?.getLogOutput?.() ?? null,
      });

      await KnowledgeBaseConnectorModel.update(connectorId, {
        lastSyncStatus: "success",
        lastSyncAt: now,
        lastSyncError: null,
      });

      runLog.info(
        {
          documentsProcessed,
          documentsIngested,
          knowledgeBaseCount: knowledgeBases.length,
        },
        "[ConnectorSync] Sync completed successfully",
      );

      return { runId: run.id, status: "success" };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      await ConnectorRunModel.update(run.id, {
        status: "failed",
        completedAt: new Date(),
        documentsProcessed,
        documentsIngested,
        error: errorMessage,
        logs: options?.getLogOutput?.() ?? null,
      });

      await KnowledgeBaseConnectorModel.update(connectorId, {
        lastSyncStatus: "failed",
        lastSyncError: errorMessage,
      });

      runLog.error({ error: errorMessage }, "[ConnectorSync] Sync failed");

      return { runId: run.id, status: "failed" };
    }
  }

  /**
   * Ingest a single connector document into a knowledge base via kb_documents.
   * Uses content hash deduplication — returns false if the document already exists
   * with the same content hash (skipped).
   */
  private async ingestDocument(params: {
    doc: ConnectorDocument;
    knowledgeBase: KnowledgeBase;
    connectorId: string;
    connectorType: string;
    log: pino.Logger;
  }): Promise<boolean> {
    const { doc, knowledgeBase, connectorId, connectorType, log } = params;

    const contentHash = createHash("sha256").update(doc.content).digest("hex");

    // Check for existing document with the same content hash (dedup)
    const existing = await KbDocumentModel.findByContentHash({
      knowledgeBaseId: knowledgeBase.id,
      contentHash,
    });

    if (existing) {
      log.debug(
        {
          documentId: doc.id,
          knowledgeBaseId: knowledgeBase.id,
          existingDocId: existing.id,
        },
        "[ConnectorSync] Document already exists with same content hash, skipping",
      );
      return false;
    }

    // Build ACL based on knowledge base visibility
    const acl = buildDocumentAcl({
      visibility: knowledgeBase.visibility as
        | "org-wide"
        | "team-scoped"
        | "auto-sync-permissions",
      teamIds: (knowledgeBase.teamIds as string[]) ?? [],
      permissions: doc.permissions,
    });

    // Also check for existing document by source ID (update case)
    const existingBySource = await KbDocumentModel.findBySourceId({
      knowledgeBaseId: knowledgeBase.id,
      sourceType: "connector",
      sourceId: doc.id,
    });

    if (existingBySource) {
      // Content has changed — update existing document
      await KbDocumentModel.update(existingBySource.id, {
        title: doc.title,
        content: doc.content,
        contentHash,
        sourceUrl: doc.sourceUrl ?? null,
        acl,
        metadata: {
          ...doc.metadata,
          connectorType,
        },
        embeddingStatus: "pending",
      });

      // Re-chunk: content changed, so replace stale chunks
      await KbChunkModel.deleteByDocument(existingBySource.id);
      await this.chunkAndStore({
        documentId: existingBySource.id,
        title: doc.title,
        content: doc.content,
        acl,
        log,
      });

      log.debug(
        {
          documentId: doc.id,
          kbDocumentId: existingBySource.id,
          knowledgeBaseId: knowledgeBase.id,
        },
        "[ConnectorSync] Updated existing document with new content",
      );
      return true;
    }

    // Create new document
    const created = await KbDocumentModel.create({
      knowledgeBaseId: knowledgeBase.id,
      organizationId: knowledgeBase.organizationId,
      sourceType: "connector",
      sourceId: doc.id,
      connectorId,
      title: doc.title,
      content: doc.content,
      contentHash,
      sourceUrl: doc.sourceUrl,
      acl,
      metadata: {
        ...doc.metadata,
        connectorType,
      },
    });

    await this.chunkAndStore({
      documentId: created.id,
      title: doc.title,
      content: doc.content,
      acl,
      log,
    });

    log.debug(
      {
        documentId: doc.id,
        knowledgeBaseId: knowledgeBase.id,
      },
      "[ConnectorSync] Document ingested into kb_documents",
    );
    return true;
  }

  private async chunkAndStore(params: {
    documentId: string;
    title: string;
    content: string;
    acl: AclEntry[];
    log: pino.Logger;
  }): Promise<void> {
    const { documentId, title, content, acl, log } = params;

    const chunks = await chunkDocument({ title, content });

    if (chunks.length === 0) return;

    await KbChunkModel.insertMany(
      chunks.map((chunk) => ({
        documentId,
        content: chunk.content,
        chunkIndex: chunk.chunkIndex,
        acl,
      })),
    );

    log.debug(
      { documentId, chunkCount: chunks.length },
      "[ConnectorSync] Document chunked and stored",
    );
  }

  private async loadCredentials(
    secretId: string | null,
    log: pino.Logger,
  ): Promise<ConnectorCredentials> {
    if (!secretId) {
      throw new Error("Connector has no associated secret");
    }

    const secret = await secretManager().getSecret(secretId);
    if (!secret) {
      throw new Error(`Secret not found: ${secretId}`);
    }

    log.debug({ secretId }, "[ConnectorSync] Credentials loaded");

    const data = secret.secret as Record<string, unknown>;
    return {
      email: (data.email as string) || "",
      apiToken: (data.apiToken as string) || "",
    };
  }
}

export const connectorSyncService = new ConnectorSyncService();
