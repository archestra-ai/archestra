---
title: Adding LLM Providers
category: Development
order: 2
description: Developer guide for implementing new LLM provider support in Archestra Platform
lastUpdated: 2026-01-27
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This is a development guide for adding new LLM providers to Archestra.
-->

## Overview

This guide covers how to add a new LLM provider to Archestra Platform. Each provider requires:

1. **[LLM Proxy](/docs/platform-llm-proxy)** - The proxy that sits between clients and LLM providers. Handles security policies, tool invocation controls, metrics, and observability. Clients send requests to the proxy, which forwards them to the provider. It must handle both streaming and non-streaming provider responses.

2. **[Chat](/docs/platform-chat)** - The built-in chat interface.

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
| `backend/src/routes/proxy/adapterV2/{provider}.ts` | Implement all adapter classes                  |
| `backend/src/routes/proxy/adapterV2/index.ts`      | Export the `{provider}AdapterFactory` function |

**Adapters to Implement:**

- **RequestAdapter**: Provides read/write access for the request data (model, messages, tools);
- **ResponseAdapter**: Provides read/write access to the response data (id, model, text, tool calls, usage);
- **StreamAdapter**: Process streaming chunks incrementally, accumulating data required for the LLMProxy logic;
- **LLMProvider**: Create adapters, extract API keys from headers, create provider SDK clients, execute requests;

### Route Handler

HTTP endpoint that receives client requests and delegates to `handleLLMProxy()`.

| File                                              | Description                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/routes.ts`                                | Add `RouteId` constants for the new provider (e.g., `{Provider}ChatCompletionsWithDefaultAgent`, `{Provider}ChatCompletionsWithAgent`)               |
| `backend/src/routes/proxy/routesv2/{provider}.ts` | Fastify route that validates request, extracts context (agent ID, org ID), and calls `handleLLMProxy(body, headers, reply, adapterFactory, context)` |
| `backend/src/routes/index.ts`                     | Export the new route module                                                                                                                          |
| `backend/src/server.ts`                           | Register the route with Fastify and add request/response schemas to the global Zod registry for OpenAPI generation                                   |

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
>   await fastify.register(fastifyHttpProxy, { upstream: config.llm.{provider}.baseUrl as string, ... });
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

### Feature Flags

Expose provider availability to the frontend for conditional UI rendering.

| File                             | Description                                                         |
| -------------------------------- | ------------------------------------------------------------------- |
| `backend/src/routes/features.ts` | Add `{provider}Enabled` boolean to the features schema and response |

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
| `backend/src/routes/proxy/adapterV2/{provider}.ts` | Implement `convertToolResultsToToon()` function that traverses provider-specific message array and compresses tool result content |

The function must:

1. Iterate through provider-specific message array structure
2. Find tool result messages (e.g., `role: "tool"` in OpenAI, `tool_result` blocks in Anthropic, `functionResponse` parts in Gemini)
3. Parse JSON content and convert to TOON format using `@toon-format/toon`
4. Calculate token savings using the appropriate tokenizer
5. Return compressed messages and compression statistics

### Dual LLM

> **Note:** This is a known abstraction leak that we're planning to address in future versions. Thanks for bearing with us!

Dual LLM pattern uses a secondary LLM for Q&A verification of tool invocations. Each provider needs its own client implementation.

| File                                     | Description                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/clients/dual-llm-client.ts` | Create `{Provider}DualLlmClient` class implementing `DualLlmClient` interface with `chat()` and `chatWithSchema()` methods |
| `backend/src/clients/dual-llm-client.ts` | Add entry to `dualLlmClientFactories` record                                                                               |

### Metrics

> **Note:** This is a known abstraction leak that we're planning to address in future versions. Thanks for bearing with us!

Prometheus metrics for request duration, token usage, and costs. Requires instrumenting provider SDK clients.

For example: OpenAI and Anthropic SDKs accept a custom `fetch` function, so we inject an instrumented fetch via `getObservableFetch()`. Gemini SDK doesn't expose fetch, so we wrap the SDK instance directly via `getObservableGenAI()`.

| File                                               | Description                                                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `backend/src/llm-metrics.ts`                       | Add entry to `fetchUsageExtractors` record mapping provider to its `getUsageTokens()` extraction function |
| `backend/src/routes/proxy/adapterV2/{provider}.ts` | Export `getUsageTokens()` function for metrics token extraction                                           |

### Frontend: Logs UI

Interaction handlers parse stored request/response data for display in the LLM Proxy Logs UI (`/logs/llm-proxy`).

| File                                          | Description                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `frontend/src/lib/llmProviders/{provider}.ts` | Implement `InteractionUtils` interface for parsing provider-specific request/response JSON |
| `frontend/src/lib/interaction.utils.ts`       | Add case to `getInteractionClass()` switch to route discriminator to handler               |

### E2E Tests

Each provider must be added to the LLM Proxy and Chat UI e2e tests to ensure all features work correctly.

#### LLM Proxy E2E Tests

