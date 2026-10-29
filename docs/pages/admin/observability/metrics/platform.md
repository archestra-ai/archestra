---
title: Platform Metrics
description: Look up HTTP, database pool, audit, storage, and process metrics.
order: 8
lastUpdated: 2026-10-28
---

Track API latency, database connections, audit failures, and stored-file cleanup.

## Metrics

| Metric | Labels | Measures |
| --- | --- | --- |
| <span id="http_request_duration_seconds"></span>`http_request_duration_seconds`, <span id="http_request_summary_seconds"></span>`http_request_summary_seconds` | `method`, `route`, `status_code` | API request duration, as a histogram and as a summary with quantiles |
| <span id="database_pool_connections"></span>`database_pool_connections` | `state` | Database pool connections: `total`, `idle`, and `waiting` |
| <span id="database_pool_size_limit"></span>`database_pool_size_limit` | | Maximum pool size per process |
| <span id="audit_write_failures_total"></span>`audit_write_failures_total` | `source`, `resource_type` | Audit log rows that failed to save |
| <span id="file_storage_orphaned_objects_total"></span>`file_storage_orphaned_objects_total` | `provider`, `scope` | Stored files left behind by a failed delete |
| <span id="chat_message_feedback_total"></span>`chat_message_feedback_total` | `feedback` | Thumbs up, thumbs down, and cleared ratings on chat answers |
| `process_*`, `nodejs_*` | | Standard Node.js process metrics: CPU, memory, heap, event loop lag, and garbage collection |
