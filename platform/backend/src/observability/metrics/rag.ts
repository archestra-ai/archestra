/**
 * Prometheus metrics for RAG / Knowledge Base operations:
 * connector sync, document ingestion, embedding, querying, and reranking.
 *
 * Connector sync rate:
 * rate(rag_connector_syncs_total[5m])
 *
 * Average query latency:
 * rate(rag_query_duration_seconds_sum[5m]) / rate(rag_query_duration_seconds_count[5m])
 */

import client from "prom-client";
import logger from "@/logging";
import { getExemplarLabels } from "./utils";

// ===== Connector sync metrics =====
let ragConnectorSyncDuration: client.Histogram<string>;
let ragConnectorSyncsTotal: client.Counter<string>;
let ragDocumentsProcessedTotal: client.Counter<string>;
let ragDocumentsIngestedTotal: client.Counter<string>;
let ragChunksCreatedTotal: client.Counter<string>;

// ===== Embedding metrics =====
let ragEmbeddingBatchesTotal: client.Counter<string>;
let ragEmbeddingDocumentsTotal: client.Counter<string>;

// ===== Query metrics =====
let ragQueryDuration: client.Histogram<string>;
let ragQueriesTotal: client.Counter<string>;
let ragQueryResultsCount: client.Histogram<string>;

let initialized = false;

export function initializeRagMetrics(): void {
  if (initialized) return;
  initialized = true;

  ragConnectorSyncDuration = new client.Histogram({
    name: "rag_connector_sync_duration_seconds",
    help: "Connector sync duration in seconds",
    labelNames: ["connector_type", "status"],
    buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1800],
  });

  ragConnectorSyncsTotal = new client.Counter({
    name: "rag_connector_syncs_total",
    help: "Total connector syncs",
    labelNames: ["connector_type", "status"],
  });

  ragDocumentsProcessedTotal = new client.Counter({
    name: "rag_documents_processed_total",
    help: "Total documents processed during connector syncs",
    labelNames: ["connector_type"],
  });

  ragDocumentsIngestedTotal = new client.Counter({
    name: "rag_documents_ingested_total",
    help: "Total documents ingested (new or updated) during connector syncs",
    labelNames: ["connector_type"],
  });

  ragChunksCreatedTotal = new client.Counter({
    name: "rag_chunks_created_total",
    help: "Total chunks created during document ingestion",
    labelNames: ["connector_type"],
  });

  ragEmbeddingBatchesTotal = new client.Counter({
    name: "rag_embedding_batches_total",
    help: "Total embedding batches processed",
    labelNames: ["status"],
  });

  ragEmbeddingDocumentsTotal = new client.Counter({
    name: "rag_embedding_documents_total",
    help: "Total documents embedded",
    labelNames: ["status"],
  });

  ragQueryDuration = new client.Histogram({
    name: "rag_query_duration_seconds",
    help: "RAG query duration in seconds (end-to-end including embedding, search, rerank)",
    labelNames: ["search_type"],
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    enableExemplars: true,
  });

  ragQueriesTotal = new client.Counter({
    name: "rag_queries_total",
    help: "Total RAG queries",
    labelNames: ["search_type"],
    enableExemplars: true,
  });

  ragQueryResultsCount = new client.Histogram({
    name: "rag_query_results_count",
    help: "Number of results returned per RAG query",
    labelNames: ["search_type"],
    buckets: [0, 1, 2, 5, 10, 20, 50],
    enableExemplars: true,
  });

  logger.info("RAG metrics initialized");
}

/**
 * Reports a completed connector sync with duration and outcome.
 */
export function reportConnectorSync(params: {
  connectorType: string;
  status: "success" | "failed" | "partial";
  durationSeconds: number;
  documentsProcessed: number;
  documentsIngested: number;
}): void {
  if (!ragConnectorSyncsTotal) {
    logger.warn("RAG metrics not initialized, skipping connector sync report");
    return;
  }

  const labels = {
    connector_type: params.connectorType,
    status: params.status,
  };

  ragConnectorSyncsTotal.inc(labels);
  ragConnectorSyncDuration.observe(labels, params.durationSeconds);

  if (params.documentsProcessed > 0) {
    ragDocumentsProcessedTotal.inc(
      { connector_type: params.connectorType },
      params.documentsProcessed,
    );
  }
  if (params.documentsIngested > 0) {
    ragDocumentsIngestedTotal.inc(
      { connector_type: params.connectorType },
      params.documentsIngested,
    );
  }
}

/**
 * Reports chunks created during document ingestion.
 */
export function reportChunksCreated(
  connectorType: string,
  count: number,
): void {
  if (!ragChunksCreatedTotal || count <= 0) return;
  ragChunksCreatedTotal.inc({ connector_type: connectorType }, count);
}

/**
 * Reports an embedding batch result.
 */
export function reportEmbeddingBatch(params: {
  documentCount: number;
  status: "success" | "error";
}): void {
  if (!ragEmbeddingBatchesTotal) return;

  ragEmbeddingBatchesTotal.inc({ status: params.status });
  ragEmbeddingDocumentsTotal.inc(
    { status: params.status },
    params.documentCount,
  );
}

/**
 * Reports a RAG query with duration and result count.
 */
export function reportQuery(params: {
  searchType: "vector" | "hybrid";
  durationSeconds: number;
  resultCount: number;
}): void {
  if (!ragQueriesTotal) {
    logger.warn("RAG metrics not initialized, skipping query report");
    return;
  }

  const labels = { search_type: params.searchType };
  const exemplarLabels = getExemplarLabels();

  ragQueriesTotal.inc({ labels, value: 1, exemplarLabels });
  ragQueryDuration.observe({
    labels,
    value: params.durationSeconds,
    exemplarLabels,
  });
  ragQueryResultsCount.observe({
    labels,
    value: params.resultCount,
    exemplarLabels,
  });
}