| File                                                            | Description                                                                                                                              |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `helm/e2e-tests/mappings/{provider}-*.json`                     | WireMock stub mappings for mocking provider API responses (models list, chat completions, tool calls, etc.)                              |
| `helm/e2e-tests/mappings/{provider}-chat-ui-e2e-test.json`      | WireMock stub mapping for Chat UI streaming responses - must use SSE format with `bodyPatterns` matching on `chat-ui-e2e-test`           |
| `.github/values-ci.yaml`                                        | Add provider base URL pointing to WireMock (e.g., `ARCHESTRA_{PROVIDER}_BASE_URL: "http://e2e-tests-wiremock:8080/v1"`)                  |
| `e2e-tests/tests/api/llm-proxy/tool-invocation.spec.ts`         | Tool invocation policy tests - add `{provider}Config` to `testConfigs` array                                                             |
| `e2e-tests/tests/api/llm-proxy/tool-persistence.spec.ts`        | Tool call persistence tests - add `{provider}Config` to `testConfigs` array                                                              |
| `e2e-tests/tests/api/llm-proxy/tool-result-compression.spec.ts` | TOON compression tests - add `{provider}Config` to `testConfigs` array                                                                   |
| `e2e-tests/tests/api/llm-proxy/model-optimization.spec.ts`      | Model optimization tests - add `{provider}Config` to `testConfigs` array                                                                 |
| `e2e-tests/tests/api/llm-proxy/token-cost-limits.spec.ts`       | Token cost limits tests - add `{provider}Config` to `testConfigs` array                                                                  |
| `e2e-tests/tests/ui/chat.spec.ts`                               | Chat UI tests - add `{provider}Config` to `testConfigs` array with `providerName`, `modelId`, `modelDisplayName`, and `expectedResponse` |

## Chat Support

Below is the list of modifications required to support a new provider in the built-in Archestra Chat.

### Configuration

Environment variables for API keys and base URLs.

| File                    | Description                                |
| ----------------------- | ------------------------------------------ |
| `backend/src/config.ts` | Add `chat.{provider}.apiKey` and `baseUrl` |

### Chat Provider Registration

Allows users to select this provider's models in the Chat UI.

| File                                | Description                          |
| ----------------------------------- | ------------------------------------ |
| `backend/src/types/chat-api-key.ts` | Add to `SupportedChatProviderSchema` |

### Model Listing

Each provider has a different API for listing available models.

| File                                       | Description                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `backend/src/routes/chat/routes.models.ts` | Add `fetch{Provider}Models()` function and register in `modelFetchers` |
| `backend/src/routes/chat/routes.models.ts` | Add case to `getProviderApiKey()` switch                               |

### LLM Client

Chat uses Vercel AI SDK which requires provider-specific model creation.

| File                                | Description                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `backend/src/clients/llm-client.ts` | Add to `detectProviderFromModel()` - model naming conventions differ (e.g., `gpt-*`, `claude-*`) |
| `backend/src/clients/llm-client.ts` | Add case to `resolveProviderApiKey()` switch                                                     |
| `backend/src/clients/llm-client.ts` | Add case to `createLLMModel()` - AI SDK requires provider-specific initialization                |

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

- OpenAI: `backend/src/routes/proxy/routesv2/openai.ts`, `backend/src/routes/proxy/adapterV2/openai.ts`
- Anthropic: `backend/src/routes/proxy/routesv2/anthropic.ts`, `backend/src/routes/proxy/adapterV2/anthropic.ts`
- Cohere: `backend/src/routes/proxy/routesv2/cohere.ts`, `backend/src/routes/proxy/adapterV2/cohere.ts`
- Gemini: `backend/src/routes/proxy/routesv2/gemini.ts`, `backend/src/routes/proxy/adapterV2/gemini.ts`

**OpenAI-compatible implementations** (reuse OpenAI types/adapters with minor modifications):

- vLLM: `backend/src/routes/proxy/routesv2/vllm.ts`, `backend/src/routes/proxy/adapterV2/vllm.ts`
- Ollama: `backend/src/routes/proxy/routesv2/ollama.ts`, `backend/src/routes/proxy/adapterV2/ollama.ts`
- ZhipuAI: `backend/src/routes/proxy/routesv2/zhipuai.ts`, `backend/src/routes/proxy/adapterV2/zhipuai.ts`

> **Tip:** If adding support for an OpenAI-compatible provider (e.g., Azure OpenAI, Together AI, Groq), use the vLLM/Ollama/ZhipuAI implementations as starting points - they reuse OpenAI's type definitions and adapters.

## Smoke Testing

Use [PROVIDER_SMOKE_TEST.md](https://github.com/archestra-ai/archestra/blob/main/platform/PROVIDER_SMOKE_TEST.md) during development to verify basic functionality. This is a quick, non-exhaustive list.

Note, that Archestra Chat uses streaming for all LLM interactions. To test non-streaming responses, use an external client like n8n Chat node.
