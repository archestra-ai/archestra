---
title: Architecture
category: Knowledge
order: 3
description: How ingestion and querying work in the built-in RAG stack
lastUpdated: 2026-04-30
---

<!--
Check ../docs_writer_prompt.md before changing this file.

-->

The RAG stack runs entirely within PostgreSQL — no external vector database required. See [Platform Deployment — Knowledge Base Configuration](/docs/platform-deployment#knowledge-base-configuration) for full configuration reference.

## Ingestion

Connectors run on a cron schedule, pulling documents that are chunked and embedded into PostgreSQL with pgvector.

```mermaid
flowchart LR
    C[Connectors] -->|cron schedule| D[Documents]
    D --> CH[Chunking]
    CH -->|Embedding provider API| E[Embedding]
    E --> PG[(PostgreSQL + pgvector)]
```

## Querying

At runtime, the agent's query is embedded, then vector and optional full-text search run in parallel. Results are fused, reranked, and filtered before being returned.

```mermaid
flowchart LR
    Q[Agent Query] -->|Embedding provider API| QE[Query Embedding]
    QE --> VS[Vector Search]
    QE --> FTS["Full-Text Search (configurable)"]
    VS --> RRF[Reciprocal Rank Fusion]
    FTS --> RRF
    RRF --> RR[Reranking]
    RR --> ACL[ACL Filtering]
    ACL --> R[Results]
```
