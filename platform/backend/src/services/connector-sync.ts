import type pino from "pino";
import { getConnector } from "@/connectors/registry";
import { createKnowledgeGraphProvider } from "@/knowledge-graph";
import defaultLogger from "@/logging";
import {
  ConnectorRunModel,
  KnowledgeGraphConnectorModel,
  KnowledgeGraphModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import type { KnowledgeGraphConfig } from "@/types";
import type { ConnectorCredentials } from "@/types/knowledge-connector";

/**
 * Service that orchestrates the sync of data from external connectors
 * (e.g., Jira, Confluence) into a knowledge graph.
 */
class ConnectorSyncService {
  async executeSync(
    connectorId: string,
    options?: { logger?: pino.Logger; getLogOutput?: () => string },
  ): Promise<{ runId: string; status: string }> {
    const log = options?.logger ?? defaultLogger;

    const connector = await KnowledgeGraphConnectorModel.findById(connectorId);
    if (!connector) {
      throw new Error(`Connector not found: ${connectorId}`);
    }

    const knowledgeGraph = await KnowledgeGraphModel.findById(
      connector.knowledgeGraphId,
    );
    if (!knowledgeGraph) {
      throw new Error(
        `Knowledge graph not found: ${connector.knowledgeGraphId}`,
      );
    }

    // Load credentials from secrets manager
    const credentials = await this.loadCredentials(connector.secretId, log);

    // Get the connector implementation
    const connectorImpl = getConnector(connector.connectorType);

    // Build the KG provider for document ingestion
    const kgConfig: KnowledgeGraphConfig = {
      provider: knowledgeGraph.provider as KnowledgeGraphConfig["provider"],
      lightrag:
        knowledgeGraph.provider === "lightrag"
          ? (knowledgeGraph.config as KnowledgeGraphConfig["lightrag"])
          : undefined,
    };

    const kgProvider = createKnowledgeGraphProvider(
      knowledgeGraph.provider as NonNullable<KnowledgeGraphConfig["provider"]>,
      kgConfig,
    );

    // Create a connector run record
    const run = await ConnectorRunModel.create({
      connectorId,
      status: "running",
      startedAt: new Date(),
      documentsProcessed: 0,
      documentsIngested: 0,
    });

    // Update connector lastSyncStatus to running
    await KnowledgeGraphConnectorModel.update(connectorId, {
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
          try {
            await kgProvider.insertDocument({
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
                documentId: doc.id,
                error:
                  docError instanceof Error
                    ? docError.message
                    : String(docError),
              },
              "[ConnectorSync] Failed to ingest document",
            );
          }
        }

        // Update run progress
        await ConnectorRunModel.update(run.id, {
          documentsProcessed,
          documentsIngested,
        });

        // Update connector checkpoint
        await KnowledgeGraphConnectorModel.update(connectorId, {
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

      await KnowledgeGraphConnectorModel.update(connectorId, {
        lastSyncStatus: "success",
        lastSyncAt: now,
        lastSyncError: null,
      });

      log.info(
        { connectorId, runId: run.id, documentsProcessed, documentsIngested },
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

      await KnowledgeGraphConnectorModel.update(connectorId, {
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
