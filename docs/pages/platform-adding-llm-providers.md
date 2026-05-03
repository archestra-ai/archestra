---
title: Adding LLM Providers
category: Development
order: 2
description: Developer guide for implementing new LLM provider support in Archestra Platform
lastUpdated: 2026-04-29
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This is a development guide for adding new LLM providers to Archestra.
-->

## Overview

This guide covers how to add a new LLM provider to Archestra Platform. Each provider requires:

1. **[LLM Proxy](/docs/platform-llm-proxy)** - The proxy that sits between clients and LLM providers. Handles security policies, tool invocation controls, metrics, and observability. Clients send requests to the proxy, which forwards them to the provider. It must handle both streaming and non-streaming provider responses.

2. **[Chat](/docs/platform-chat)** - The built-in chat interface.

### Getting Started: Let TypeScript Guide You

The fastest way to find every file that needs updating is to add your provider's ID to the `SupportedProvidersSchema` enum in `shared/model-constants.ts` and then run `pnpm typecheck`. TypeScript will report compile errors everywhere a `Record<SupportedProvider, ...>` or exhaustive switch is missing your new provider — these are exactly the files you need to update.

Use the detailed sections below for guidance on _how_ to implement each piece.

## LLM Proxy

### Provider Registration

Defines the provider identity used throughout the codebase for type safety and runtime checks.

| File                        | Description                                                                    |
| --------------------------- | ------------------------------------------------------------------------------ |
| `shared/model-constants.ts` | Add provider to `SupportedProvidersSchema` enum                                |
| `shared/model-constants.ts` | Add to `SupportedProvidersDiscriminatorSchema` - format is `provider:endpoint` |
| `shared/model-constants.ts` | Add display name to `providerDisplayNames`                                     |

### Type Definitions

Each provider needs Zod schemas defining its API contract. TypeScript types are inferred from these schemas.

| File                                                     | Description                                                                                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/types/llm-providers/{provider}/api.ts`      | Request body schema, response schema, and headers schema (for extracting API keys)                                                 |
| `backend/src/types/llm-providers/{provider}/messages.ts` | Message array schemas - defines the structure of conversation history (user/assistant/tool messages)                               |
| `backend/src/types/llm-providers/{provider}/tools.ts`    | Tool definition schemas - how tools are declared in requests (function calling format)                                             |
| `backend/src/types/llm-providers/{provider}/index.ts`    | Namespace export that groups all types under `{Provider}.Types`                                                                    |
| `backend/src/types/llm-providers/index.ts`               | Export the provider namespace (e.g., `export { default as {Provider} } from "./{provider}"`)                                       |
| `backend/src/types/interaction.ts`                       | Add provider schemas to `InteractionRequestSchema`, `InteractionResponseSchema`, and `SelectInteractionSchema` discriminated union |

### Adapter Implementation

The adapter pattern provides a **provider-agnostic API** for business logic. LLMProxy operates entirely through adapters, never touching provider-specific types directly.

| File                                               | Description                                    |
| -------------------------------------------------- | ---------------------------------------------- |
| `backend/src/routes/proxy/adapters/{provider}.ts` | Implement all adapter classes                  |
| `backend/src/routes/proxy/adapters/index.ts`      | Export the `{provider}AdapterFactory` function |

**Adapters to Implement:**

- **RequestAdapter**: Provides read/write access for the request data (model, messages, tools);
- **ResponseAdapter**: Provides read/write access to the response data (id, model, text, tool calls, usage);
- **StreamAdapter**: Process streaming chunks incrementally, accumulating data required for the LLMProxy logic;
- **LLMProvider**: Create adapters, extract API keys from headers, create provider SDK clients, execute requests;

### Model Router Translator Layer

The Model Router exposes OpenAI-compatible Chat Completions and Responses endpoints. If the provider does not accept OpenAI request/response shapes natively, add translator adapters that convert between OpenAI schemas and the provider's native API.

| File                                                             | Description                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `backend/src/routes/proxy/adapters/{provider}-openai.ts`         | OpenAI-compatible adapter factory used by Model Router routes.                                                     |
| `backend/src/routes/proxy/adapters/{provider}-openai-translator.ts` | Request, response, and stream translation between OpenAI chat completions and the provider's native API.            |
| `backend/src/routes/proxy/adapters/openai-responses-from-chat.ts` | Shared helper for exposing OpenAI Responses API semantics through a chat-completions-backed provider implementation. |

Translator coverage should include non-streaming and streaming Chat Completions and Responses behavior. Add the provider to the model-router provider matrix tests so the route-level tests exercise the full request path.

### Route Handler

HTTP endpoint that receives client requests and delegates to `handleLLMProxy()`.

| File                                                    | Description                                                                                                                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/routes.ts`                                      | Add `RouteId` constants for the new provider (e.g., `{Provider}ChatCompletionsWithDefaultAgent`, `{Provider}ChatCompletionsWithAgent`)                                                              |
| `backend/src/routes/proxy/routes/{provider}.ts`       | Fastify route that validates request and calls `handleLLMProxy(body, request, reply, adapterFactory)`. Agent ID, headers, and all context are extracted from the Fastify request object internally. |
| `backend/src/routes/proxy/routes/proxy-prehandler.ts` | Shared `createProxyPreHandler()` utility — use this when registering `fastifyHttpProxy` to handle UUID stripping and endpoint exclusion (see example below)                                         |
| `backend/src/routes/index.ts`                           | Export the new route module                                                                                                                                                                         |
| `backend/src/server.ts`                                 | Register the route with Fastify and add request/response schemas to the global Zod registry for OpenAPI generation                                                                                  |

