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

// ===== Permission-sync metrics (auto-sync-permissions connectors) =====
let ragPermissionSyncsTotal: client.Counter<string>;
let ragPermissionSyncGroupFailuresTotal: client.Counter<string>;
let ragPermissionSyncDroppedPrincipalsTotal: client.Counter<string>;
let ragPermissionSyncAclOverApproximationsTotal: client.Counter<string>;
let ragPermissionSyncContainerAudienceFailuresTotal: client.Counter<string>;
let ragPermissionSyncRestrictionFallbacksTotal: client.Counter<string>;
let ragPermissionSyncIdentityLookupsSkippedTotal: client.Counter<string>;
let ragAccessTokenTruncationsTotal: client.Counter<string>;
let ragKnowledgeQueryUnresolvedIdentityTotal: client.Counter<string>;

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

  ragPermissionSyncsTotal = new client.Counter({
    name: "rag_permission_syncs_total",
    help: "Total permission-sync passes for auto-sync-permissions connectors",
    labelNames: ["connector_type", "status"],
  });

  ragPermissionSyncGroupFailuresTotal = new client.Counter({
    name: "rag_permission_sync_group_failures_total",
    help: "Permission-sync group-enumeration failures (group step failed but the document reconcile still ran)",
    labelNames: ["connector_type"],
  });

  ragPermissionSyncDroppedPrincipalsTotal = new client.Counter({
    name: "rag_permission_sync_dropped_principals_total",
    help: "Upstream principals dropped during permission sync (fail-closed under-grant), e.g. no resolvable email — a coverage gap admins should see",
    labelNames: ["connector_type", "reason"],
  });

  ragPermissionSyncAclOverApproximationsTotal = new client.Counter({
    name: "rag_permission_sync_acl_over_approximations_total",
    help: "Documents whose ACL exceeded the per-document entry cap and was over-approximated to org:* (over-grant) during permission sync",
    labelNames: ["connector_type"],
  });

  ragPermissionSyncContainerAudienceFailuresTotal = new client.Counter({
    name: "rag_permission_sync_container_audience_failures_total",
    help: "Permission containers (project/space/repo/restriction) whose upstream permissions could not be read, so every document in them is fail-closed for the pass — the 'why can nobody see this project?' signal",
    labelNames: ["connector_type"],
  });

  ragPermissionSyncRestrictionFallbacksTotal = new client.Counter({
    name: "rag_permission_sync_restriction_fallbacks_total",
    help: "Confluence pages whose read restrictions could not be taken from the inline search expansion and needed a per-content API call (reason: truncated list, unsupported expand, or an ancestor outside the corpus)",
    labelNames: ["connector_type", "reason"],
  });

  ragPermissionSyncIdentityLookupsSkippedTotal = new client.Counter({
    name: "rag_permission_sync_identity_lookups_skipped_total",
    help: "Upstream identity lookups skipped because the credential's API rate-limit budget fell below the reserve — the audience under-grants rather than exhausting the token",
    labelNames: ["connector_type"],
  });

  ragAccessTokenTruncationsTotal = new client.Counter({
    name: "rag_access_token_truncations_total",
    help: "Query-time ACL token resolutions truncated at the per-user cap (fail-closed under-grant): a user in more groups/containers than the cap loses access to documents they are entitled to",
    labelNames: ["kind"],
  });

  ragKnowledgeQueryUnresolvedIdentityTotal = new client.Counter({
    name: "rag_knowledge_query_unresolved_identity_total",
    help: "query_knowledge_sources calls where the caller's identity could not be resolved to an email, so only org-wide chunks were returned (fail-closed)",
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
 * Reports a completed permission-sync pass for an auto-sync-permissions
 * connector (docs scanned / ACLs changed / fail-closed for dashboards).
 * `partial` = the pass threw mid-reconcile but kept a resumable checkpoint;
 * `failed` = the pass died without even reaching that handling (an error
 * escaped the claimed run entirely), so nothing about it is resumable.
 */
export function reportPermissionSync(params: {
  connectorType: string;
  status: "success" | "partial" | "failed";
}): void {
  if (!ragPermissionSyncsTotal) return;
  ragPermissionSyncsTotal.inc({
    connector_type: params.connectorType,
    status: params.status,
  });
}

/**
 * Reports a document whose explicit ACL blew the per-document entry cap and was
 * over-approximated to `org:*` — a deliberate over-GRANT (the whole org can see
 * the document), so it must never fire silently.
 */
export function reportPermissionSyncAclOverApproximation(
  connectorType: string,
): void {
  if (!ragPermissionSyncAclOverApproximationsTotal) return;
  ragPermissionSyncAclOverApproximationsTotal.inc({
    connector_type: connectorType,
  });
}

/**
 * Reports that a permission-sync pass's group-enumeration step failed. The
 * document reconcile still runs (per-step failure isolation), but group-based
 * grants may be stale — surfaced so admins see the coverage gap.
 */
export function reportPermissionSyncGroupFailure(connectorType: string): void {
  if (!ragPermissionSyncGroupFailuresTotal) return;
  ragPermissionSyncGroupFailuresTotal.inc({ connector_type: connectorType });
}

/**
 * Reports upstream principals dropped during permission sync (fail-closed
 * under-grant) — e.g. an audience member whose email could not be resolved.
 */
export function reportPermissionSyncDroppedPrincipals(params: {
  connectorType: string;
  reason: "no_email";
  count: number;
}): void {
  if (!ragPermissionSyncDroppedPrincipalsTotal || params.count <= 0) return;
  ragPermissionSyncDroppedPrincipalsTotal.inc(
    { connector_type: params.connectorType, reason: params.reason },
    params.count,
  );
}

/**
 * Reports permission containers whose upstream permissions could not be read.
 * Their documents are fail-closed for the pass, which looks exactly like a
 * container nobody is granted — so an admin asking "why can nobody see this
 * project?" needs this to be visible rather than buried in a warn log.
 */
export function reportPermissionSyncContainerAudienceFailures(params: {
  connectorType: string;
  count: number;
}): void {
  if (!ragPermissionSyncContainerAudienceFailuresTotal || params.count <= 0) {
    return;
  }
  ragPermissionSyncContainerAudienceFailuresTotal.inc(
    { connector_type: params.connectorType },
    params.count,
  );
}

/**
 * Reports Confluence pages whose read restrictions had to come from a
 * per-content API call because the inline search expansion was unusable. The
 * inline expansion is what makes a pass cost one request per RESULT PAGE
 * instead of one per document, so a rising rate here is a large space quietly
 * reverting to per-page request storms.
 */
export function reportPermissionSyncRestrictionFallbacks(params: {
  connectorType: string;
  reason: "truncated" | "expand_unsupported" | "ancestor_outside_corpus";
  count: number;
}): void {
  if (!ragPermissionSyncRestrictionFallbacksTotal || params.count <= 0) return;
  ragPermissionSyncRestrictionFallbacksTotal.inc(
    { connector_type: params.connectorType, reason: params.reason },
    params.count,
  );
}

/**
 * Reports identity lookups the pass declined to make because the credential's
 * remaining API rate-limit budget fell below the reserve. The affected
 * principals drop out of the audience (fail-closed under-grant) instead of the
 * pass burning the token's whole hourly budget — which would take the content
 * sync down with it.
 */
export function reportPermissionSyncIdentityLookupsSkipped(params: {
  connectorType: string;
  count: number;
}): void {
  if (!ragPermissionSyncIdentityLookupsSkippedTotal || params.count <= 0) {
    return;
  }
  ragPermissionSyncIdentityLookupsSkippedTotal.inc(
    { connector_type: params.connectorType },
    params.count,
  );
}

/**
 * Reports a query-time token resolution truncated at the per-user cap. The
 * truncation under-grants (fail-closed), so it never leaks a document — but the
 * user silently loses access to documents they ARE entitled to, which is
 * invisible to them and to admins without this.
 */
export function reportAccessTokenTruncation(params: {
  kind: "group" | "container";
}): void {
  if (!ragAccessTokenTruncationsTotal) return;
  ragAccessTokenTruncationsTotal.inc({ kind: params.kind });
}

/**
 * Reports a `query_knowledge_sources` call whose caller had no resolvable
 * email, so only `org:*` chunks were returned (fail-closed): the caller sees
 * neither `user_email:`- nor `group:`-scoped documents.
 */
export function reportKnowledgeQueryUnresolvedIdentity(): void {
  if (!ragKnowledgeQueryUnresolvedIdentityTotal) return;
  ragKnowledgeQueryUnresolvedIdentityTotal.inc();
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
