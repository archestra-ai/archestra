---
title: Extending Archestra
description: Add LLM providers, knowledge connectors, and retrieval backends to Archestra
order: 2
lastUpdated: 2026-10-19
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Each extension point is a typed registry. Add a provider or connector to one enum, and `pnpm type-check` lists most of the files that need an entry. This page covers that loop and the steps the compiler misses. Paths are relative to `platform/`.

<span id="adding-llm-providers"></span>

## Add an LLM Provider

A new provider gets the [LLM Proxy](/docs/llm-proxy)'s guardrails, logging, and cost tracking, and shows up in [Chat](/docs/chat)'s model picker. Most providers speak OpenAI Chat Completions and reuse OpenAI's schemas and adapter. Copy DeepSeek (`deepseek`), which is wired into every surface below.

Coding agents should load `../.agents/skills/archestra-dev-llm-providers/SKILL.md` first. It maps every file a provider touches.

<span id="typescript-guided-changes"></span>

### Start With the Provider Enum

Most of the wiring is a typed record, so the compiler lists it for you.

1. In `shared/model-constants.ts`, add the provider ID to `SupportedProvidersSchema`, and `<provider>:chatCompletions` to `SupportedProvidersDiscriminatorSchema`.
2. Add the provider's schemas to `backend/src/types/interaction.ts`, then run `pnpm codegen`.
3. Run `pnpm type-check`, and add an entry to each record it reports. These include the Chat model fetcher, the client config, the error handlers, the provider test matrix, and the frontend key form.

<span id="openai-compatible-providers"></span>

### Build an OpenAI-Compatible Provider

- **Types:** create `backend/src/types/llm-providers/<provider>/` with `api.ts`, `messages.ts`, `tools.ts`, and `index.ts`. Re-export OpenAI's schemas with `.passthrough()` to keep custom fields. Export the namespace from `backend/src/types/llm-providers/index.ts`.
- **Adapter:** create `backend/src/routes/proxy/adapters/<provider>.ts` with `createOpenAiCompatibleAdapterFactory`, and export it from `adapters/index.ts`.
- **Proxy route:** copy `backend/src/routes/proxy/routes/deepseek.ts`. Register the route IDs in `shared/routes.ts`, export the plugin from `backend/src/routes/index.ts`, and add it to `registerWorkerRoutes` in `backend/src/server.ts`.
- **Configuration:** in `backend/src/config.ts`, expose `llm.<provider>.baseUrl` and `chat.<provider>.apiKey`. Add both to `.env.example` and to the [Configuration](/docs/admin/deployment/configuration) reference.

<span id="native-api-providers"></span>

### Build a Provider With Its Own API

A provider with its own wire format, such as Anthropic, Gemini, Bedrock, or Cohere, also needs:

1. Zod request, response, message, and tool schemas in `backend/src/types/llm-providers/<provider>/`.
2. Implementations of `LLMRequestAdapter`, `LLMResponseAdapter`, `LLMStreamAdapter`, and `LLMProvider` from `backend/src/types/llm-provider.ts`.
3. A translator to and from OpenAI Chat Completions, in `backend/src/routes/proxy/adapters/<provider>-openai.ts` and `<provider>-openai-translator.ts`, with a matching test.

<span id="additional-registrations-and-testing"></span>

### Finish the Steps the Compiler Misses

- **Model sync:** map the provider's models.dev ID in `MODELS_DEV_PROVIDER_MAP` in `shared/model-constants.ts`, so model metadata and prices sync.
- **Logos:** add `frontend/public/icons/<provider>.png` for the API key form, and a monochrome `frontend/public/model-logos/<provider>.svg` mapped in `providerToLogoProvider` in `frontend/src/lib/provider-logos.ts`.
- **Model Router:** to make the provider routable, add it to `MODEL_ROUTER_SUPPORTED_PROVIDERS` and to the router's maps in `backend/src/routes/proxy/routes/model-router.ts`. A native provider also needs a case in `getTranslatedModelRouterProvider`.
- **OpenCode:** to offer it in OpenCode, add it to `OPENCODE_PASSTHROUGH_PROVIDER_ROUTES` in `shared/opencode-provider-routes.ts`.
- **Docs:** add a row to the provider table in `../docs/pages/llm-proxy/providers/index.md`.

To check it works, run the provider matrix, then walk `PROVIDER_SMOKE_TEST.md` in the running app:

```bash
pnpm --dir backend exec vitest run src/routes/proxy/routes/provider-matrix.rollback.test.ts
```