> **Important: Deterministic Codegen**
>
> Routes must **always be registered** regardless of whether the provider is enabled. This ensures OpenAPI schema generation is deterministic across environments.
>
> - Register routes unconditionally (for schema generation)
> - Conditionally register HTTP proxy only when provider is enabled (has `baseUrl` configured)
> - Return a 500 error in route handlers if provider is not configured at runtime
>
> ```typescript
> // ✅ Correct: Routes always registered, proxy conditionally registered
> if (config.llm.{provider}.enabled) {
>   await fastify.register(fastifyHttpProxy, {
>     upstream: config.llm.{provider}.baseUrl as string,
>     prefix: API_PREFIX,
>     rewritePrefix: "",
>     preHandler: createProxyPreHandler({
>       apiPrefix: API_PREFIX,
>       endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
>       upstream: config.llm.{provider}.baseUrl as string,
>       providerName: "{Provider}",
>       rewritePrefix: "",  // match the rewritePrefix above
>     }),
>   });
> }
>
> // In route handlers, check at runtime:
> if (!config.llm.{provider}.enabled) {
>   return reply.status(500).send({
>     error: { message: "{Provider} is not configured. Set ARCHESTRA_{PROVIDER}_BASE_URL to enable.", type: "api_internal_server_error" }
>   });
> }
> ```

### Configuration

Base URL configuration allows routing to custom endpoints (e.g., Azure OpenAI, local proxies, testing mocks).

| File                    | Description                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/config.ts` | Add `llm.{provider}.baseUrl` and `llm.{provider}.enabled` (typically `Boolean(baseUrl)`) with environment variable (e.g., `ARCHESTRA_{PROVIDER}_BASE_URL`) |

> **Don't forget:** Document `ARCHESTRA_{PROVIDER}_BASE_URL` and `ARCHESTRA_CHAT_{PROVIDER}_API_KEY` in `docs/pages/platform-deployment.md` under the Environment Variables section.

### Tokenizer

> **Note:** This is a known abstraction leak that we're planning to address in future versions. Thanks for bearing with us!

Tokenizers estimate token counts for provider messages. Used by Model Optimization and Tool Results Compression.

| File                              | Description                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `backend/src/tokenizers/base.ts`  | Add provider message type to `ProviderMessage` union                                                         |
| `backend/src/tokenizers/base.ts`  | Update `BaseTokenizer.getMessageText()` if provider has a different message format                           |
| `backend/src/tokenizers/index.ts` | Add entry to `tokenizerFactories` record - return appropriate tokenizer (or fallback to `TiktokenTokenizer`) |

### Model Optimization

> **Note:** This is a known abstraction leak that we're planning to address in future versions. Thanks for bearing with us!

Model optimization evaluates token counts to switch to cheaper models when possible.

| File                                                  | Description                                                                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `backend/src/routes/proxy/utils/cost-optimization.ts` | Add provider to `ProviderMessages` type mapping (e.g., `gemini: Gemini.Types.GenerateContentRequest["contents"]`) |
| `backend/src/models/optimization-rule.ts`             | Add provider to default optimization rules structure (empty array placeholder for new providers)                  |

### Tool Results Compression

> **Note:** This is a known abstraction leak that we're planning to address in future versions. Thanks for bearing with us!

TOON (Token-Oriented Object Notation) compression converts JSON tool results to a more token-efficient format. Each provider needs its own implementation because message structures differ.

| File                                               | Description                                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/routes/proxy/adapters/{provider}.ts` | Implement `convertToolResultsToToon()` function that traverses provider-specific message array and compresses tool result content |

