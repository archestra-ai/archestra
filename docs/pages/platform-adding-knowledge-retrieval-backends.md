---
title: Adding Knowledge Retrieval Backends
category: Development
order: 4
description: Developer guide for implementing a knowledge retrieval backend in Archestra Platform
lastUpdated: 2026-08-23
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

<!--
This is a development guide for adding knowledge retrieval backends to Archestra.
-->

## Overview

A retrieval backend stores and searches knowledge chunks. PostgreSQL with pgvector is the built-in implementation. It is the only runtime option shipped by Archestra.

The `KnowledgeRetrievalBackend` contract covers ingestion, embedding, search, context expansion, and deletion. PostgreSQL remains the source of truth for documents, access rules, and citations.

Adding a production backend requires four changes:

1. Implement `KnowledgeRetrievalBackend`.
2. Add one backend selector and its connection settings.
3. Register the implementation when the application starts.
4. Test indexing, retrieval, access control, and deletion.

Do not add configuration for a backend that does not exist. A selector with one valid value adds no capability.

## Use Case

Suppose a deployment already operates an OpenSearch cluster for a large document corpus. A retrieval implementation can mirror Archestra chunks into that cluster. Queries use OpenSearch ranking while PostgreSQL continues to enforce access and supply citations.

This guide uses `opensearch` as a fictional backend name. The repository does not include that implementation.

## Backend Boundary

The contract lives in `backend/src/knowledge-base/retrieval-backend.ts`.

| Method | Responsibility |
| --- | --- |
| `insertChunks` | Store canonical chunks and mirror searchable fields. |
| `getDocumentChunks` | Load chunks before embedding. |
| `countDocumentChunks` | Detect documents that require indexing. |
| `deleteDocumentChunks` | Remove old chunks before reindexing a document. |
| `indexEmbeddings` | Store vectors for one embedding dimension. |
| `vectorSearch` | Rank semantic matches. |
| `keywordSearch` | Rank keyword matches. |
| `findNeighbors` | Load adjacent chunks for context expansion. |
| `getTextSearchLanguages` | Resolve analyzers for keyword queries. |
| `hasKeywordStatistics` | Report whether BM25 statistics are ready. |
| `getPopulatedEmbeddingDimensions` | Report indexed embedding dimensions. |
| `isSearchTimeout` | Identify a backend timeout. |

Ingestion and query code call this interface. A new implementation must not add backend-specific branches to those callers.

## Implementation

Create `backend/src/knowledge-base/retrieval-backends/opensearch/opensearch-retrieval-backend.ts`. Use one subdirectory per backend, as knowledge connectors do.

```text
retrieval-backends/
├── registry.ts
├── postgres/
│   └── postgres-retrieval-backend.ts
└── opensearch/
    └── opensearch-retrieval-backend.ts
```

Use a class when the client owns connections or cached state.

```typescript
import type { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import { KbChunkModel } from "@/models";
import type { InsertKbChunk, KbChunk } from "@/types";
import type {
  FindNeighborsParams,
  KeywordSearchParams,
  KnowledgeRetrievalBackend,
  VectorSearchParams,
} from "../../retrieval-backend";

export class OpenSearchRetrievalBackend
  implements KnowledgeRetrievalBackend
{
  readonly requiresResultVerification = true;

  constructor(private readonly client: OpenSearchClient) {}

  async insertChunks(chunks: InsertKbChunk[]): Promise<KbChunk[]> {
    const stored = await KbChunkModel.insertMany(chunks);
    await this.indexChunkFields(stored);
    return stored;
  }

  async vectorSearch(params: VectorSearchParams) {
    return this.searchVectorIndex(params);
  }

  async keywordSearch(params: KeywordSearchParams) {
    return this.searchKeywordIndex(params);
  }

  async findNeighbors(params: FindNeighborsParams) {
    return this.loadNeighbors(params);
  }

  // Implement the remaining contract methods.

  private async indexChunkFields(chunks: KbChunk[]) {
    // Write stable Archestra IDs and searchable fields to the external index.
  }

  private async searchVectorIndex(params: VectorSearchParams) {
    // Apply every scope in params before ranking candidates.
  }

  private async searchKeywordIndex(params: KeywordSearchParams) {
    // Apply the same scopes as vector search.
  }

  private async loadNeighbors(params: FindNeighborsParams) {
    // Return chunks next to each anchor within the requested radius.
  }
}
```

The example omits client-specific code. Keep network retries, authentication, and index mappings inside the backend module.

## Access Control

Every search request includes these scopes:

- connector IDs;
- user ACL entries, or an explicit ACL bypass;
- an environment ID when the caller supplies one.

Apply those filters inside both search methods. This keeps inaccessible rows out of the candidate window.

Set `requiresResultVerification` to `true` for an external index. Archestra then reloads each candidate from PostgreSQL. It reapplies connector, ACL, environment, and soft-delete filters.