- The server refuses to start when the Model Router lists in `shared/` and `model-router.ts` disagree. `type-check` does not catch this.

<span id="adding-knowledge-connectors"></span>

## Add a Knowledge Connector

Sync an issue tracker, wiki, or drive into a [knowledge base](/docs/knowledge/connectors) on a schedule, so agents can answer from it. A connector is a backend class with a config schema, a checkpoint schema, and a generator that yields document batches.

<span id="typescript-guided-changes-1"></span><span id="schemas-and-connector-class"></span>

### Define the Schemas

In `backend/src/types/knowledge-connector.ts`, add a type literal and the two schemas. Use `connectorUrlSchema` for URL fields:

```typescript
const ACME = z.literal("acme");

export const AcmeConfigSchema = z.object({
  type: ACME,
  acmeBaseUrl: connectorUrlSchema,
  projectKeys: z.array(z.string()).optional(),
});

export const AcmeCheckpointSchema = z.object({
  type: ACME,
  lastSyncedAt: z.string().optional(),
});
```

Then add `ACME` to `USER_SELECTABLE_CONNECTOR_TYPES`, and both schemas to the `ConnectorConfigSchema` and `ConnectorCheckpointSchema` unions. `type-check` does not flag a schema missing from a union.

### Write the Connector

Create `backend/src/knowledge-base/connectors/acme/acme-connector.ts`, extending `BaseConnector`:

- `validateConfig(config)` checks the config and returns `{ valid, error? }`.
- `testConnection({ config, credentials })` proves the credentials work with one light API call.
- `sync({ config, credentials, checkpoint })` is an async generator that yields document batches with updated checkpoints. Pass the newest item's timestamp to `buildCheckpoint`, not the clock time.
- Call the API through `fetchWithRetry()`, which has a 30-second timeout and exponential backoff, and `rateLimit()`.

<span id="registration-and-ui"></span>

### Register It

1. Add the factory to `connectorRegistry` in `backend/src/knowledge-base/connectors/registry.ts`, and the display name to `CONNECTOR_TYPE_LABELS` in `shared/knowledge-base.ts`.
2. Run `pnpm codegen`, then `pnpm type-check` to find what the frontend form needs.
3. Create `frontend/src/app/knowledge/knowledge-bases/_parts/acme-config-fields.tsx` and register it in `connector-dialog-config.tsx`.
4. Add the icon to `frontend/public/icons/` and to `CONNECTOR_ICON_MAP` in `_parts/connector-icons.tsx`. `type-check` does not flag a missing icon.
5. Add `../docs/pages/knowledge/connectors/acme.md`, and a row with a `<span id="acme">` anchor in the connectors index. The connector dialog's docs link points at that anchor.

To check it works, add tests in `acme-connector.test.ts` and run them:

```bash
pnpm --dir backend exec vitest run src/knowledge-base/connectors/acme
```

<span id="adding-knowledge-retrieval-backends"></span>

## Add a Retrieval Backend

Swap the search index without touching ingestion, querying, or access control. PostgreSQL with pgvector is the only backend Archestra ships. An external index ranks results, while PostgreSQL stays the store for documents, access control, and citations.

<span id="the-contract"></span>

### Implement the Interface

Implement every method of `KnowledgeRetrievalBackend` from `backend/src/knowledge-base/retrieval-backend.ts`, in `retrieval-backends/<name>/<name>-retrieval-backend.ts`. `backend/src/knowledge-base/RETRIEVAL_BACKENDS.md` explains each method and the guarantees it must keep.

<span id="security-and-verification"></span>

Set `requiresResultVerification = true` on an external backend. Archestra then reloads every candidate chunk from PostgreSQL and reapplies the connector, ACL, environment, and metadata-filter scope. The external index supplies only the ranking.

<span id="registration-and-configuration"></span>

### Wire It In

1. Expose the connection settings under `kb` in `backend/src/config.ts`, with matching `ARCHESTRA_KNOWLEDGE_BASE_*` variables in `.env.example` and the [Configuration](/docs/admin/deployment/configuration) reference.
2. Construct the backend in `backend/src/knowledge-base/retrieval-backends/registry.ts`. The registry has no selector yet, so add an enum setting and a switch where the singleton is built.
3. Add a document-deletion hook. PostgreSQL deletes chunks by foreign-key cascade, which an external index never sees.

To check it works, run the query suite. It includes an alternate backend that returns forged fields:

```bash
pnpm --dir backend exec vitest run src/knowledge-base/query.test.ts
```
