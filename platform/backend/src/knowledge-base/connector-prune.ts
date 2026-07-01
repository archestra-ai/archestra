import type pino from "pino";
import defaultLogger from "@/logging";
import {
  ConnectorRunModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
} from "@/models";
import { resolveConnectorCredentials } from "./connector-credentials";
import {
  BaseConnector,
  extractErrorMessage,
} from "./connectors/base-connector";
import { getConnector } from "./connectors/registry";

class ConnectorPruneService {
  async executePrune(
    connectorId: string,
    options?: {
      logger?: pino.Logger;
      getLogOutput?: () => string;
    },
  ): Promise<{ runId: string; status: string; prunedDocuments: number }> {
    const log = options?.logger ?? defaultLogger;
    const connector = await KnowledgeBaseConnectorModel.findById(connectorId);

    if (!connector) {
      throw new Error(`Connector not found: ${connectorId}`);
    }

    const connectorImpl = getConnector(connector.connectorType);
    if (typeof connectorImpl.listAllSourceIds !== "function") {
      throw new Error(
        `Connector type does not support pruning: ${connector.connectorType}`,
      );
    }

    const credentials = await resolveConnectorCredentials(connector);
    const run = await ConnectorRunModel.create({
      connectorId,
      status: "running",
      startedAt: new Date(),
      documentsProcessed: 0,
      documentsIngested: 0,
      prunedDocuments: 0,
    });

    const runLog = log.child({
      runId: run.id,
      connectorId,
      connectorName: connector.name,
      connectorType: connector.connectorType,
      taskType: "connector_prune",
    });

    if (connectorImpl instanceof BaseConnector) {
      connectorImpl.setLogger(runLog);
    }

    const pruneStartedAt = new Date();
    let documentsProcessed = 0;
    let prunedDocuments = 0;

    try {
      for await (const sourceIds of connectorImpl.listAllSourceIds({
        config: connector.config as Record<string, unknown>,
        credentials,
      })) {
        documentsProcessed += sourceIds.length;
        await KbDocumentModel.markSeenBySourceIds({
          connectorId,
          sourceIds,
          seenAt: pruneStartedAt,
        });

        await ConnectorRunModel.update(run.id, {
          documentsProcessed,
          prunedDocuments,
          logs: options?.getLogOutput?.() ?? null,
        });
      }

      prunedDocuments = await KbDocumentModel.deleteStaleByConnector({
        connectorId,
        staleBefore: pruneStartedAt,
      });
      const now = new Date();

      await ConnectorRunModel.update(run.id, {
        status: "success",
        completedAt: now,
        documentsProcessed,
        prunedDocuments,
        logs: options?.getLogOutput?.() ?? null,
      });
      await KnowledgeBaseConnectorModel.update(connectorId, {
        lastPruneAt: now,
      });

      runLog.info(
        { documentsProcessed, prunedDocuments },
        "Connector prune completed successfully",
      );

      return { runId: run.id, status: "success", prunedDocuments };
    } catch (error) {
      const errorMessage = extractErrorMessage(error);

      await ConnectorRunModel.update(run.id, {
        status: "failed",
        completedAt: new Date(),
        documentsProcessed,
        prunedDocuments,
        error: errorMessage,
        logs: options?.getLogOutput?.() ?? null,
      });

      runLog.error({ error: errorMessage }, "Connector prune failed");

      return { runId: run.id, status: "failed", prunedDocuments };
    }
  }
}

export const connectorPruneService = new ConnectorPruneService();