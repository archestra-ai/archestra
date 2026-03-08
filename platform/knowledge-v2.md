# Knowledge Base v2: Built-in pgvector RAG

> Design document for replacing the current "bring your own RAG provider" (LightRAG) architecture with an opinionated, built-in RAG stack using pgvector. Knowledge Bases are an enterprise feature gated by `ARCHESTRA_ENTERPRISE_LICENSE_KNOWLEDGE_BASE_ACTIVATED`.

---

## Implementation Progress

### Section 3: Enterprise Feature Flag

- ✅ Restructure `GET /api/config` — `enterpriseFeatures: { core, knowledgeBase }` (merged via config cleanup PR #3159)
- ✅ `useEnterpriseFeature()` hook reads from backend `/api/config` response
- ✅ Conditional sidebar visibility — Knowledge Base section gated by `useEnterpriseFeature("knowledgeBase")`
- ✅ Settings tab visibility — `/settings/knowledge` tab gated by `useEnterpriseFeature("knowledgeBase")`
- ⬜ Remove `NEXT_PUBLIC_ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED` from frontend (deferred — colleague's white-labeling branch)

### Section 4: Embedding Configuration

- ✅ `/settings/knowledge` page — embedding model selector (3-small, 3-large, ada-002) with save/cancel
- ✅ `embeddingModel` column on organization table with `.$type<EmbeddingModel>()`
- ✅ `EmbeddingModelSchema` + `UpdateOrganizationSchema` extended with `embeddingModel`
- ⬜ `ARCHESTRA_KNOWLEDGE_BASE_EMBEDDING_API_KEY` env var — dedicated embedding API key (not yet wired)

### Section 5: Database Schema

- ✅ `kb_documents` table — source-of-truth with content hash, ACL JSONB, embedding status, source metadata
- ✅ `kb_chunks` table — pgvector `vector(1536)`, tsvector generated column, HNSW index
- ✅ `agent_connector_assignments` table — direct agent-to-connector assignment
- ✅ Drizzle migration (`0164_shallow_doctor_doom.sql`)
- ✅ pgvector extension granted in dev postgres initdb
- ✅ Drizzle-zod types and CRUD models (`kb-document.ts`, `kb-chunk.ts`)

### Section 6: Chunking & Embedding

- ✅ Chunker (`backend/src/knowledge-base/chunker.ts`) — token-aware recursive splitting with tests
- ✅ Embedder (`backend/src/knowledge-base/embedder.ts`) — OpenAI embedding with batching, tests
- ⬜ Wire embedder to use organization's `embeddingModel` setting
- ⬜ Wire embedder to use `ARCHESTRA_KNOWLEDGE_BASE_EMBEDDING_API_KEY` env var

### Section 7: Ingestion Pipeline

- ✅ Connector sync refactored — connectors ingest into `kb_documents` directly (removed LightRAG delegation)
- ✅ Jira connector
- ✅ Confluence connector
- ✅ GitHub connector
- ✅ GitLab connector
- ⬜ SharePoint connector
- ⬜ Chat file upload → `kb_documents` ingestion

### Section 8: Query Pipeline

- ✅ Hybrid search with RRF (`backend/src/knowledge-base/query.ts`) — vector + full-text with tests
- ⬜ ACL filtering via `?|` operator on GIN-indexed JSONB
- ⬜ Visibility modes (org-wide, team-scoped, auto-sync)

### Section 9: Access Control

- ⬜ ACL format (namespaced string arrays in JSONB)
- ⬜ Connector permission extraction interface
- ⬜ Connector permission sync

### Section 10: Citations

- ✅ Structured chunk results with source metadata
- ✅ MCP tool `archestra__query_knowledge_base` returns citation metadata
- ✅ Frontend citation UI (replace mock data)

### Section 11: Migration Path

- ✅ Phase 1: Infrastructure — tables, pgvector extension, models
- ✅ Phase 2: Core RAG — chunker, embedder, query, connector refactor
- ✅ Phase 3: New connectors (SharePoint, GitHub, GitLab)
- ✅ Phase 4: Agent association — wire MCP tool, citations
- ✅ Phase 5: Cleanup — remove LightRAG provider code

### Section 12: Documentation

- ✅ New docs pages (knowledge base config, connectors)
- ✅ Updates to existing docs (platform deployment env vars)

---

## 1. Current State

### Provider Architecture

The knowledge base system uses a **provider factory pattern** that delegates all RAG operations to an external service:

- **`backend/src/knowledge-base/index.ts`** — Factory function `createKnowledgeBaseProvider()` that instantiates providers based on `KnowledgeBaseProviderType`. Currently only supports `"lightrag"`.
- **`backend/src/knowledge-base/lightrag-provider.ts`** — `LightRAGProvider` class implementing `KnowledgeBaseProvider` interface. Proxies `insertDocument()` and `queryDocument()` calls to an external LightRAG HTTP API (`POST /documents/text`, `POST /query`).
- **`backend/src/types/knowledge-base.ts`** — Defines `KnowledgeBaseProvider` interface with `insertDocument`, `queryDocument`, `getHealth`, `initialize`, `cleanup` methods. Query modes: `local`, `global`, `hybrid`, `naive`.

### Connector Architecture

Connectors pull data from external sources and ingest into knowledge bases via the provider:

- **`backend/src/knowledge-base/connectors/base-connector.ts`** — `BaseConnector` abstract class with `fetchWithRetry`, rate limiting, exponential backoff. Implements `Connector` interface.
- **`backend/src/knowledge-base/connectors/jira/jira-connector.ts`** — Jira connector (issues + comments via REST API).
- **`backend/src/knowledge-base/connectors/confluence/confluence-connector.ts`** — Confluence connector (pages via REST API).
- **`backend/src/knowledge-base/connectors/registry.ts`** — Connector registry mapping `ConnectorType` to implementations.
- **`backend/src/knowledge-base/connector-sync.ts`** — `ConnectorSyncService` orchestrates sync: loads credentials from secrets manager, iterates connector's async generator of `ConnectorSyncBatch`, calls `provider.insertDocument()` for each document into all assigned knowledge bases.

### Chat File Upload

- **`backend/src/knowledge-base/chat-document-extractor.ts`** — `extractAndIngestDocuments()` processes file attachments from chat messages. Extracts text from base64 data URLs, validates MIME type/extension/size, ingests into the agent's assigned knowledge base via `provider.insertDocument()`. Fire-and-forget with concurrency limit of 3.
- **`backend/src/knowledge-base/constants.ts`** — `SUPPORTED_DOCUMENT_TYPES` (22 MIME types), `SUPPORTED_EXTENSIONS` (31 extensions), `MAX_DOCUMENT_SIZE_BYTES` (10MB), `MAX_CONCURRENT_INGESTIONS` (3).

### Database Schema

**`knowledge_bases`** table (`backend/src/database/schemas/knowledge-base.ts`):

| Column            | Type        | Notes                                                     |
| ----------------- | ----------- | --------------------------------------------------------- | ------------- | ------------------------ |
| `id`              | `uuid`      | PK                                                        |
| `organization_id` | `text`      |                                                           |
| `name`            | `text`      |                                                           |
| `description`     | `text`      | nullable                                                  |
| `provider`        | `text`      | `KnowledgeBaseProviderType` — currently only `"lightrag"` |
| `config`          | `jsonb`     | `LightragConfig` — `{ apiUrl, apiKey? }`                  |
| `secret_id`       | `uuid`      | FK to `secrets`                                           |
| `visibility`      | `text`      | `"org-wide"                                               | "team-scoped" | "auto-sync-permissions"` |
| `team_ids`        | `jsonb`     | `string[]`                                                |
| `status`          | `text`      | default `"active"`                                        |
| `created_at`      | `timestamp` |                                                           |
| `updated_at`      | `timestamp` |                                                           |

**`knowledge_base_connectors`** table (`backend/src/database/schemas/knowledge-base-connector.ts`):

| Column             | Type        | Notes                                              |
| ------------------ | ----------- | -------------------------------------------------- | ------------- |
| `id`               | `uuid`      | PK                                                 |
| `organization_id`  | `text`      |                                                    |
| `name`             | `text`      |                                                    |
| `connector_type`   | `text`      | `"jira"                                            | "confluence"` |
| `config`           | `jsonb`     | Discriminated union by `type`                      |
| `secret_id`        | `uuid`      | FK to `secrets`                                    |
| `schedule`         | `text`      | Cron expression, default `"0 */6 * * *"`           |
| `enabled`          | `boolean`   |                                                    |
| `last_sync_at`     | `timestamp` |                                                    |
| `last_sync_status` | `text`      |                                                    |
| `last_sync_error`  | `text`      |                                                    |
| `checkpoint`       | `jsonb`     | Connector-specific checkpoint for incremental sync |
| `created_at`       | `timestamp` |                                                    |
| `updated_at`       | `timestamp` |                                                    |

**`knowledge_base_connector_assignment`** — Junction table (M:N between KBs and connectors).

**Agent FK** — `agents.knowledge_base_id` (`backend/src/database/schemas/agent.ts:109`) references `knowledge_bases.id` with `onDelete: "set null"`.

### Citation UI

- **`frontend/src/components/chat/knowledge-graph-citations.tsx`** — Currently renders **hardcoded mock citations** (`MOCK_CITATIONS` array with Jira/Confluence links). `hasKnowledgeBaseToolCall()` detects `query_knowledge_base` tool usage to conditionally show citations. No real citation data flows from the backend.

### Key Problems

1. **External dependency** — Requires deploying and managing a separate LightRAG service.
2. **No chunking/embedding control** — LightRAG handles all text processing opaquely.
3. **No citation support** — LightRAG's `POST /query` returns a synthesized answer string with no source references.
4. **No file storage** — Chat file uploads are extracted to text and sent to LightRAG; the original file is discarded.
5. **Mock citations** — The frontend citation UI is non-functional.

---

## 2. Proposed Architecture

**Clean break with LightRAG.** Replace the LightRAG delegation model entirely with a **built-in RAG stack** that runs within PostgreSQL using pgvector. No dual-write migration — LightRAG usage is minimal and can be dropped.

```
                    ┌─────────────────────────────┐
                    │        Query Pipeline        │
                    │  (Single CTE SQL query)      │
                    │  vector search + BM-25 FTS   │
                    │  → RRF fusion → ACL filter   │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │     PostgreSQL + pgvector    │
                    │                             │
                    │  kb_documents    kb_chunks   │
                    │  knowledge_bases (existing)  │
                    └──────────▲──────────────────┘
                               │
              ┌────────────────┤
              │                │
    ┌─────────▼──┐   ┌────────▼───┐
    │ Connectors │   │  API       │
    │ Jira/Conf/ │   │  (future)  │
    │ SP/GH/GL   │
    └────────────┘   └────────────┘
```

**Design principles:**

- **Zero external dependencies** — Everything in PostgreSQL. No Elasticsearch, Pinecone, Vespa, or standalone vector DB.
- **Hybrid search** — Combine dense vector similarity (pgvector HNSW) with sparse BM-25 full-text search (tsvector/tsquery) via Reciprocal Rank Fusion.
- **First-class citations** — Every chunk carries source metadata (title, URL, source type). The LLM receives chunks directly and synthesizes an answer with attributable sources.
- **Enterprise feature** — Gated behind `ARCHESTRA_ENTERPRISE_LICENSE_KNOWLEDGE_BASE_ACTIVATED`. Sidebar section, settings tab, and routes only visible/accessible when enabled.
- **Opinionated embedding** — Small curated list of recommended embedding models. Advanced config via env vars.

---

## 3. Enterprise Feature Flag

### 3.1 Restructure `GET /api/config`

Replace the flat `NEXT_PUBLIC_ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED` env var usage with a nested `enterpriseFeatures` object returned by `GET /api/config`:

**Backend changes (`backend/src/routes/config.ts`):**

Add `enterpriseFeatures` to the response schema:

```typescript
enterpriseFeatures: z.strictObject({
  core: z.boolean(),           // existing ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED
  knowledgeBase: z.boolean(),  // new ARCHESTRA_ENTERPRISE_LICENSE_KNOWLEDGE_BASE_ACTIVATED
}),
```

Response:

```json
{
  "features": { ... },
  "enterpriseFeatures": {
    "core": true,
    "knowledgeBase": true
  },
  "providerBaseUrls": { ... }
}
```

**Backend changes (`backend/src/config.ts`):**

```typescript
enterpriseFeatures: {
  core: process.env.ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED === "true",
  knowledgeBase: process.env.ARCHESTRA_ENTERPRISE_LICENSE_KNOWLEDGE_BASE_ACTIVATED === "true",
},
```

### 3.2 Remove `NEXT_PUBLIC_ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED`

- Remove from `frontend/src/lib/config.ts` (`enterpriseLicenseActivated` getter)
- Remove from `Dockerfile` (supervisord `environment=` line)
- Replace all frontend usages with `useEnterpriseFeature("core")` hook (reads from `/api/config` response)

**New hook (`frontend/src/lib/enterprise-features.hook.ts`):**

```typescript
import type { archestraApiTypes } from "@shared";

type EnterpriseFeatures = NonNullable<
  archestraApiTypes.GetConfigResponses["200"]["enterpriseFeatures"]
>;
type EnterpriseFeatureKey = keyof EnterpriseFeatures;

export function useEnterpriseFeature(feature: EnterpriseFeatureKey): boolean {
  const { data } = useConfig();
  return data?.enterpriseFeatures?.[feature] ?? false;
}
```

This derives the feature keys from the codegen'd API types, so adding a new enterprise feature to the backend response schema automatically makes it available in the hook without manual type updates.

### 3.3 Conditional UI Visibility

- **Sidebar**: Knowledge section only shown when `useEnterpriseFeature("knowledgeBase")` is `true`
- **Settings**: Knowledge tab on `/settings` pages only shown when feature is enabled
- **Settings page**: `/settings/knowledge` — embedding model selection and API key (see §4)

---

## 4. Embedding Configuration

### 4.1 Settings UI (`/settings/knowledge`)

A new settings page for knowledge base configuration. Only visible when `enterpriseFeatures.knowledgeBase` is enabled.

**Embedding model selection** — Opinionated, small curated list:

| Model                    | Provider | Dimensions | Notes                            |
| ------------------------ | -------- | ---------- | -------------------------------- |
| `text-embedding-3-small` | OpenAI   | 1536       | Default. Best cost/quality ratio |
| `text-embedding-3-large` | OpenAI   | 3072       | Higher quality, 2x cost          |
| `text-embedding-ada-002` | OpenAI   | 1536       | Legacy, for backward compat      |

**Settings stored at org level** — New columns on `organizations` table (or a new `knowledge_base_settings` table):

```typescript
// On organizations table (simplest)
embeddingModel: text("embedding_model").default("text-embedding-3-small"),
embeddingApiKey: uuid("embedding_api_key_secret_id").references(() => secretTable.id),
```

The API key is stored via the secrets manager (same pattern as connector credentials).

### 4.2 Advanced Configuration (Env Vars)

For advanced/operational settings that don't need UI:

| Variable                                          | Required | Default | Description                             |
| ------------------------------------------------- | -------- | ------- | --------------------------------------- |
| `ARCHESTRA_KNOWLEDGE_BASE_CHUNK_SIZE_TOKENS`      | No       | `512`   | Maximum tokens per chunk                |
| `ARCHESTRA_KNOWLEDGE_BASE_CHUNK_OVERLAP_TOKENS`   | No       | `50`    | Token overlap between chunks            |
| `ARCHESTRA_KNOWLEDGE_BASE_PROCESSING_CONCURRENCY` | No       | `2`     | Max concurrent document processing jobs |

---

## 5. Database Schema

### 5.1 `kb_documents`

Source-of-truth for every document in a knowledge base, regardless of origin (connector, API).

```sql
CREATE TABLE kb_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,

  -- Source identification
  source_type     TEXT NOT NULL,          -- 'connector', 'api'
  source_id       TEXT,                   -- External ID (Jira issue key, Confluence page ID, etc.)
  connector_id    UUID REFERENCES knowledge_base_connectors(id) ON DELETE SET NULL,

  -- Content
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,          -- Full extracted text content
  content_hash    TEXT NOT NULL,          -- SHA-256 hash for dedup
  source_url      TEXT,                   -- Original URL (Jira/Confluence link, etc.)

  -- Access control
  acl             JSONB NOT NULL DEFAULT '[]', -- Array of permission strings
  -- Format: ["org:*", "team:team-uuid", "user_email:alice@co.com"]

  -- Metadata
  metadata        JSONB DEFAULT '{}',     -- Connector-specific metadata (title, labels, etc.)
  embedding_status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
  chunk_count     INTEGER NOT NULL DEFAULT 0,

  created_at      TIMESTAMP NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX kb_documents_kb_id_idx ON kb_documents(knowledge_base_id);
CREATE INDEX kb_documents_org_id_idx ON kb_documents(organization_id);
CREATE INDEX kb_documents_content_hash_idx ON kb_documents(knowledge_base_id, content_hash);
CREATE INDEX kb_documents_source_idx ON kb_documents(knowledge_base_id, source_type, source_id);
CREATE INDEX kb_documents_embedding_status_idx ON kb_documents(embedding_status) WHERE embedding_status != 'completed';
```

**Drizzle schema** (`backend/src/database/schemas/kb-document.ee.ts`):

```typescript
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import knowledgeBasesTable from "./knowledge-base";
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";

const kbDocumentsTable = pgTable(
  "kb_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBasesTable.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    sourceType: text("source_type").$type<"connector" | "api">().notNull(),
    sourceId: text("source_id"),
    connectorId: uuid("connector_id").references(
      () => knowledgeBaseConnectorsTable.id,
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    sourceUrl: text("source_url"),
    acl: jsonb("acl").$type<string[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    embeddingStatus: text("embedding_status")
      .$type<"pending" | "processing" | "completed" | "failed">()
      .notNull()
      .default("pending"),
    chunkCount: integer("chunk_count").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("kb_documents_kb_id_idx").on(table.knowledgeBaseId),
    index("kb_documents_org_id_idx").on(table.organizationId),
    index("kb_documents_content_hash_idx").on(
      table.knowledgeBaseId,
      table.contentHash,
    ),
    index("kb_documents_source_idx").on(
      table.knowledgeBaseId,
      table.sourceType,
      table.sourceId,
    ),
  ],
);

export default kbDocumentsTable;
```

### 5.2 `kb_chunks`

Chunked content with embeddings and full-text search vectors. Metadata is **not denormalized** — joins to `kb_documents` for source metadata at query time.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE kb_chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,

  -- Content
  content         TEXT NOT NULL,
  chunk_index     INTEGER NOT NULL,       -- Position within document (0-based)

  -- Vectors
  embedding       vector(1536),           -- OpenAI text-embedding-3-small (default)
  search_vector   tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,

  -- ACL (denormalized from parent document for query-time filtering without extra join)
  acl             JSONB NOT NULL DEFAULT '[]',

  created_at      TIMESTAMP NOT NULL DEFAULT now()
);

-- HNSW index for approximate nearest neighbor search
CREATE INDEX kb_chunks_embedding_idx ON kb_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- GIN index for full-text search
CREATE INDEX kb_chunks_search_vector_idx ON kb_chunks USING gin(search_vector);

-- GIN index for ACL filtering
CREATE INDEX kb_chunks_acl_idx ON kb_chunks USING gin(acl jsonb_path_ops);

-- Lookup by document
CREATE INDEX kb_chunks_document_id_idx ON kb_chunks(document_id);

-- Lookup by knowledge base
CREATE INDEX kb_chunks_kb_id_idx ON kb_chunks(knowledge_base_id);
```

**Drizzle schema** (`backend/src/database/schemas/kb-chunk.ee.ts`):

```typescript
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { customType } from "drizzle-orm/pg-core";
import kbDocumentsTable from "./kb-document.ee";
import knowledgeBasesTable from "./knowledge-base";

// Custom type for pgvector
const vector = customType<{ data: number[]; driverParam: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value.slice(1, -1).split(",").map(Number);
  },
});

