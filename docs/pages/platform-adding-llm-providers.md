---
title: Adding LLM Providers
category: Development
order: 2
description: Developer guide for implementing new LLM provider support in Archestra Platform
lastUpdated: 2026-01-02
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This is an internal development guide for adding new LLM providers to Archestra.
-->

## Overview

This guide documents all files that need to be created or modified when adding a new LLM provider to Archestra Platform.

## LLM Proxy Support (Required)

These files are required for any new provider to work with the LLM Proxy (external clients calling through Archestra).

### Provider Registration

Defines the provider identity used throughout the codebase for type safety and runtime checks.

| File | Action | Description |
|------|--------|-------------|
| `shared/model-constants.ts` | Modify | Add to `SupportedProvidersSchema` enum (e.g., `"openai"`, `"anthropic"`) |
| `shared/model-constants.ts` | Modify | Add to `SupportedProvidersDiscriminatorSchema` - format is `provider:endpoint` (e.g., `"openai:chatCompletions"`, `"anthropic:messages"`) used for database storage and frontend routing |
| `shared/model-constants.ts` | Modify | Add display name to `providerDisplayNames` for UI labels |

### Type Definitions

Zod schemas that define the provider's API contract. Used for request validation, TypeScript type generation, and documentation.

| File | Action | Description |
|------|--------|-------------|
| `backend/src/types/llm-providers/{provider}/api.ts` | Create | Request body schema (e.g., `ChatCompletionsRequestSchema`), response schema, and headers schema (for extracting API keys) |
| `backend/src/types/llm-providers/{provider}/messages.ts` | Create | Message array schemas - defines the structure of conversation history (user/assistant/tool messages) |
| `backend/src/types/llm-providers/{provider}/tools.ts` | Create | Tool definition schemas - how tools are declared in requests (function calling format) |
| `backend/src/types/llm-providers/{provider}/index.ts` | Create | Namespace export that groups all types under `{Provider}.Types` |

### Adapter Implementation

The adapter pattern provides a **provider-agnostic API** for business logic. The `handleLLMProxy()` function operates entirely through adapters, never touching provider-specific types directly.

