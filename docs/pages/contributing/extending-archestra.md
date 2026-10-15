---
title: Extending Archestra
description: Add LLM providers, knowledge connectors, and retrieval backends to Archestra
order: 2
lastUpdated: 2026-10-15
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Add a model provider, synchronize a new knowledge source, or implement a retrieval backend. Start with the [Developer Quickstart](/docs/contributing/developer-quickstart), read the repository instructions, and run commands from `platform/`; source paths below are relative to that directory.

## Adding LLM Providers

<span id="adding-llm-providers"></span>

A provider touches two parts of Archestra. The [LLM Proxy](/docs/llm-proxy) route receives client requests, applies security guardrails, logs token usage, and forwards requests to the provider. [Chat](/docs/chat) queries the provider's models and renders completions in the built-in interface.

Use Kimi (`backend/src/routes/proxy/adapters/kimi.ts`) as the OpenAI-compatible example. A native wire format needs its own request, response, stream, and Model Router translation. Read `.agents/skills/archestra-dev-llm-providers/SKILL.md` at the repository root before starting.

### TypeScript-Guided Changes

1. In `shared/model-constants.ts`, add the provider ID to `SupportedProvidersSchema`. Add its `provider:endpoint` value (for example `kimi:chatCompletions`) to `SupportedProvidersDiscriminatorSchema`.
2. Run `pnpm type-check` from `platform/`.
3. Each compile error highlights a `Record<SupportedProvider, …>` or exhaustive switch requiring an entry for the new provider.

### OpenAI-Compatible Providers

Follow the request from schema to proxy, chat, and logs. Compiler errors identify exhaustive registrations, but cannot prove wire compatibility.

- **Types:** Create `backend/src/types/llm-providers/<provider>/` with `api.ts`, `messages.ts`, `tools.ts`, and `index.ts`. Re-export OpenAI schemas with `.passthrough()` to retain custom fields. Export the namespace from `backend/src/types/llm-providers/index.ts` and update `backend/src/types/interaction.ts`.
- **Adapter:** Build an adapter in `backend/src/routes/proxy/adapters/<provider>.ts` using `createOpenAiCompatibleAdapterFactory` and export it from `adapters/index.ts`.
- **Proxy Route:** Copy `backend/src/routes/proxy/routes/kimi.ts` to `backend/src/routes/proxy/routes/<provider>.ts`. Register the route IDs in `shared/routes.ts`, export the plugin from `backend/src/routes/index.ts`, and register it in `backend/src/server.ts`.
- **Configuration:** In `backend/src/config.ts`, expose `llm.<provider>.baseUrl` and `chat.<provider>.apiKey`. Add both to `.env.example` and the [Configuration](/docs/reference/configuration) reference.
- **Chat Support:** Add a model fetcher in `backend/src/routes/chat/model-fetchers/index.ts` (use `makeBearerFetcher` for standard `GET /models` endpoints), configure `providerModelConfigs` in `backend/src/clients/llm-client.ts`, and register error handlers in `backend/src/routes/chat/errors.ts`.
- **Frontend & Logging:** Add the provider logo in `frontend/public/icons/`, register credentials in `frontend/src/components/llm-provider-api-key-form.tsx`, and add a log parser in `shared/interactions/llmProviders/`.

### Native API Providers

Providers with distinct wire formats (such as Anthropic, Gemini, Bedrock, or Cohere) require:

1. **Schemas:** Zod request, response, message, and tool schemas in `backend/src/types/llm-providers/<provider>/`.
2. **Adapters:** Implement `LLMRequestAdapter`, `LLMResponseAdapter`, `LLMStreamAdapter`, and `LLMProvider` from `backend/src/types/llm-provider.ts`.
3. **Model Router:** Implement `<provider>-openai.ts` and `<provider>-openai-translator.ts` in `backend/src/routes/proxy/adapters/` to translate between the native protocol and OpenAI Chat Completions.
4. **Error Handling:** Map SDK-specific errors to unified types in `backend/src/routes/chat/errors.ts`.

### Additional Registrations and Testing

Verify the provider through both its direct endpoint and the Model Router, including streaming and tool calls.

- Add the provider to `MODEL_ROUTER_SUPPORTED_PROVIDERS` in `shared/model-constants.ts` and `openAiWireProviders` in `backend/src/routes/proxy/routes/model-router.ts`.
- Add provider support to `frontend/src/app/connection/clients.ts` and `shared/opencode-provider-routes.ts`.
- Run `pnpm codegen` to update `docs/openapi.json` and generated client libraries.
- Add the provider to the rollback matrix and test request/response translation, streaming, errors, and usage accounting. Run the relevant adapter tests and `pnpm --filter @backend test -- provider-matrix.rollback`.
- Run `pnpm type-check` and inspect generated changes. A successful request must appear in **Logs → LLM Proxy** with the correct provider, model, token usage, and cost.