// Custom type for tsvector (generated column, read-only)
const tsvector = customType<{ data: string; driverParam: string }>({
  dataType() {
    return "tsvector";
  },
});

const kbChunksTable = pgTable(
  "kb_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => kbDocumentsTable.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBasesTable.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    embedding: vector("embedding"),
    searchVector: tsvector("search_vector"), // Generated column — managed by SQL migration
    acl: jsonb("acl").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("kb_chunks_document_id_idx").on(table.documentId),
    index("kb_chunks_kb_id_idx").on(table.knowledgeBaseId),
  ],
);

export default kbChunksTable;
```

> **Note:** The HNSW, GIN (search_vector), and GIN (acl) indexes must be created in the SQL migration directly since Drizzle doesn't support these index types natively.

### 5.3 Agent/MCP Gateway → Connector Direct Assignment

In addition to assigning knowledge bases to agents/MCP gateways (existing `agents.knowledge_base_id`), users can also assign connectors directly. This means a profile can pull knowledge from:

1. A **Knowledge Base** (collection of documents from one or more connectors), OR
2. One or more **Connectors** directly (without creating a KB)

New junction table:

```sql
CREATE TABLE agent_connector_assignment (
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  connector_id  UUID NOT NULL REFERENCES knowledge_base_connectors(id) ON DELETE CASCADE,
  created_at    TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, connector_id)
);

