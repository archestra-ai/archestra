import type pino from "pino";
import defaultLogger from "@/logging";
import {
  ConnectorRunModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import type { KnowledgeBase } from "@/types";
import type { ConnectorCredentials } from "@/types/knowledge-connector";
import { createKnowledgeBaseProvider } from ".";
import { getConnector } from "./connectors/registry";

/**
 * Service that orchestrates the sync of data from external connectors
 * (e.g., Jira, Confluence) into a knowledge base.
 *
 * A connector can be assigned to multiple knowledge bases. During sync,
 * documents are ingested into ALL assigned knowledge bases.
 */
class ConnectorSyncService {
  async executeSync(
    connectorId: string,
    options?: { logger?: pino.Logger; getLogOutput?: () => string },
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

    // Build KG providers for all assigned knowledge bases
    const kgProviders = knowledgeBases.map((kb) => ({
      knowledgeBase: kb,
      provider: createKnowledgeBaseProvider(kb.provider, kb.config),
    }));

    // Create a connector run record
    const run = await ConnectorRunModel.create({
      connectorId,
      status: "running",
      startedAt: new Date(),
      documentsProcessed: 0,
      documentsIngested: 0,
    });

    // Update connector lastSyncStatus to running
    await KnowledgeBaseConnectorModel.update(connectorId, {
      lastSyncStatus: "running",
    });

    let documentsProcessed = 0;
    let documentsIngested = 0;

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
          for (const { knowledgeBase, provider } of kgProviders) {
            try {
              await provider.insertDocument({
                content: doc.content,
                filename: doc.title,
                metadata: {
                  ...doc.metadata,
                  sourceUrl: doc.sourceUrl,
                  connectorId,
                  connectorType: connector.connectorType,
                  externalId: doc.id,
                },
              });
              documentsIngested++;
            } catch (docError) {
              log.warn(
                {
                  connectorId,
                  knowledgeBaseId: knowledgeBase.id,
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

        // Update run progress
        await ConnectorRunModel.update(run.id, {
          documentsProcessed,
          documentsIngested,
        });

        // Update connector checkpoint
        await KnowledgeBaseConnectorModel.update(connectorId, {
          checkpoint: batch.checkpoint,
        });
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

      log.info(
        {
          connectorId,
          runId: run.id,
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

      log.error(
        { connectorId, runId: run.id, error: errorMessage },
        "[ConnectorSync] Sync failed",
      );

      return { runId: run.id, status: "failed" };
    }
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
