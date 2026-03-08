---
title: Overview
category: Knowledge
order: 1
description: Built-in RAG with pgvector for document ingestion, hybrid search, and retrieval
lastUpdated: 2026-03-06
---

<!--
Check ../docs_writer_prompt.md before changing this file.

-->

Knowledge bases provide built-in retrieval augmented generation (RAG) powered by PostgreSQL and pgvector. Connectors sync data from external tools into knowledge bases, where documents are chunked, embedded, and indexed for hybrid search. Agents query their assigned knowledge bases at runtime via the `query_knowledge_base` tool.

> **Enterprise feature.** Knowledge bases require an enterprise license. Contact sales@archestra.ai for licensing information.

## Architecture

The RAG stack runs entirely within PostgreSQL with zero external dependencies:

- **Hybrid search** -- Combines dense vector similarity (pgvector) with BM-25 full-text search via Reciprocal Rank Fusion for high-quality retrieval
- **Access control** -- Per-document ACL filtering ensures users only see documents they have access to
- **Async embedding** -- Documents are chunked and embedded in the background using OpenAI-compatible embedding models

### Ingestion Pipeline

1. Connectors fetch documents from external sources on a cron schedule
2. Documents are split into chunks using a token-based splitter
3. Chunks are embedded asynchronously and indexed for retrieval

## Assigning Knowledge Bases

Knowledge bases can be assigned to both Agents and MCP Gateways. The relationship is many-to-many -- an agent can have multiple knowledge bases, and a knowledge base can be shared across agents.

Assign knowledge bases in the agent or MCP gateway dialog under the "Knowledge Base" section. Once assigned, the `query_knowledge_base` tool becomes available.

### Visibility Modes

| Mode                      | Behavior                                                        |
| ------------------------- | --------------------------------------------------------------- |
| **Org-wide**              | All documents accessible to all users in the organization       |
| **Team-scoped**           | Documents accessible only to members of the assigned teams      |
| **Auto-sync permissions** | ACL entries synced from the source system (user emails, groups) |

## Connectors

Connectors pull data from external tools (Jira, Confluence, etc.) on a cron schedule. Each connector tracks a checkpoint for incremental sync -- only changes since the last run are processed. A connector can be assigned to multiple knowledge bases.

See [Knowledge Connectors](/docs/platform-knowledge-connectors) for supported connector types, configuration, and management.

## Environment Variables

| Variable                                                   | Required | Description                                                            |
| ---------------------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `ARCHESTRA_KNOWLEDGE_BASE_EMBEDDING_API_KEY`               | Yes      | API key for generating text embeddings (OpenAI-compatible endpoint)    |
| `ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_K8S_CRONJOB_NAMESPACE` | No       | K8s namespace for connector CronJobs (default: Helm release namespace) |

See [Platform Deployment](/docs/platform-deployment) for the full environment variable reference.