CREATE INDEX agent_connector_assignment_agent_idx ON agent_connector_assignment(agent_id);
CREATE INDEX agent_connector_assignment_connector_idx ON agent_connector_assignment(connector_id);
```

At query time, the system resolves all knowledge sources for an agent:

1. If `knowledge_base_id` is set → query chunks from that KB
2. If agent has direct connector assignments → query chunks from `kb_documents` where `connector_id` matches
3. Both can be active simultaneously (results are merged via RRF)

---

## 6. Chunking & Embedding

### 6.1 Chunking Strategy

**Token-aware recursive text splitting:**

- **Chunk size:** 512 tokens (~2048 characters)
- **Overlap:** 50 tokens (~200 characters)
- **Split hierarchy:** Markdown headers (`## `, `### `) → double newlines → single newlines → sentence boundaries → word boundaries
- **Markdown header preservation:** When splitting on headers, prepend the header hierarchy to each chunk so context is retained (e.g., `"## API Reference\n### Authentication\n<chunk content>"`)

```typescript
interface ChunkingConfig {
  maxTokens: number; // 512
  overlapTokens: number; // 50
  tokenizer: "cl100k_base"; // OpenAI tokenizer
}

interface Chunk {
  content: string;
  chunkIndex: number;
  tokenCount: number;
}
```