The function must:

1. Iterate through provider-specific message array structure
2. Find tool result messages (e.g., `role: "tool"` in OpenAI, `tool_result` blocks in Anthropic, `functionResponse` parts in Gemini)
3. Parse JSON content and convert to TOON format using `@toon-format/toon`
4. Calculate token savings using the appropriate tokenizer
5. Return compressed messages and compression statistics

### Metrics

> **Note:** This is a known abstraction leak that we're planning to address in future versions. Thanks for bearing with us!

Prometheus metrics for request duration, token usage, and costs. Requires instrumenting provider SDK clients.

For example: OpenAI and Anthropic SDKs accept a custom `fetch` function, so we inject an instrumented fetch via `getObservableFetch()`. Gemini SDK doesn't expose fetch, so we wrap the SDK instance directly via `getObservableGenAI()`.

| File                                               | Description                                                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `backend/src/llm-metrics.ts`                       | Add entry to `fetchUsageExtractors` record mapping provider to its `getUsageTokens()` extraction function |
| `backend/src/routes/proxy/adapters/{provider}.ts` | Export `getUsageTokens()` function for metrics token extraction                                           |

### Frontend: Logs UI

Interaction handlers parse stored request/response data for display in the LLM Proxy Logs UI (`/llm/logs`).

| File                                          | Description                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `frontend/src/lib/interactions/llmProviders/{provider}.ts` | Implement `InteractionUtils` interface for parsing provider-specific request/response JSON |
| `frontend/src/lib/interactions/interaction.utils.ts`       | Add case to `getInteractionClass()` switch to route discriminator to handler               |

### Testing

Provider onboarding uses backend Vitest for proxy behavior coverage and e2e tests for the current running-stack checks.

#### Backend Proxy Matrix

| File                                                  | Description                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/routes/proxy/routes/provider-matrix.test.ts` | Primary conformance suite for provider onboarding. Add the provider config, request builders, route plugin, adapter factory, and any provider-specific stream assertions. |
| `backend/src/test/llm-provider-stubs.ts` and route-local harnesses | Reuse or extend SDK-level stubs instead of adding WireMock mappings for proxy-only behavior.                                               |

The backend matrix covers:

- declared tool persistence
- execution ID persistence
- streaming tool call handling
- model optimization
- token cost limit enforcement
- TOON compression

The preferred test seam is the provider client created by `adapterFactory.createClient()`. Return a fake SDK-shaped client from the test and let the real route, handler, policy, persistence, and metrics code run around it.

#### Proxy E2E Tests

The current proxy e2e files are:

| File | Description |
| ---- | ----------- |
| `e2e-tests/tests/llm-proxy/tool-invocation.spec.ts` | End-to-end policy enforcement against the running stack. |
| `e2e-tests/tests/llm-proxy/jwks-auth.spec.ts` | Auth and JWKS smoke coverage. |
| `e2e-tests/tests/llm-proxy/virtual-api-keys.spec.ts` | Virtual key routing and custom base URL behavior. |
| `.github/values-ci.yaml` | Add provider base URL overrides when the remaining e2e coverage needs WireMock for that provider. |

For built-in chat coverage, add provider entries to `e2e-tests/tests/chat.spec.ts`.

## Chat Support

Below is the list of modifications required to support a new provider in the built-in Archestra Chat.

### Configuration

Environment variables for API keys and base URLs.

| File                    | Description                                |
| ----------------------- | ------------------------------------------ |
| `backend/src/config.ts` | Add `chat.{provider}.apiKey` and `baseUrl` |

### Model Listing

Each provider has a different API for listing available models.

| File                                                   | Description                                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `backend/src/routes/chat/model-fetchers/{provider}.ts` | Implement `fetch{Provider}Models()` for the provider's model listing API                             |
| `backend/src/routes/chat/model-fetchers/index.ts`      | Register the fetcher in the shared `modelFetchers` record                                            |
| `backend/src/routes/chat/model-fetchers/registry.ts`   | Update `fetchModelsForProvider()` only if the provider needs special auth or non-standard fetch flow |
| `backend/src/routes/chat/routes.api-keys.ts`           | Add provider-specific API key validation rules if needed                                             |

If the provider is keyless or uses cloud credentials instead of an API key, also update `backend/src/services/system-key-manager.ts`.

### LLM Client

Chat uses Vercel AI SDK which requires provider-specific model creation.

| File                                | Description                                                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/clients/llm-client.ts` | Add to `detectProviderFromModel()` - model naming conventions differ (e.g., `gpt-*`, `claude-*`)                                          |
| `backend/src/clients/llm-client.ts` | Add case to `resolveProviderApiKey()` switch                                                                                              |
| `backend/src/clients/llm-client.ts` | Add entry to `providerModelConfigs` registry - defines SDK initialization, default base URL, API key requirement, and proxied path suffix |

