---
title: Overview
category: Knowledge
order: 1
description: Built-in RAG with pgvector for document ingestion, hybrid search, and retrieval
lastUpdated: 2026-03-31
---

<!--
Check ../docs_writer_prompt.md before changing this file.

-->

Knowledge bases provide built-in retrieval augmented generation (RAG) powered by PostgreSQL and pgvector. Connectors sync data from external tools into knowledge bases, where documents are chunked, embedded, and indexed for hybrid search. Agents automatically query their assigned knowledge sources at runtime.

> **Enterprise feature.** Knowledge bases require an enterprise license. Contact sales@archestra.ai for licensing information.

## Architecture

The RAG stack runs entirely within PostgreSQL — no external vector database required. See [Platform Deployment — Knowledge Base Configuration](/docs/platform-deployment#knowledge-base-configuration) for full configuration reference.

### Ingestion

Connectors run on a cron schedule, pulling documents that are chunked and embedded into PostgreSQL with pgvector.

```mermaid
flowchart LR
    C[Connectors] -->|cron schedule| D[Documents]
    D --> CH[Chunking]
    CH -->|Embedding provider API| E[Embedding]
    E --> PG[(PostgreSQL + pgvector)]
```

### Querying

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

## Knowledge Settings

Embedding and reranking are configured in **Settings > Knowledge** by selecting existing LLM Provider Keys. Both must be configured before knowledge bases and connectors can be used.

### Embedding

The embedding model can be any synced model with embedding dimensions configured in **LLM Providers > Models**. The selected API key must expose at least one such model.

The embedding model is locked after it has been saved. Changing it requires dropping the embedding configuration and re-embedding documents.

### Reranking

The reranker uses an LLM to score and reorder search results by relevance. Any synced chat model can be used. In practice, the model should support structured output.

## Connectors

Connectors pull data from external tools (Jira, Confluence, etc.) on a schedule. Each connector tracks a checkpoint for incremental sync -- only changes since the last run are processed. A connector can be assigned to multiple knowledge bases.

See [Knowledge Connectors](/docs/platform-knowledge-connectors) for supported connector types, configuration, and management.

### Sync Behavior

Connector sync has two simple phases:

1. **Ingestion**: pull new or changed source documents and chunk them.
2. **Embedding**: generate vectors for those chunks so the content becomes searchable.

Syncs can start on schedule or manually. Archestra prevents overlapping runs for the same connector, keeps an incremental checkpoint, and resumes large syncs from the last saved position instead of starting over.

In practice this means:

- new documents are inserted, chunked, and embedded
- unchanged documents are skipped
- changed documents are reprocessed so search stays current
- large syncs can continue over multiple runs without losing progress

Use **Force Re-sync** when you want to clear the checkpoint and rebuild the indexed content from the beginning.

## Assigning Knowledge Bases

Knowledge bases can be assigned to Agents and MCP Gateways. An Agent can have multiple knowledge bases, and a knowledge base can be shared across agents.

### Visibility Modes

| Mode                      | Behavior                                                        |
| ------------------------- | --------------------------------------------------------------- |
| **Org-wide**              | All documents accessible to all users in the organization       |
| **Team-scoped**           | Documents accessible only to members of the assigned teams      |
| **Auto-sync permissions** | ACL entries synced from the source system (user emails, groups). *Coming soon — see [#3218](https://github.com/archestra-ai/archestra/issues/3218).* |
