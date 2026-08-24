# Knowledge Retrieval Backends

The retrieval backend separates the knowledge query pipeline from its search
index. PostgreSQL with pgvector is the built-in implementation and the only
runtime option shipped by Archestra.

There is no retrieval-backend environment variable yet. A selector with one
valid value adds configuration without adding a capability. When another
production implementation ships, add one enum setting under `config.kb`, one
matching `ARCHESTRA_KNOWLEDGE_BASE_*` variable, and one factory switch where the
singleton is constructed.

## Contract

`KnowledgeRetrievalBackend` in `retrieval-backend.ts` covers the operations used
outside the PostgreSQL model:

| Operation | Purpose |
| --- | --- |
| `insertChunks` | Store chunk text, position, keyword metadata, and ACLs. |
| `getDocumentChunks` | Load chunks for embedding. |
| `countDocumentChunks` | Detect documents that need re-embedding. |
| `deleteDocumentChunks` | Remove an old index before replacing document content. |
| `indexEmbeddings` | Write vectors for one supported dimension. |
| `vectorSearch` | Rank semantic matches. |
| `keywordSearch` | Rank keyword matches. |
| `findNeighbors` | Fetch adjacent chunks for context expansion. |
| `getTextSearchLanguages` | Resolve the keyword analyzers used by a query. |
| `hasKeywordStatistics` | Decide whether BM25 statistics are ready. |
| `getPopulatedEmbeddingDimensions` | Diagnose an embedding-dimension mismatch. |
| `isSearchTimeout` | Classify a backend timeout for lane-level degradation. |

Ingestion, embedding, querying, and context expansion call this contract. The
PostgreSQL object delegates to `KbChunkModel`, which keeps the current behavior.
Implementations live under `retrieval-backends/<name>/`. The registry at
`retrieval-backends/registry.ts` constructs the application singleton.
`QueryService` accepts a backend in its constructor.

## Required Guarantees

### Access Control

Every search and neighbor request includes these scopes:

- connector IDs;
- the user's ACL tokens, or an explicit ACL bypass;
- the environment ID when the caller supplies one.

An external backend must push these filters into its query. This preserves the
requested result count and avoids filling the candidate window with inaccessible
rows.

External filtering is not trusted. Set `requiresResultVerification` to `true`.
Archestra then reloads each candidate from PostgreSQL and reapplies the ACL,
connector, environment, and soft-delete predicates. It keeps only the external
score and stable chunk ID. Content, document metadata, and citation fields come
from PostgreSQL. Neighbor candidates go through the same canonical check.

PostgreSQL sets `requiresResultVerification` to `false` because its search
statements already apply those predicates directly.

### Identity and Citations

Each result must preserve its chunk ID, document ID, and chunk index. The chunk
ID is the join key for external-result verification. The document ID and chunk
index form the model-visible citation reference.

Do not use a backend-generated document identity. Store Archestra's IDs in the
external index.

### Context Expansion

`findNeighbors` returns chunks from the same document around an anchor index.
It must stop at missing or inaccessible chunks. External neighbor content is
reloaded from PostgreSQL before passages are stitched together.

Media chunks are never stitched into text passages.

### Ranking and Timeouts

Search methods return rows in rank order. Verification preserves that order and
the backend score. Vector and keyword lanes run independently. A backend timeout
must be recognized by `isSearchTimeout`; the query service drops that lane and
uses the other one. Other errors fail the query.

### Writes and Deletes

PostgreSQL remains the canonical document and ACL store. An external
implementation can mirror chunks into its index during `insertChunks` and add
vectors during `indexEmbeddings`.

`deleteDocumentChunks` must be idempotent. It runs before changed content is
re-chunked. Deleting a whole document removes its PostgreSQL chunks by foreign-key
cascade. An external implementation also needs a deletion hook for those
document lifecycle paths before it can be selected in production.

## Adding an Implementation

1. Create `retrieval-backends/<name>/<name>-retrieval-backend.ts`.
2. Implement every `KnowledgeRetrievalBackend` method.
3. Keep PostgreSQL as the canonical document, ACL, and citation store.
4. Set `requiresResultVerification` to `true`.
5. Push connector, ACL, and environment filters into both search methods.
6. Store Archestra chunk and document identities in the external index.
7. Normalize timeout detection through `isSearchTimeout`.
8. Add the document-deletion lifecycle hook described above.
9. Register the implementation in `retrieval-backends/registry.ts`.
10. Run the query behavior suite against the implementation.
11. Add backend-specific tests for indexing, deletion, filtering, and timeout
   behavior.

`query.test.ts` includes an alternate backend that returns forged fields and an
inaccessible row. The test proves that ACL verification, canonical citations,
and context expansion do not depend on PostgreSQL ranking.