**Implementation:** `backend/src/knowledge-base/chunker.ee.ts`

Use `tiktoken` (via `js-tiktoken`) for accurate token counting with the `cl100k_base` tokenizer (matches OpenAI embedding models).

### 6.2 Embedding

**Model:** Configurable via org settings UI (see §4). Default: OpenAI `text-embedding-3-small` (1536 dimensions).

- **Batching:** Groups of 100 chunks per API call (OpenAI batch limit: 2048, but 100 keeps request size manageable)
- **Rate limiting:** Respect OpenAI rate limits with exponential backoff
- **API key:** Configured per-org via `/settings/knowledge` UI, stored in secrets manager

```typescript
interface EmbeddingConfig {
  model: string; // from org settings
  dimensions: number; // derived from model selection
  batchSize: 100;
  apiKey: string; // from org settings (secrets manager)
}
```

**Implementation:** `backend/src/knowledge-base/embedder.ee.ts`

### 6.3 Processing Pipeline

Documents are processed asynchronously after insertion into `kb_documents`:

1. Set `embedding_status = 'processing'`
2. Split content into chunks using `chunker.ee.ts`
3. Embed chunks in batches using `embedder.ee.ts`
4. Insert chunks into `kb_chunks` with embeddings and ACL copied from parent document
5. Update `kb_documents.chunk_count` and set `embedding_status = 'completed'`
6. On error: set `embedding_status = 'failed'`, log error

**Implementation:** `backend/src/knowledge-base/document-processor.ee.ts`

Processing runs in-process using a simple async queue with configurable concurrency (default: 2 concurrent documents). No external job queue needed — the queue is in-memory and documents with `embedding_status = 'pending'` are picked up on restart.

---

## 7. Ingestion Pipeline

### 7.1 Connector Ingestion

The existing connector sync flow (`ConnectorSyncService.executeSync()`) is modified to write directly to `kb_documents` instead of calling `provider.insertDocument()`:

```
Connector.sync()
  → ConnectorSyncBatch { documents, checkpoint }
    → For each document:
        1. Compute content_hash = SHA-256(content)
        2. Upsert into kb_documents (dedup by knowledge_base_id + content_hash)
        3. Build ACL based on connector permissions (see §9)
        4. Queue for chunking/embedding (document-processor picks up pending docs)
    → Update checkpoint
```

