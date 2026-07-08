---
name: archestra-dev-llm-providers
description: Use when adding an LLM provider, changing proxy adapters or provider routes, fixing streaming/tool-call translation bugs, editing model fetchers or model handling, or touching provider credentials/enums and model constants.
---

# Archestra LLM Providers & Proxy

Use this skill before adding an LLM provider or changing provider translation, streaming, or model handling. Run commands from `platform/` unless specifically instructed otherwise.

## Provider surface map

One provider touches all of these (use `github-copilot` as the worked example — it is the most recent full addition):

- `backend/src/types/llm-providers/<provider>/` — `api.ts`, `messages.ts`, `tools.ts`, `index.ts` (some also have `models.ts`). `index.ts` default-exports a namespace (e.g. `GithubCopilot`) with `API`/`Messages`/`Tools` plus a `Types` sub-namespace; register it in `types/llm-providers/index.ts`. OpenAI-compatible providers re-export OpenAI schemas with `.passthrough()`.
- `backend/src/routes/proxy/adapters/<provider>.ts` — exports `<provider>AdapterFactory`; re-export it from `adapters/index.ts`.
- `backend/src/routes/proxy/routes/<provider>.ts` — Fastify plugin: `fastifyHttpProxy` catch-all with `createProxyPreHandler` (from `proxy-prehandler.ts`), explicit `POST .../chat/completions` handlers (default-agent and `:agentId` variants) calling `handleLLMProxy`, and model-listing GETs via `proxy-model-listing.ts`. Register the plugin in BOTH places: re-export it from `backend/src/routes/index.ts` (the main API surface iterates `Object.values(routes)`) AND add it to `registerWorkerRoutes` in `server.ts`.
- `shared/model-constants.ts` — add to `SupportedProvidersSchema`, `SupportedProvidersDiscriminatorSchema` (`<provider>:chatCompletions` for OpenAI-compatible; others name their API shape, e.g. `anthropic:messages`, `bedrock:converse`), and `providerDisplayNames`. Membership in `PROVIDERS_WITH_OPTIONAL_API_KEY`, `PROVIDERS_REQUIRING_BASE_URL`, and `PROVIDERS_REQUIRING_PER_USER_CREDENTIAL` silently changes auth behavior: per-user-credential providers get personal-scope keys only, no team/org/env fallback (see the `github-copilot` rationale comment there).
- `backend/src/routes/chat/model-fetchers/` — add a fetcher and register it in the `modelFetchers` record in `model-fetchers/index.ts`; its `Record<SupportedProvider, ModelFetcher>` type makes a missing provider a compile error. `registry.ts#testProviderApiKey` uses it to validate keys on creation. Simple bearer `/models` endpoints reuse `makeBearerFetcher`/`makeStaticFetcher` from `bearer-fetcher.ts`.
- Message normalization for the chat feature lives in `backend/src/routes/chat/normalization/` (notably `prepare-for-provider.ts`) and `prepare-model-messages.ts` — provider-specific message-shape rules go here, not in the proxy adapters.
- Frontend: provider key management at `frontend/src/app/llm/model-providers/page.tsx` + `frontend/src/components/create-llm-provider-api-key-dialog.tsx`; provider icon at `frontend/public/icons/<provider>.png`; model pickers (`components/llm-model-select.tsx`, `components/chat/model-selector.tsx`) use `providerDisplayNames`.
- Also: `backend/src/config.ts` + `.env.example` for base-URL/key env vars, `../docs/pages/platform-supported-llm-providers.md`.

## Default path: OpenAI-compatible

- Most new providers are OpenAI-compatible. Do not hand-roll a translator: call `createOpenAiCompatibleAdapterFactory` from `adapters/openai-compatible-adapter.ts` with `provider`, `interactionType`, `getBaseUrl`, and `createClient` — it reuses `OpenAIRequestAdapter`/`OpenAIResponseAdapter`/`OpenAIStreamAdapter` wholesale. See `adapters/deepseek.ts` (minimal) and `adapters/github-copilot.ts` (custom auth via a fetch wrapper, since `createClient` is synchronous).
- Providers with genuinely different wire formats get translator modules next to the adapter (`gemini-openai-translator.ts`, `bedrock-openai-translator.ts`, `cohere-openai-translator.ts`, `anthropic-openai-translator.ts`) — fix translation bugs there, with a matching `*.test.ts`.

## Guard rails

- `backend/src/routes/proxy/routes/provider-matrix.test.ts` — `providerConfigsByProvider` is `satisfies Record<SupportedProvider, ProviderTestConfig>`, so adding a provider to the enum without a matrix entry (route plugin + adapter factory + endpoints) fails typecheck. The suite then exercises every provider's real route with a mocked client: declared-tool persistence, execution IDs, streaming tool calls, cost-optimized model substitution, TOON compression, and limit blocking.
- The `modelFetchers` record (above) enforces the same exhaustiveness for model listing.

## Translation gotchas (real handling, check before "fixing")

- **Empty assistant turns**: `convertToModelMessages` can produce assistant messages with empty content that providers reject. `buildModelMessagesForProvider` in `routes/chat/prepare-model-messages.ts` filters them (`isEmptyAssistantModelMessage`) and then repairs unanswered tool calls (`ensureToolCallsHaveResults`) so `tool_use`/`tool_result` adjacency holds. The Cohere proxy adapter (`adapters/cohere.ts`) does its own empty-assistant filtering.
- **Tool-call name repair**: harmony-format models leak reasoning-channel sentinels into tool names (`name<|channel|>commentary`). `routes/chat/tool-call-repair.ts#repairHarmonyToolName` strips them, gated on an exact match against registered tools; wired via `experimental_repairToolCall` in `routes/chat/routes.ts`.
- **Provider message-shape rules**: Gemini requires the first non-system turn to be from the user — `ensureGeminiLeadingUserTurn` in `prepare-model-messages.ts` prepends one. Bedrock content rules (every message non-empty, user messages need a text part) are enforced in `normalization/prepare-for-provider.ts` (`ensureBedrockMessageHasContent`, `ensureBedrockUserMessageHasTextPart`); the same file decides per provider whether text documents stay native `document` blocks (Anthropic/Bedrock) or are inlined as decoded text (everyone else).
- **Output-token ceilings**: `agents/agent-output-budget.ts#resolveAgentMaxOutputTokens` clamps `maxOutputTokens` to the model's real output limit from model metadata (`sanitizeOutputLimit` from `clients/models-dev-client.ts`, 8192 fallback) and the operator ceiling — don't hardcode max-token values.

## Validation

```bash
cd backend && npx vitest run src/routes/proxy/routes/provider-matrix.test.ts
cd backend && npx vitest run src/routes/proxy/adapters/<provider>*.test.ts   # adapter/translator unit tests
pnpm type-check
```

- Manual end-to-end check: `PROVIDER_SMOKE_TEST.md` (repo root of `platform/`) is a browser-automation smoke runbook covering chat, policies, TOON, and proxy flows — run it after provider/proxy changes that unit tests can't cover.

## Related skills

- `archestra-dev-backend` — general route/codegen/permission conventions (route shape, `RouteId`, endpoint permissions).
- `archestra-dev-backend-tests` — vitest projects, mocking rules, DB fixtures for the tests above.