### Error Handling

Each provider SDK wraps errors differently, requiring provider-specific parsing.

| File                                | Description                                                             |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `shared/chat-error.ts`              | Add `{Provider}ErrorTypes` constants                                    |
| `backend/src/routes/chat/errors.ts` | Add `parse{Provider}Error()` and `map{Provider}ErrorToCode()` functions |

### Frontend UI

UI components for Chat need provider-specific configuration.

| File                                              | Description                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `frontend/public/icons/{provider}.png`            | Provider logo (64x64px PNG recommended)                                                                    |
| `frontend/src/components/chat/model-selector.tsx` | Add provider to `providerToLogoProvider` mapping                                                           |
| `frontend/src/components/chat-api-key-form.tsx`   | Add provider entry to `PROVIDER_CONFIG` with name, icon path, placeholder, and console URL                 |
| `frontend/src/app/chat/page.tsx`                  | Update `hasValidApiKey` logic if provider doesn't require API key (e.g., local providers like vLLM/Ollama) |

## Reference Implementations

Existing provider implementations for reference:

**Full implementations** (custom API formats):

- OpenAI: `backend/src/routes/proxy/routes/openai.ts`, `backend/src/routes/proxy/adapters/openai.ts`
- Anthropic: `backend/src/routes/proxy/routes/anthropic.ts`, `backend/src/routes/proxy/adapters/anthropic.ts`
- Cohere: `backend/src/routes/proxy/routes/cohere.ts`, `backend/src/routes/proxy/adapters/cohere.ts`
- Gemini: `backend/src/routes/proxy/routes/gemini.ts`, `backend/src/routes/proxy/adapters/gemini.ts`
- Bedrock: `backend/src/routes/proxy/routes/bedrock.ts`, `backend/src/routes/proxy/adapters/bedrock.ts` (uses AWS Signature V4 auth and Converse API)

**OpenAI-compatible implementations** (reuse OpenAI types/adapters with minor modifications):

- Groq: `backend/src/routes/proxy/routes/groq.ts`, `backend/src/routes/proxy/adapters/groq.ts` (best starting point — cleanest example of OpenAI reuse)
- xAI: `backend/src/routes/proxy/routes/xai.ts`, `backend/src/routes/proxy/adapters/xai.ts`
- Azure AI Foundry: `backend/src/routes/proxy/routes/azure.ts`, `backend/src/routes/proxy/adapters/azure.ts` (reference for providers requiring custom request mutation — injects `api-version` query param via a custom `fetch` wrapper in `llm-client.ts` for the built-in chat feature, since the Vercel AI SDK's `createOpenAI()` has no `defaultQuery` option)
- vLLM: `backend/src/routes/proxy/routes/vllm.ts`, `backend/src/routes/proxy/adapters/vllm.ts`
- Ollama: `backend/src/routes/proxy/routes/ollama.ts`, `backend/src/routes/proxy/adapters/ollama.ts`
- ZhipuAI: `backend/src/routes/proxy/routes/zhipuai.ts`, `backend/src/routes/proxy/adapters/zhipuai.ts`

> **Tip:** If adding support for an OpenAI-compatible provider (e.g., Together AI), use the Groq implementation as a starting point — it re-exports OpenAI's type definitions, message schemas, and tool schemas with minimal boilerplate. For providers that require custom query parameters on every request, see the Azure AI Foundry implementation for the `fetchWithVersion` pattern.

## Smoke Testing

Use [PROVIDER_SMOKE_TEST.md](https://github.com/archestra-ai/archestra/blob/main/platform/PROVIDER_SMOKE_TEST.md) during development to verify basic functionality. This is a quick, non-exhaustive list.

Note, that Archestra Chat uses streaming for all LLM interactions. To test non-streaming responses, use an external client like n8n Chat node.