External results contribute only the stable chunk ID and score. PostgreSQL supplies content, metadata, and citation fields. A forged or stale external record cannot replace canonical data.

PostgreSQL uses `requiresResultVerification: false`. Its queries already apply the canonical filters.

ACL and environment changes must also reach the external index. Add synchronization hooks to those update paths before enabling the backend. Canonical verification prevents unauthorized results, but stale external filters can still hide results that a user should see.

## Identity and Citations

Store these Archestra values in the external index:

- chunk ID;
- document ID;
- chunk index;
- connector ID;
- ACL entries;
- environment identity;
- soft-delete state, when the index retains deleted records.

The chunk ID joins an external match to its PostgreSQL row. The document ID and chunk index form the model-visible citation reference.

Do not replace these values with backend-generated identities. Backend document IDs may be stored as additional fields.

## Context Expansion

`findNeighbors` receives document and chunk-index anchors. It returns adjacent chunks within the requested radius.

Neighbors must belong to the same document as their anchor. Stop at missing or inaccessible chunks. Do not stitch media chunks into text passages.

External neighbor candidates pass through PostgreSQL verification. Their content is not trusted.

## Writes and Deletes

PostgreSQL remains the canonical store. `insertChunks` must write there before or alongside the external index.

`indexEmbeddings` stores vectors in the selected search backend. Preserve the embedding dimension because one deployment can contain chunks indexed with different models.

`deleteDocumentChunks` must be idempotent. Content replacement calls it before inserting new chunks.

Whole-document deletion currently relies on PostgreSQL foreign-key cascades. Before selecting an external backend in production, add external deletion to every document lifecycle path:

- delete one document;
- delete documents removed during connector sync;
- delete every document for a connector;
- force a full connector resync.

Test partial failures between PostgreSQL and the external service. Retrying the operation must converge on the same state.

## Ranking and Timeouts

Return search results in rank order. Archestra preserves the backend score during canonical verification.

Vector and keyword search run as separate lanes. `isSearchTimeout` must recognize the client library's timeout error. A timed-out lane is dropped while other lanes continue. Other errors fail the query.

`getTextSearchLanguages` and `hasKeywordStatistics` support hybrid keyword search. Map these methods to backend analyzers and statistics. Do not silently disable the keyword lane.

## Configuration

Add runtime configuration only when the second implementation is usable. Keep selection deployment-wide.

Use one selector:

```dotenv
ARCHESTRA_KNOWLEDGE_BASE_RETRIEVAL_BACKEND=opensearch
```

The default remains `postgres`. Add backend connection settings only when the client requires them.

Follow the standard environment-variable path:

1. Parse and validate values under `config.kb` in `backend/src/config.ts`.
2. Add each variable to `platform/.env.example`.
3. Document each variable in [Deployment](/docs/platform-deployment).
4. Add parser tests to `backend/src/config.test.ts` when validation is not trivial.

Do not expose the selector through the frontend. Retrieval storage is deployment infrastructure, not a per-connector choice.

## Registration

Register the implementation in `retrieval-backends/registry.ts`. Construct one singleton from the selector. Keep the PostgreSQL object as the default.

```typescript
export const knowledgeRetrievalBackend = createKnowledgeRetrievalBackend();

function createKnowledgeRetrievalBackend(): KnowledgeRetrievalBackend {
  switch (config.kb.retrievalBackend) {
    case "opensearch":
      return new OpenSearchRetrievalBackend(createOpenSearchClient());
    case "postgres":
      return postgresKnowledgeRetrievalBackend;
  }
}
```

Keep the factory in the retrieval module. Callers continue to import the singleton or receive a backend through constructor injection.

## Testing

Run the existing query behavior suite against the new implementation. Add backend-specific tests for its client boundary.

At minimum, cover:

- chunk insertion and embedding updates;
- vector and keyword ranking;
- connector, ACL, environment, and soft-delete filters;
- canonical rehydration of content and citations;
- inaccessible and forged candidates;
- adjacent chunk lookup;
- every deletion path;
- retries after partial writes;
- timeout classification;
- mixed embedding dimensions.

Mock only the external client in unit tests. Use the real PostgreSQL test setup for canonical rows and access rules.

Run these checks from `platform/`:

```bash
pnpm --dir backend test
pnpm --dir backend type-check
pnpm --dir backend knip
(cd .. && python3 .github/scripts/check-docs-links.py)
```

## Completion Checklist

- The implementation satisfies every contract method.
- PostgreSQL retains canonical documents, ACLs, and citations.
- Search filters are pushed into the external backend.
- ACL and environment changes update the external index.
- External candidates and neighbors enable canonical verification.
- Whole-document deletion updates both stores.
- One deployment-level selector chooses the backend.
- Backend-specific variables appear in `.env.example` and deployment docs.
- Existing PostgreSQL behavior tests still pass.
- The new backend has indexing, retrieval, access, timeout, and deletion tests.