**Content hash deduplication:** If a document with the same `content_hash` already exists in the knowledge base, skip re-ingestion. This handles incremental syncs efficiently — only new or modified documents get re-processed.

### 7.2 New Connectors

In addition to the existing **Jira** and **Confluence** connectors, v1 adds three new connectors:

#### SharePoint

- **SDK:** Use [`@microsoft/microsoft-graph-client`](https://www.npmjs.com/package/@microsoft/microsoft-graph-client) — the official Microsoft Graph TypeScript SDK. Provides typed helpers for authentication, pagination, and batch requests against the Graph API.
- **Source:** [Onyx SharePoint connector](https://github.com/onyx-dot-app/onyx/tree/main/backend/onyx/connectors/sharepoint) (reference for data model and sync logic)
- **API:** Microsoft Graph API (`/sites`, `/drives`, `/items`)
- **Auth:** OAuth 2.0 client credentials (Azure AD app registration) — `client_id`, `client_secret`, `tenant_id`
- **Data:** Site pages, document libraries (Word, Excel, PowerPoint, PDF text extraction), list items
- **Config:** `site_url` (SharePoint site), optional `document_library` filter, optional `folder_path` filter
- **Checkpoint:** `lastSyncedAt` timestamp for incremental delta queries via `$filter=lastModifiedDateTime gt ...`
- **Implementation:** `backend/src/knowledge-base/connectors/sharepoint/sharepoint-connector.ee.ts`

#### GitHub

- **SDK:** Use [`@octokit/rest`](https://www.npmjs.com/package/@octokit/rest) for REST endpoints and [`@octokit/graphql`](https://www.npmjs.com/package/@octokit/graphql) for GraphQL queries — the official GitHub TypeScript SDKs. Provides built-in pagination, auth, and rate-limit handling.
- **Source:** [Onyx GitHub connector](https://github.com/onyx-dot-app/onyx/tree/main/backend/onyx/connectors/github) (reference for data model and sync logic)
- **API:** GitHub REST API v3 + GraphQL API v4
- **Auth:** Personal access token (PAT) or GitHub App installation token
- **Data:** Repository READMEs, issues (title + body + comments), pull requests (title + body + review comments), wiki pages
- **Config:** `owner` (org or user), optional `repos` filter (list of repo names), optional `include_issues`, `include_prs`, `include_wiki` booleans
- **Checkpoint:** `lastSyncedAt` + `lastCursor` for paginated incremental sync via `since` parameter
- **Implementation:** `backend/src/knowledge-base/connectors/github/github-connector.ee.ts`

#### GitLab

- **SDK:** Use [`@gitbeaker/rest`](https://www.npmjs.com/package/@gitbeaker/rest) — the official community-maintained GitLab TypeScript SDK. Provides typed methods for all GitLab API v4 endpoints with built-in pagination and auth.
- **Source:** [Onyx GitLab connector](https://github.com/onyx-dot-app/onyx/tree/main/backend/onyx/connectors/gitlab) (reference for data model and sync logic)
- **API:** GitLab REST API v4
- **Auth:** Personal access token or project/group access token
- **Data:** Project READMEs, issues (title + description + notes), merge requests (title + description + notes), wiki pages
- **Config:** `gitlab_url` (self-hosted or `https://gitlab.com`), optional `project_ids` or `group_ids` filter
- **Checkpoint:** `lastSyncedAt` for incremental sync via `updated_after` parameter
- **Implementation:** `backend/src/knowledge-base/connectors/gitlab/gitlab-connector.ee.ts`

#### Connector Type Updates

The `ConnectorTypeSchema` (`backend/src/types/knowledge-connector.ts`) is extended:

```typescript
export const ConnectorTypeSchema = z.union([
  z.literal("jira"),
  z.literal("confluence"),
  z.literal("sharepoint"),
  z.literal("github"),
  z.literal("gitlab"),
]);
```

New credential schemas are added for each connector (OAuth credentials for SharePoint, PAT for GitHub/GitLab).

### 7.3 Connector Document Interface

The `ConnectorDocument` interface (`backend/src/types/knowledge-connector.ts`) is extended with an optional permissions field:

```typescript
export interface ConnectorDocument {
  id: string;
  title: string;
  content: string;
  sourceUrl?: string;
  metadata: Record<string, unknown>;
  updatedAt?: Date;
  // NEW: Access control permissions from the source system
  permissions?: {
    users?: string[]; // Email addresses
    groups?: string[]; // Group names/IDs
    isPublic?: boolean; // Accessible to entire org
  };
}
```

---

## 8. Query Pipeline

### 8.1 Hybrid Search with RRF

A single SQL query combines vector similarity search and BM-25 full-text search using **Reciprocal Rank Fusion (RRF)** with `k=60`. Source metadata (title, URL, source type) is joined from `kb_documents` at query time rather than denormalized on chunks:

```sql
WITH params AS (
  SELECT
    $1::vector(1536) AS query_embedding,
    plainto_tsquery('english', $2) AS query_tsquery,
    $3::uuid AS kb_id,
    $4::jsonb AS user_acl,       -- e.g., '["org:*", "team:abc", "user_email:alice@co.com"]'
    $5::integer AS result_limit   -- e.g., 10
),

-- Vector search: top 50 by cosine similarity
vector_results AS (
  SELECT
    c.id,
    ROW_NUMBER() OVER (ORDER BY c.embedding <=> p.query_embedding) AS rank_v
  FROM kb_chunks c, params p
  WHERE c.knowledge_base_id = p.kb_id
    AND c.embedding IS NOT NULL
    AND c.acl ?| ARRAY(SELECT jsonb_array_elements_text(p.user_acl))
  ORDER BY c.embedding <=> p.query_embedding
  LIMIT 50
),

-- Full-text search: top 50 by ts_rank_cd
fts_results AS (
  SELECT
    c.id,
    ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.search_vector, p.query_tsquery) DESC) AS rank_f
  FROM kb_chunks c, params p
  WHERE c.knowledge_base_id = p.kb_id
    AND c.search_vector @@ p.query_tsquery
    AND c.acl ?| ARRAY(SELECT jsonb_array_elements_text(p.user_acl))
  ORDER BY ts_rank_cd(c.search_vector, p.query_tsquery) DESC
  LIMIT 50
),

-- Reciprocal Rank Fusion (k=60)
fused AS (
  SELECT
    COALESCE(v.id, f.id) AS chunk_id,
    COALESCE(1.0 / (60 + v.rank_v), 0) + COALESCE(1.0 / (60 + f.rank_f), 0) AS rrf_score
  FROM vector_results v
  FULL OUTER JOIN fts_results f ON v.id = f.id
)

SELECT
  c.id,
  c.content,
  c.chunk_index,
  c.document_id,
  d.title,
  d.source_url,
  d.source_type,
  d.metadata,
  f.rrf_score
FROM fused f
JOIN kb_chunks c ON c.id = f.chunk_id
JOIN kb_documents d ON d.id = c.document_id
ORDER BY f.rrf_score DESC
LIMIT (SELECT result_limit FROM params);
```

### 8.2 ACL Filtering

The `?|` operator checks if the chunk's `acl` JSONB array contains **any** of the user's permission strings. The GIN index on `acl` makes this efficient.

User ACL is constructed at query time from the requesting user's identity:

```typescript
function buildUserAcl(params: {
  organizationId: string;
  userEmail: string;
  teamIds: string[];
  visibility: KnowledgeBaseVisibility;
}): string[] {
  const acl: string[] = [];

  if (params.visibility === "org-wide") {
    acl.push("org:*");
  }

  acl.push(`user_email:${params.userEmail}`);

  for (const teamId of params.teamIds) {
    acl.push(`team:${teamId}`);
  }

  return acl;
}
```

### 8.3 Visibility Modes

The three existing visibility modes map to ACL behavior:

| Mode                    | Document ACL                                            | Query behavior                                          |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| `org-wide`              | `["org:*"]`                                             | All org members can query all documents                 |
| `team-scoped`           | `["team:<teamId>", ...]`                                | Only members of assigned teams can query                |
| `auto-sync-permissions` | `["user_email:alice@co.com", "group:engineering", ...]` | Permissions synced from source system (Jira/Confluence) |

---

## 9. Access Control

### 9.1 ACL Format

ACLs are stored as arrays of namespaced strings in JSONB:

```json
["org:*"]                                          // org-wide visibility
["team:550e8400-e29b-41d4-a716-446655440000"]      // team-scoped
["user_email:alice@example.com", "group:engineering"] // auto-sync from connector
```

**Namespace prefixes:**

- `org:*` — Accessible to all organization members
- `team:<uuid>` — Accessible to members of the specified team
- `user_email:<email>` — Accessible to a specific user
- `group:<name>` — Accessible to members of a named group (from source system)

### 9.2 Connector Permission Extraction

Each connector implementation can optionally extract permissions from the source system. The `ConnectorDocument.permissions` field is mapped to ACL strings during ingestion:

```typescript
function buildDocumentAcl(params: {
  visibility: KnowledgeBaseVisibility;
  teamIds: string[];
  permissions?: ConnectorDocument["permissions"];
}): string[] {
  switch (params.visibility) {
    case "org-wide":
      return ["org:*"];
    case "team-scoped":
      return params.teamIds.map((id) => `team:${id}`);
    case "auto-sync-permissions": {
      const acl: string[] = [];
      if (params.permissions?.isPublic) {
        acl.push("org:*");
      }
      if (params.permissions?.users) {
        acl.push(...params.permissions.users.map((u) => `user_email:${u}`));
      }
      if (params.permissions?.groups) {
        acl.push(...params.permissions.groups.map((g) => `group:${g}`));
      }
      // Fallback: if no permissions extracted, grant org-wide access
      if (acl.length === 0) {
        acl.push("org:*");
      }
      return acl;
    }
  }
}
```

### 9.3 Connector Permission Sync

- **Jira:** Extract project role members and issue-level security schemes via REST API. Map Jira groups/users to ACL strings.
- **Confluence:** Extract space permissions and page restrictions via REST API. Map Confluence groups/users to ACL strings.
- **SharePoint:** Extract site/library permissions via Microsoft Graph API (`/permissions` endpoint). Map Azure AD users/groups to ACL strings.
- **GitHub:** Extract repository collaborators and team access via REST API. Map GitHub usernames (resolved to emails where possible) and team slugs to ACL strings.
- **GitLab:** Extract project/group members via REST API. Map GitLab usernames (resolved to emails) and group paths to ACL strings.

This is a best-effort mapping — the connectors will attempt to extract permissions when `visibility = "auto-sync-permissions"`, but fall back to `org-wide` if the source API doesn't provide sufficient permission data.

---

## 10. Citations

### 10.1 Chunk Result Format

The `archestra__query_knowledge_base` MCP tool returns structured chunk results with citation metadata. Source metadata comes from the `kb_documents` join (not denormalized on chunks):

```typescript
interface ChunkResult {
  content: string;
  score: number; // RRF score
  chunkIndex: number;
  citation: {
    title: string; // From kb_documents.title
    sourceUrl: string | null; // From kb_documents.source_url
    sourceType: string; // From kb_documents.source_type ('connector', 'api')
    documentId: string; // For grouping chunks by document
  };
}
```

### 10.2 MCP Tool Response

The `archestra__query_knowledge_base` tool returns chunks directly (not a pre-synthesized answer), allowing the LLM to attribute sources:

```json
{
  "results": [
    {
      "content": "The authentication flow uses OAuth 2.1 with PKCE...",
      "score": 0.032,
      "chunkIndex": 3,
      "citation": {
        "title": "Authentication Architecture",
        "sourceUrl": "https://company.atlassian.net/wiki/x/ABC123",
        "sourceType": "connector",
        "documentId": "550e8400-..."
      }
    }
  ],
  "totalChunks": 1
}
```

### 10.3 Frontend Citation UI

Replace the mock `MOCK_CITATIONS` array in `knowledge-graph-citations.tsx` with real data from the tool call result:

1. Parse the `archestra__query_knowledge_base` tool result from the assistant message parts
2. Extract `citation` objects from each chunk result
3. Deduplicate by `documentId` (multiple chunks may come from the same document)
4. Render citation cards with:
   - **Connector sources** (Jira/Confluence/SharePoint/GitHub/GitLab): External link icon, opens `sourceUrl` in new tab
   - **Source type icon**: Jira, Confluence, SharePoint, GitHub, GitLab, or generic icon based on connector type metadata

---

## 11. Migration Path

### Phase 1: Infrastructure

1. Add `pgvector` extension: `CREATE EXTENSION IF NOT EXISTS vector`
2. Create `kb_documents`, `kb_chunks` tables
3. Create `agent_connector_assignment` junction table
4. Add `enterpriseFeatures` to `GET /api/config` response
5. Remove `NEXT_PUBLIC_ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED` from Dockerfile and frontend
6. Add `/settings/knowledge` page (embedding model + API key)
7. Implement `chunker.ee.ts`, `embedder.ee.ts`, `document-processor.ee.ts`

### Phase 2: Core RAG

1. Remove LightRAG provider (`lightrag-provider.ts`, `lightrag-provider.test.ts`)
2. Remove `provider` and `config` columns from `knowledge_bases` table (or make nullable/deprecated)
3. Modify `ConnectorSyncService` to write to `kb_documents` directly
4. Implement hybrid search query builder (`query.ee.ts`)
5. Update `archestra__query_knowledge_base` tool to use hybrid search
6. Replace mock citations with real citation data in frontend

### Phase 3: New Connectors

1. Implement SharePoint connector (`sharepoint-connector.ee.ts`) — Microsoft Graph API, OAuth 2.0 client credentials
2. Implement GitHub connector (`github-connector.ee.ts`) — REST + GraphQL API, PAT auth
3. Implement GitLab connector (`gitlab-connector.ee.ts`) — REST API v4, PAT auth
4. Add connector types to `ConnectorTypeSchema` and registry
5. Add connector-specific credential schemas and config UI fields

### Phase 4: Agent Association

1. Implement agent/MCP gateway → connector direct assignment UI and API
2. Update query pipeline to resolve knowledge sources from both KB and direct connector assignments
3. Update agent dialog to show KB and connector assignment options

### Phase 5: Cleanup

1. Remove LightRAG-specific code, types, and tests
2. Remove LightRAG deployment from Tilt/Helm
3. Update documentation

---

## 12. Documentation

### New Pages

Create a new **"Knowledge Bases"** category in `../docs/pages/`:

**`platform-knowledge-bases-overview.md`** (rename/overhaul existing `platform-knowledge-bases.md`):

```yaml
---
title: "Knowledge Bases Overview"
category: Knowledge Bases
order: 1
description: "Built-in RAG with pgvector for enterprise knowledge management"
---
```

Enterprise feature notice at top (matching existing pattern from `platform-identity-providers.md`):

> **Enterprise feature:** Please reach out to sales@archestra.ai for instructions about how to enable the feature.

**`platform-knowledge-connectors.md`** (rename/overhaul existing `platform-adding-knowledge-connectors.md`):

```yaml
---
title: "Knowledge Connectors"
category: Knowledge Bases
order: 2
description: "Connect Jira, Confluence, and other data sources to knowledge bases"
---
```

### Updates to Existing Docs

**`../docs/pages/platform-deployment.md`** — Overhaul the "Knowledge Base Configuration" section with current env vars, and add pgvector requirements under "Production Recommendations > PostgreSQL Infrastructure":

- Add a "pgvector Extension (Knowledge Base Feature)" subsection under "PostgreSQL Infrastructure" explaining:
  - pgvector is required for the Knowledge Base enterprise feature
  - The DB user needs `CREATE EXTENSION` privileges (typically superuser)
  - Cloud-managed database instructions (RDS, Cloud SQL, Azure) — pgvector is a trusted/supported extension on all three
  - Self-managed PostgreSQL instructions (install pgvector package, grant privileges)
  - Migration failure behavior if pgvector is missing (only affects KB feature, not other features)

Knowledge Base env vars:

```markdown
### Knowledge Base Configuration

> **Enterprise feature:** Contact sales@archestra.ai for licensing information.

- **`ARCHESTRA_ENTERPRISE_LICENSE_KNOWLEDGE_BASE_ACTIVATED`** - Enables the Knowledge Base enterprise feature.
  - Set to `true` to enable
  - Knowledge Base sidebar section, settings, and API routes are only available when enabled

- **`ARCHESTRA_KNOWLEDGE_BASE_CHUNK_SIZE_TOKENS`** - Maximum tokens per chunk for document splitting.
  - Default: `512`

- **`ARCHESTRA_KNOWLEDGE_BASE_CHUNK_OVERLAP_TOKENS`** - Token overlap between consecutive chunks.
  - Default: `50`

- **`ARCHESTRA_KNOWLEDGE_BASE_PROCESSING_CONCURRENCY`** - Maximum concurrent document processing jobs.
  - Default: `2`

- **`ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_K8S_CRONJOB_NAMESPACE`** - Kubernetes namespace where connector CronJobs run.
  - Default: `archestra-connectors`
  - Requires K8s runtime to be configured
```

---

## 13. Files to Create/Modify

### New Files

All knowledge-related files use `.ee.ts` suffix per enterprise convention.

| File                                                                               | Purpose                                                                |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `backend/src/database/schemas/kb-document.ee.ts`                                   | Drizzle schema for `kb_documents` table                                |
| `backend/src/database/schemas/kb-chunk.ee.ts`                                      | Drizzle schema for `kb_chunks` table                                   |
| `backend/src/database/schemas/agent-connector-assignment.ee.ts`                    | Junction table for agent → connector                                   |
| `backend/src/knowledge-base/chunker.ee.ts`                                         | Token-aware recursive text splitting                                   |
| `backend/src/knowledge-base/chunker.ee.test.ts`                                    | Chunker unit tests                                                     |
| `backend/src/knowledge-base/embedder.ee.ts`                                        | OpenAI embedding API client with batching                              |
| `backend/src/knowledge-base/embedder.ee.test.ts`                                   | Embedder unit tests                                                    |
| `backend/src/knowledge-base/document-processor.ee.ts`                              | Async document processing queue (chunk → embed → store)                |
| `backend/src/knowledge-base/document-processor.ee.test.ts`                         | Document processor tests                                               |
| `backend/src/knowledge-base/query.ee.ts`                                           | Hybrid search query builder (RRF SQL)                                  |
| `backend/src/knowledge-base/query.ee.test.ts`                                      | Query pipeline tests                                                   |
| `backend/src/knowledge-base/acl.ee.ts`                                             | ACL construction helpers                                               |
| `backend/src/knowledge-base/acl.ee.test.ts`                                        | ACL tests                                                              |
| `backend/src/knowledge-base/connectors/sharepoint/sharepoint-connector.ee.ts`      | SharePoint connector (Microsoft Graph API)                             |
| `backend/src/knowledge-base/connectors/sharepoint/sharepoint-connector.ee.test.ts` | SharePoint connector tests                                             |
| `backend/src/knowledge-base/connectors/github/github-connector.ee.ts`              | GitHub connector (REST + GraphQL API)                                  |
| `backend/src/knowledge-base/connectors/github/github-connector.ee.test.ts`         | GitHub connector tests                                                 |
| `backend/src/knowledge-base/connectors/gitlab/gitlab-connector.ee.ts`              | GitLab connector (REST API v4)                                         |
| `backend/src/knowledge-base/connectors/gitlab/gitlab-connector.ee.test.ts`         | GitLab connector tests                                                 |
| `backend/src/models/kb-document.ee.ts`                                             | Model for `kb_documents` CRUD                                          |
| `backend/src/models/kb-chunk.ee.ts`                                                | Model for `kb_chunks` CRUD                                             |
| `backend/src/models/agent-connector-assignment.ee.ts`                              | Model for agent-connector junction                                     |
| `backend/src/types/kb-document.ee.ts`                                              | Types derived from `kb_documents` schema via drizzle-zod               |
| `backend/src/types/kb-chunk.ee.ts`                                                 | Types derived from `kb_chunks` schema via drizzle-zod                  |
| `frontend/src/lib/enterprise-features.hook.ts`                                     | `useEnterpriseFeature()` hook (types derived from codegen'd API types) |
| `frontend/src/app/settings/knowledge/page.tsx`                                     | Knowledge settings page (embedding model, API key)                     |
| `docs/pages/platform-knowledge-bases-overview.md`                                  | Knowledge Bases overview doc                                           |
| `docs/pages/platform-knowledge-connectors.md`                                      | Knowledge Connectors doc                                               |

### Modified Files

| File                                                         | Change                                                                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `backend/src/database/schemas/index.ts`                      | Export new table schemas                                                                                                |
| `backend/src/config.ts`                                      | Add `enterpriseFeatures.knowledgeBase` from `ARCHESTRA_ENTERPRISE_LICENSE_KNOWLEDGE_BASE_ACTIVATED`                     |
| `backend/src/routes/config.ts`                               | Add `enterpriseFeatures` object to response (replace flat `enterpriseLicenseActivated`)                                 |
| `backend/src/knowledge-base/index.ts`                        | Remove `createKnowledgeBaseProvider` factory, remove LightRAG                                                           |
| `backend/src/knowledge-base/connector-sync.ts`               | Write to `kb_documents` instead of `provider.insertDocument()`                                                          |
| `backend/src/types/knowledge-base.ts`                        | Remove LightRAG types, add pgvector types                                                                               |
| `backend/src/types/knowledge-connector.ts`                   | Add `permissions` field to `ConnectorDocument`, add `sharepoint`, `github`, `gitlab` to `ConnectorTypeSchema`           |
| `backend/src/knowledge-base/connectors/registry.ts`          | Register new SharePoint, GitHub, GitLab connectors                                                                      |
| `backend/src/routes/knowledge-base.ts`                       | Gate routes behind enterprise feature flag                                                                              |
| `backend/src/archestra-mcp-server.ts`                        | Update `archestra__query_knowledge_base` tool to use hybrid search                                                      |
| `frontend/src/components/chat/knowledge-graph-citations.tsx` | Replace mock data with real citation rendering                                                                          |
| `frontend/src/lib/config.ts`                                 | Remove `enterpriseLicenseActivated` getter                                                                              |
| `frontend/src/app/_parts/sidebar.tsx`                        | Use `useEnterpriseFeature("core")` instead of `config.enterpriseLicenseActivated`; conditionally show Knowledge section |
| `frontend/src/app/settings/layout.tsx`                       | Add Knowledge tab (conditional on feature flag)                                                                         |
| `shared/access-control.ee.ts`                                | Add knowledge route permissions                                                                                         |
| `Dockerfile`                                                 | Remove `NEXT_PUBLIC_ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED` from supervisord environment                                |
| `docs/pages/platform-deployment.md`                          | Overhaul Knowledge Base Configuration section                                                                           |
| `docs/pages/platform-knowledge-bases.md`                     | Rename/overhaul to `platform-knowledge-bases-overview.md`                                                               |
| `docs/pages/platform-adding-knowledge-connectors.md`         | Rename/overhaul to `platform-knowledge-connectors.md`                                                                   |

### Files to Delete

| File                                                   | Reason                               |
| ------------------------------------------------------ | ------------------------------------ |
| `backend/src/knowledge-base/lightrag-provider.ts`      | Replaced by built-in pgvector        |
| `backend/src/knowledge-base/lightrag-provider.test.ts` | No longer needed                     |
| `backend/src/knowledge-base/index.test.ts`             | Tests for provider factory (removed) |

---

## 14. Out of Scope for v1 (Future Improvements)

The following features are intentionally excluded from v1 to keep scope manageable:

- **File upload & blob storage** — Storing original uploaded files (PDF, markdown, etc.) as `bytea` in a `kb_files` table, with a serving endpoint for clickable citation links. Currently, chat file upload ingestion into the knowledge base is removed along with LightRAG.
- **Chat document auto-ingestion** — Automatically ingesting file attachments from chat messages into knowledge bases (the existing `chat-document-extractor.ts` flow). Will be re-implemented once file upload blob storage is in place.
- **PDF/Office document parsing** — Extracting text from binary formats like PDF, DOCX, PPTX. Requires additional parsing libraries.
- **Additional embedding providers** — Support for Cohere, Voyage AI, local embedding models (Ollama). v1 is OpenAI-only.
- **Multi-language full-text search** — Currently hardcoded to `to_tsvector('english', ...)`. Future: configurable language dictionaries.
- **Semantic chunking** — Using embedding similarity to determine chunk boundaries instead of fixed token windows.
- **Re-ranking** — Adding a cross-encoder re-ranking step after initial retrieval (e.g., Cohere Rerank, ColBERT).
- **Streaming ingestion status** — Real-time UI feedback on document processing progress (WebSocket updates).
- **Knowledge base analytics** — Dashboard showing document counts, embedding coverage, query frequency, latency percentiles.
- **Document deletion/update API** — Individual document management (currently only full KB deletion cascades).
- **Configurable vector dimensions** — Supporting `text-embedding-3-large` (3072 dims) requires schema-level vector dimension configuration per KB. v1 uses fixed 1536.