| File | Action | Description |
|------|--------|-------------|
| `backend/src/routes/proxy/adapterV2/{provider}.ts` | Create | Implement all adapter classes (see [Adapter Interfaces](#adapter-interfaces) below) |
| `backend/src/routes/proxy/adapterV2/index.ts` | Modify | Export the `{provider}AdapterFactory` function |

**What each adapter enables:**

- **RequestAdapter**: Read request data (model, messages, tools) in common format; modify model for cost optimization; update tool results for trusted data policies and TOON compression
- **ResponseAdapter**: Read response data (id, model, text, tool calls, usage) in common format; generate refusal responses when tools are blocked
- **StreamAdapter**: Process chunks incrementally; accumulate state for metrics; hold tool call chunks for policy evaluation; format SSE events for client streaming
- **AdapterFactory**: Create adapters, extract API keys from headers, create provider SDK clients, execute requests

### Route Handler

HTTP endpoint that receives client requests and delegates to `handleLLMProxy()`.

| File | Action | Description |
|------|--------|-------------|
| `backend/src/routes/proxy/{provider}.ts` | Create | Fastify route that validates request, extracts context (agent ID, org ID), and calls `handleLLMProxy(body, headers, reply, adapterFactory, context)` |
| `backend/src/routes/index.ts` | Modify | Export the new route module |
| `backend/src/server.ts` | Modify | Register the route with the Fastify instance |

### Configuration

Base URL configuration allows routing to custom endpoints (e.g., Azure OpenAI, local proxies, testing mocks).

| File | Action | Description |
|------|--------|-------------|
| `backend/src/config.ts` | Modify | Add `llm.{provider}.baseUrl` with environment variable (e.g., `ARCHESTRA_OPENAI_BASE_URL`) and sensible default |

### Abstraction Leaks: Cost Optimization

Cost optimization evaluates token counts to switch to cheaper models when possible. Requires provider-specific message types for accurate token counting.

| File | Action | Description |
|------|--------|-------------|
| `backend/src/routes/proxy/utils/cost-optimization.ts` | Modify | Add provider to `ProviderMessages` type mapping (e.g., `gemini: Gemini.Types.GenerateContentRequest["contents"]`) |
| `backend/src/tokenizers/base.ts` | Modify | Add provider message type to `ProviderMessage` union for the base tokenizer |
| `backend/src/tokenizers/index.ts` | Modify | Add case to `getTokenizer()` switch - return appropriate tokenizer (or fallback to `TiktokenTokenizer`) |

### Abstraction Leaks: TOON Compression

TOON (Token-Oriented Object Notation) compression converts JSON tool results to a more token-efficient format. Each provider needs its own implementation because message structures differ.

| File | Action | Description |
|------|--------|-------------|
| `backend/src/routes/proxy/adapterV2/{provider}.ts` | Create | Implement `convertToolResultsToToon()` function that traverses provider-specific message array and compresses tool result content |

The function must:
1. Iterate through provider-specific message array structure
2. Find tool result messages (e.g., `role: "tool"` in OpenAI, `tool_result` blocks in Anthropic, `functionResponse` parts in Gemini)
3. Parse JSON content and convert to TOON format using `@toon-format/toon`
4. Calculate token savings using the appropriate tokenizer
5. Return compressed messages and compression statistics

### Abstraction Leaks: Dual LLM

Dual LLM pattern uses a secondary LLM for Q&A verification of tool invocations. Each provider needs its own client implementation.

| File | Action | Description |
|------|--------|-------------|
| `backend/src/routes/proxy/utils/dual-llm-client.ts` | Modify | Create `{Provider}DualLlmClient` class implementing `DualLlmClient` interface with `chat()` and `chatWithSchema()` methods |
| `backend/src/routes/proxy/utils/dual-llm-client.ts` | Modify | Add case to `createDualLlmClient()` factory switch |

### Abstraction Leaks: Metrics

Prometheus metrics for request duration, token usage, costs, and streaming performance. Requires wrapping provider SDK clients.

| File | Action | Description |
|------|--------|-------------|
| `backend/src/llm-metrics.ts` | Modify | For fetch-based SDKs (OpenAI, Anthropic): add usage extraction logic to `getObservableFetch()` |
| `backend/src/llm-metrics.ts` | Modify | For non-fetch SDKs (Gemini): create wrapper function like `getObservableGenAI()` that instruments the client |


### Frontend: Logs UI

Interaction handlers parse stored request/response data for display in the LLM Proxy Logs UI (`/logs/llm-proxy`).

| File | Action | Description |
|------|--------|-------------|
| `frontend/src/lib/llmProviders/{provider}.ts` | Create | Implement `InteractionUtils` interface for parsing provider-specific request/response JSON |
| `frontend/src/lib/interaction.utils.ts` | Modify | Add case to `getInteractionClass()` switch to route discriminator to handler |

## Chat Support (Optional)

These files are only needed if you want the provider available in the built-in Archestra Chat (`/chat`). Skip these for LLM Proxy-only providers.

| Category | File | Action | Description |
|----------|------|--------|-------------|
| **Configuration** | `backend/src/config.ts` | Modify | Add `chat.{provider}.apiKey` and `baseUrl` |
| **Chat Models** | `backend/src/routes/chat-models.ts` | Modify | Add `fetch{Provider}Models()` function |
| | `backend/src/routes/chat-models.ts` | Modify | Add to `modelFetchers` record |
| | `backend/src/routes/chat-models.ts` | Modify | Add case to `getProviderApiKey()` switch |
| **LLM Client** | `backend/src/services/llm-client.ts` | Modify | Add to `detectProviderFromModel()` pattern matching |
| | `backend/src/services/llm-client.ts` | Modify | Add case to `resolveProviderApiKey()` switch |
| | `backend/src/services/llm-client.ts` | Modify | Add case to `createLLMModel()` switch |
| **Error Handling** | `shared/chat-error.ts` | Modify | Add `{Provider}ErrorTypes` constants |
| | `backend/src/routes/chat/errors.ts` | Modify | Add `parse{Provider}Error()` function |
| | `backend/src/routes/chat/errors.ts` | Modify | Add `map{Provider}ErrorToCode()` function |
| | `backend/src/routes/chat/errors.ts` | Modify | Add to `providerParsers` and `providerMappers` registries |
| **Types** | `backend/src/types/chat-api-key.ts` | Modify | Add to `SupportedChatProviderSchema` |


### Chat-Only Leaks (6 files)

| Module | Issue | Why It Exists |
|--------|-------|---------------|
| `chat-models.ts` | Individual `fetch{Provider}Models()` functions | Each provider has different model listing APIs |
| `llm-client.ts` | `detectProviderFromModel()` hardcoded patterns | Model naming conventions differ (e.g., `gpt-*`, `claude-*`, `gemini-*`) |
| `llm-client.ts` | `createLLMModel()` switch | AI SDK requires provider-specific model creation |
| `shared/chat-error.ts` | Provider-specific error constants | Error codes and structures differ across providers |
| `chat/errors.ts` | Individual `parse{Provider}Error()` functions | SDK error wrapping structures differ |
| `chat-api-key.ts` | `SupportedChatProviderSchema` | Chat supports subset of LLM Proxy providers |


## Reference Implementations

Existing provider implementations for reference:
- OpenAI: `backend/src/routes/proxy/openai.ts`, `backend/src/routes/proxy/adapterV2/openai.ts`
- Anthropic: `backend/src/routes/proxy/anthropic.ts`, `backend/src/routes/proxy/adapterV2/anthropic.ts`
- Gemini: `backend/src/routes/proxy/gemini.ts`, `backend/src/routes/proxy/adapterV2/gemini.ts`
