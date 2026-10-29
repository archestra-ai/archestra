---
title: Knowledge Base Metrics
description: Look up connector sync, ingestion, embedding, search, and permission metrics.
order: 5
lastUpdated: 2026-10-28
---

Track Knowledge Base ingestion and retrieval, including connector failures and permission sync gaps.

## Metrics

| Metric | Labels | Measures |
| --- | --- | --- |
| <span id="rag_connector_syncs_total"></span>`rag_connector_syncs_total`, <span id="rag_connector_sync_duration_seconds"></span>`rag_connector_sync_duration_seconds` | `connector_type`, `status` | Connector syncs (`success`, `failed`, or `partial`) and their duration |
| <span id="rag_documents_processed_total"></span>`rag_documents_processed_total`, <span id="rag_documents_ingested_total"></span>`rag_documents_ingested_total`, <span id="rag_chunks_created_total"></span>`rag_chunks_created_total` | `connector_type` | Documents read, documents added or updated, and chunks created |
| <span id="rag_documents_without_text_total"></span>`rag_documents_without_text_total` | `connector_type` | Documents skipped because they have no extractable text |
| <span id="rag_ocr_pages_total"></span>`rag_ocr_pages_total` | `connector_type`, `outcome` | Scanned PDF pages sent to OCR |
| <span id="rag_embedding_batches_total"></span>`rag_embedding_batches_total`, <span id="rag_embedding_documents_total"></span>`rag_embedding_documents_total` | `status` | Embedding batches and documents |
| <span id="rag_queries_total"></span>`rag_queries_total`, <span id="rag_query_duration_seconds"></span>`rag_query_duration_seconds`, <span id="rag_query_results_count"></span>`rag_query_results_count` | `search_type` | Searches, their end-to-end duration, and results returned |
| <span id="rag_search_lane_timeout_total"></span>`rag_search_lane_timeout_total` | `lane` | Search lanes cut by the database statement timeout |
| <span id="rag_quote_verification_total"></span>`rag_quote_verification_total` | `result` | Chat-answer quotes checked against their cited source |
| <span id="rag_permission_syncs_total"></span>`rag_permission_syncs_total` | `connector_type`, `status` | Permission sync passes |
| `rag_permission_sync_*` | `connector_type` | Permission sync gaps: group failures, dropped principals, ACL over-approximations, unreadable containers, restriction fallbacks, and skipped identity lookups |
| <span id="rag_access_token_truncations_total"></span>`rag_access_token_truncations_total` | `kind` | Users whose group memberships exceeded the per-user cap at query time |
| <span id="rag_knowledge_query_unresolved_identity_total"></span>`rag_knowledge_query_unresolved_identity_total` | | Searches limited to organization-wide documents because the caller had no email |