---

## Adding Knowledge Connectors

<span id="adding-knowledge-connectors"></span>

A [knowledge connector](/docs/knowledge/connectors) synchronizes documents from external services (issue trackers, wikis, cloud drives) into an Archestra knowledge base on a scheduled interval. Connectors run as backend classes defining configuration schemas, sync checkpoints, and batch document generators.

### TypeScript-Guided Changes

1. Add the type literal to `USER_SELECTABLE_CONNECTOR_TYPES` in `backend/src/types/knowledge-connector.ts`.
2. Run `pnpm type-check` from `platform/` and resolve backend errors.
3. Run `pnpm codegen` to regenerate the typed client, then run `pnpm type-check` to identify frontend form requirements.

### Schemas and Connector Class

Use a checkpoint to resume from the latest source item you processed, so retries do not skip documents. Define configuration and checkpoint schemas in `backend/src/types/knowledge-connector.ts`:

```typescript
export const AcmeConfigSchema = z.object({
  type: z.literal("acme"),
  acmeBaseUrl: z.string(),
  projectKeys: z.array(z.string()).optional(),
});

export const AcmeCheckpointSchema = z.object({
  type: z.literal("acme"),
  lastSyncedAt: z.string().optional(),
});
```

Create `backend/src/knowledge-base/connectors/acme/acme-connector.ts` extending `BaseConnector`:

- `validateConfig(config)`: Validates format and URL schemas, returning `{ valid, error? }`.
- `testConnection({ config, credentials })`: Proves credentials work via a lightweight API call.
- `sync({ config, credentials, checkpoint })`: Async generator yielding batches of documents and updated checkpoints. Use `buildCheckpoint` with the newest item's timestamp rather than clock time.
- Use `fetchWithRetry()` (built-in 30s timeout and exponential backoff) and `rateLimit()`.

### Registration and UI

Expose the connector in both the backend registry and the creation form.

- Add the factory to `connectorRegistry` in `backend/src/knowledge-base/connectors/registry.ts`.
- Add the display name to `CONNECTOR_TYPE_LABELS` in `shared/knowledge-base.ts`.
- Create `frontend/src/app/knowledge/knowledge-bases/_parts/acme-config-fields.tsx` and register it in `connector-dialog-config.tsx`. Add the icon to `frontend/public/icons/`.
- Add tests in `backend/src/knowledge-base/connectors/acme/acme-connector.test.ts` for pagination, retry, checkpoint resume, document updates, and access metadata.

Run `pnpm --filter @backend test -- acme-connector`, `pnpm codegen`, and `pnpm type-check`. In the local UI, create the connector, test its connection, sync a small source, and confirm an authorized query finds the imported document. Check that an unauthorized user cannot retrieve it.

---

## Adding Knowledge Retrieval Backends

<span id="adding-knowledge-retrieval-backends"></span>

PostgreSQL with pgvector is the only shipped retrieval backend. The interface below supports implementing another backend; there is no configuration switch for an external search cluster.

### The Contract

Implement every method of `KnowledgeRetrievalBackend` in `backend/src/knowledge-base/retrieval-backend.ts`. Preserve document and chunk IDs for citations and context expansion:

- `insertChunks`: Persists chunks and indexes searchable text fields.
- `indexEmbeddings`: Stores embedding vectors for a specific dimension.
- `vectorSearch` and `keywordSearch`: Executes ranking queries against semantic embeddings and keyword indexes.
- `findNeighbors` and `findParentSiblings`: Retrieves adjacent chunks for context expansion.
- `getDocumentChunks` and `countDocumentChunks`: Read and count a document's indexed chunks.
- `getTextSearchLanguages` and `getPopulatedEmbeddingDimensions`: Report available search languages and vector dimensions.
- `deleteDocumentChunks`: Idempotently removes indexed chunks when documents change or delete.

### Security and Verification

Always set `requiresResultVerification = true` on external backends. Archestra reloads every candidate chunk from PostgreSQL and enforces connector, ACL, environment, and metadata permissions. The external index supplies search ranking scores, while PostgreSQL provides authoritative document content and citations.

### Registration and Configuration

Construction lives in `backend/src/knowledge-base/retrieval-backends/registry.ts`, which currently selects PostgreSQL directly.

1. Add your implementation and its connection configuration. Introduce runtime selection only with a working second implementation.
2. Document any new deployment variables in `.env.example` and [Configuration](/docs/reference/configuration).
3. Test ingestion, embedding dimensions, vector and keyword ranking, neighboring chunks, deletion, citations, ACLs, environments, and metadata filters.
4. Run `pnpm --filter @backend test -- knowledge-base` and `pnpm type-check`. Query the same fixture through both backends and verify that inaccessible chunks never appear.
