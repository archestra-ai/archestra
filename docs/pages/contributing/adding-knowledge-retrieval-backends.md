---
title: Adding Knowledge Retrieval Backends
description: Add a search backend, such as an external index, that stores and ranks knowledge chunks.
order: 4
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

A retrieval backend stores knowledge chunks and runs the vector and keyword searches behind [knowledge retrieval](/docs/knowledge). PostgreSQL with pgvector is the only backend Archestra includes. A second backend can mirror chunks into a search cluster that a deployment already runs, such as OpenSearch, and rank queries there. PostgreSQL stays the source of truth for documents, access rules, and citations either way.

This page uses `opensearch` as a fictional backend name. Paths are relative to `platform/`.

## The Contract

Ingestion, query, and context-expansion code call the `KnowledgeRetrievalBackend` interface in `backend/src/knowledge-base/retrieval-backend.ts`. Never add backend-specific branches to those callers.

- `insertChunks` stores chunks and indexes their searchable fields.
- `getDocumentChunks` loads a document's chunks before embedding.
- `countDocumentChunks` reports whether a document still needs indexing.
- `deleteDocumentChunks` removes a document's chunks before it is re-indexed.
- `indexEmbeddings` stores vectors for one embedding dimension.
- `vectorSearch` ranks semantic matches.
- `keywordSearch` ranks keyword matches.
- `findNeighbors` loads adjacent chunks for context expansion.
- `findParentSiblings` loads the child chunks that make up a parent passage.
- `getTextSearchLanguages` returns the analyzer languages for keyword search.
- `hasKeywordStatistics` reports whether BM25 statistics are ready.
- `getPopulatedEmbeddingDimensions` reports which embedding dimensions have vectors.
- `isSearchTimeout` recognizes the backend's timeout error.

## Implementation

Create `backend/src/knowledge-base/retrieval-backends/opensearch/opensearch-retrieval-backend.ts`, next to the existing `postgres/` folder. Use a class when the client owns connections or cached state:

```typescript
export class OpenSearchRetrievalBackend implements KnowledgeRetrievalBackend {
  readonly requiresResultVerification = true;

  constructor(private readonly client: OpenSearchClient) {}

  async insertChunks(chunks: InsertKbChunk[]): Promise<KbChunk[]> {
    const stored = await KbChunkModel.insertMany(chunks);
    await this.indexChunkFields(stored);
    return stored;
  }

  // Implement the remaining contract methods.
}
```

Keep retries, authentication, and index mappings inside the backend module.

## Access Control

Every search request carries a scope: connector IDs, the user's ACL entries (or an explicit ACL bypass), an optional environment ID, and an optional document metadata filter. Apply all of them inside both search methods. Otherwise inaccessible chunks fill the candidate window and displace results the user can read. The metadata filter is not a security control. Ignoring it still returns documents the caller did not ask for.

Set `requiresResultVerification` to `true`. Archestra then reloads every search candidate and every neighbor chunk from PostgreSQL and re-applies the connector, ACL, environment, metadata, and deleted-connector filters. The external index contributes only the chunk ID and the score. PostgreSQL supplies the content, metadata, and citation. A stale or forged external record cannot replace them.

`findParentSiblings` results are not re-verified. Apply the ACL and environment scope inside that method.

Access rules also change after indexing. Before you enable the backend, update the external index on every change:

- Chunk ACLs change through the `UPDATE` statements on `kbChunksTable` in `backend/src/models/kb-chunk.ts`, `kb-document.ts`, and `kb-file.ts`.
- A connector's environment changes through the connector update route in `backend/src/routes/knowledge-base.ts`.

Verification stops unauthorized results. A stale external filter still hides results a user should see.

## Identity and Citations

Store these values from Archestra in the external index:

- Chunk ID, document ID, and chunk index.
- Connector ID, ACL entries, and environment.
- Deletion state, if the index keeps deleted records.

The chunk ID joins an external match to its PostgreSQL row. The document ID and chunk index form the citation the model sees. Never replace them with IDs the backend generates. You can store the backend's own IDs as extra fields.

`findNeighbors` returns chunks next to each anchor, within the requested radius and in the same document. Stop at a missing or inaccessible chunk, and never join media chunks into text passages.

## Writes and Deletes

`insertChunks` writes to PostgreSQL before or together with the external index. `indexEmbeddings` keeps the embedding dimension, because one deployment can hold chunks embedded by different models.

`deleteDocumentChunks` must be idempotent, because re-indexing calls it before inserting new chunks. Deleting a whole document removes its chunks through a PostgreSQL foreign-key cascade. The external index keeps that document's chunks. Before a production deployment selects the backend, add external deletion to each delete method of `KbDocumentModel` in `backend/src/models/kb-document.ts`. Its callers in `connector-sync.ts` and `routes/knowledge-base.ts` cover these cases:

- Deleting one document.
- Removing documents that disappeared from the source during a connector sync.
- Deleting a connector and all its documents.
- Forcing a full connector resync.

A failure between the PostgreSQL write and the external write must converge when the operation is retried.

## Ranking and Timeouts

Return search results in rank order. Verification keeps the backend's score.

Vector and keyword search run independently. When `isSearchTimeout` recognizes one search's error as a timeout, Archestra drops that search and keeps the other one's results. Any other error fails the query.

Map `getTextSearchLanguages` and `hasKeywordStatistics` to the backend's analyzers and statistics. Never turn off keyword search silently.

## Configuration and Registration

`backend/src/knowledge-base/retrieval-backends/registry.ts` exports the one backend that ingestion and queries use. Add a selector only together with a working second backend: a setting with one valid value adds nothing. Select the backend for the whole deployment, never per connector, and do not expose the choice in the UI.

When you add a second backend:

1. Parse `ARCHESTRA_KNOWLEDGE_BASE_RETRIEVAL_BACKEND` (default `postgres`) and the backend's connection settings under `kb` in `backend/src/config.ts`. Add parser tests to `backend/src/config.test.ts` when validation is not trivial.
2. Add each variable to `platform/.env.example` and to the [Configuration](/docs/reference/configuration) reference.
3. Build the backend in the registry from the selector:

```typescript
export const knowledgeRetrievalBackend = createKnowledgeRetrievalBackend();

function createKnowledgeRetrievalBackend(): KnowledgeRetrievalBackend {
  switch (config.kb.retrievalBackend) {
    case "opensearch":
      return new OpenSearchRetrievalBackend(createOpenSearchClient());
    case "postgres":
      return postgresRetrievalBackend;
  }
}
```

## Testing

Run the existing query tests against the new backend, and add tests for its client boundary. Cover:

- Chunk insertion and embedding updates.
- Vector and keyword ranking.
- Connector, ACL, environment, metadata, and deleted-connector filters.
- Rehydration of content and citations from PostgreSQL, including forged and inaccessible candidates.
- Neighbor and parent-passage lookup.
- Every deletion path, and retries after a partial write.
- Timeout classification.
- Mixed embedding dimensions.

Mock only the external client. Use the real PostgreSQL test database for chunks and access rules. Run from `platform/`:

```bash
pnpm --filter @backend test -- knowledge-base
pnpm --filter @backend type-check
pnpm --filter @backend knip
```
