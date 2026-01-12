---
title: Adding LLM Providers
category: Development
order: 2
description: Developer guide for implementing new LLM provider support in Archestra Platform
lastUpdated: 2026-01-12
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
| `backend/src/types/interaction.ts`                       | Add provider schemas to `InteractionRequestSchema`, `InteractionResponseSchema`, and `SelectInteractionSchema` discriminated union |

### Adapter Implementation

The adapter pattern provides a **provider-agnostic API** for business logic. LLMProxy operates entirely through adapters, never touching provider-specific types directly.

| File                                               | Description                                    |
| -------------------------------------------------- | ---------------------------------------------- |
| `backend/src/routes/proxy/adapterV2/{provider}.ts` | Implement all adapter classes                  |
| `backend/src/routes/proxy/adapterV2/index.ts`      | Export the `{provider}AdapterFactory` function |

**Adapters to Implement:**

- **RequestAdapter**: Provides Read/write access for the request data (model, messages, tools);
- **ResponseAdapter**: Provides Read/write access to thee response data (id, model, text, tool calls, usage);
- **StreamAdapter**: Process streaming chunks incrementally, accumulatin data required fro the LLMProxy logic;
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

| File                              | Description                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `backend/src/tokenizers/base.ts`  | Add provider message type to `ProviderMessage` union                                                    |
| `backend/src/tokenizers/base.ts`  | Update `BaseTokenizer.getMessageText()` if provider has a different message format                      |
| `backend/src/tokenizers/index.ts` | Add case to `getTokenizer()` switch - return appropriate tokenizer (or fallback to `TiktokenTokenizer`) |

### Model Optimization

> **Note:** This is a known abstraction leak that we're planning to address in future versions. Thanks for bearing with us!

Model optimization evaluates token counts to switch to cheaper models when possible.

| File                                                  | Description                                                                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `backend/src/routes/proxy/utils/cost-optimization.ts` | Add provider to `ProviderMessages` type mapping (e.g., `gemini: Gemini.Types.GenerateContentRequest["contents"]`) |

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

| File                                                | Description                                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/routes/proxy/utils/dual-llm-client.ts` | Create `{Provider}DualLlmClient` class implementing `DualLlmClient` interface with `chat()` and `chatWithSchema()` methods |
| `backend/src/routes/proxy/utils/dual-llm-client.ts` | Add case to `createDualLlmClient()` factory switch                                                                         |

### Metrics

> **Note:** This is a known abstraction leak that we're planning to address in future versions. Thanks for bearing with us!

Prometheus metrics for request duration, token usage, and costs. Requires instrumenting provider SDK clients.

For example: OpenAI and Anthropic SDKs accept a custom `fetch` function, so we inject an instrumented fetch via `getObservableFetch()`. Gemini SDK doesn't expose fetch, so we wrap the SDK instance directly via `getObservableGenAI()`.

| File                         | Description                                  |
| ---------------------------- | -------------------------------------------- |
| `backend/src/llm-metrics.ts` | Implement instrumented API calls for the SDK |

### Frontend: Logs UI

Interaction handlers parse stored request/response data for display in the LLM Proxy Logs UI (`/logs/llm-proxy`).

| File                                          | Description                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `frontend/src/lib/llmProviders/{provider}.ts` | Implement `InteractionUtils` interface for parsing provider-specific request/response JSON |
| `frontend/src/lib/interaction.utils.ts`       | Add case to `getInteractionClass()` switch to route discriminator to handler               |

### E2E Tests

Each provider must be added to the LLM Proxy e2e tests to ensure all features work correctly.

| File                                                            | Description                                                                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `helm/e2e-tests/mappings/{provider}-*.json`                     | WireMock stub mappings for mocking provider API responses (models list, chat completions, tool calls, etc.)             |
| `.github/values-ci.yaml`                                        | Add provider base URL pointing to WireMock (e.g., `ARCHESTRA_{PROVIDER}_BASE_URL: "http://e2e-tests-wiremock:8080/v1"`) |
| `e2e-tests/tests/api/llm-proxy/tool-invocation.spec.ts`         | Tool invocation policy tests - add `{provider}Config` to `testConfigs` array                                            |
| `e2e-tests/tests/api/llm-proxy/tool-persistence.spec.ts`        | Tool call persistence tests - add `{provider}Config` to `testConfigs` array                                             |
| `e2e-tests/tests/api/llm-proxy/tool-result-compression.spec.ts` | TOON compression tests - add `{provider}Config` to `testConfigs` array                                                  |
| `e2e-tests/tests/api/llm-proxy/model-optimization.spec.ts`      | Model optimization tests - add `{provider}Config` to `testConfigs` array                                                |
| `e2e-tests/tests/api/llm-proxy/token-cost-limits.spec.ts`       | Token cost limits tests - add `{provider}Config` to `testConfigs` array                                                 |

## Chat Support

Below is the list of modification requrest to support new Provider in the built-in Archestra Chat.

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

| File                                | Description                                                            |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `backend/src/routes/chat-models.ts` | Add `fetch{Provider}Models()` function and register in `modelFetchers` |
| `backend/src/routes/chat-models.ts` | Add case to `getProviderApiKey()` switch                               |

### LLM Client

Chat uses Vercel AI SDK which requires provider-specific model creation.

| File                                 | Description                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `backend/src/services/llm-client.ts` | Add to `detectProviderFromModel()` - model naming conventions differ (e.g., `gpt-*`, `claude-*`) |
| `backend/src/services/llm-client.ts` | Add case to `resolveProviderApiKey()` switch                                                     |
| `backend/src/services/llm-client.ts` | Add case to `createLLMModel()` - AI SDK requires provider-specific initialization                |

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
- Gemini: `backend/src/routes/proxy/routesv2/gemini.ts`, `backend/src/routes/proxy/adapterV2/gemini.ts`

**OpenAI-compatible implementations** (reuse OpenAI types/adapters with minor modifications):

- vLLM: `backend/src/routes/proxy/routesv2/vllm.ts`, `backend/src/routes/proxy/adapterV2/vllm.ts`
- Ollama: `backend/src/routes/proxy/routesv2/ollama.ts`, `backend/src/routes/proxy/adapterV2/ollama.ts`

> **Tip:** If adding support for an OpenAI-compatible provider (e.g., Azure OpenAI, Together AI, Groq), use the vLLM/Ollama implementations as starting points - they reuse OpenAI's type definitions and adapters.

## Smoke Testing

Use [PROVIDER_SMOKE_TEST.md](https://github.com/archestra-ai/archestra/blob/main/platform/PROVIDER_SMOKE_TEST.md) during development to verify basic functionality. This is a quick, non-exhaustive list.

Note, that Archestra Chat uses streaming for all LLM interactions. To test non-streaming responses, use an external client like n8n Chat node.

## Model Capabilities

Archestra automatically detects and displays model capabilities in the UI using **real data from the OpenRouter API** combined with intelligent fallback patterns. This provides accurate capability information without manual configuration.

### How Capabilities Work

The system uses a multi-layered detection approach:

1. **OpenRouter API Integration** - Fetches real model data from `https://openrouter.ai/api/v1/models`
2. **Architecture Parsing** - Extracts capabilities from OpenRouter's `architecture` field (modality, input/output modalities)
3. **Description Analysis** - Uses NLP-style pattern matching on model descriptions
4. **Provider-Specific Fallbacks** - Regex patterns for each provider when OpenRouter data is unavailable
5. **Caching** - 30-minute cache with stale-while-revalidate pattern for performance

### Capability Detection Flow

```
getModelCapabilities(modelId, provider)
    │
    ├─► fetchModelCapabilitiesFromOpenRouter(modelId)
    │       │
    │       └─► getOpenRouterModelById(modelId)
    │               │
    │               └─► [Cache Hit?] → Return cached model
    │                       │
    │                       └─► [Cache Miss] → fetchAllOpenRouterModels()
    │                                                       │
    │                                                       └─► OpenRouter API (with retry/backoff)
    │
    ├─► [OpenRouter Data Available?] → resolveCapabilitiesFromModel(model)
    │       │
    │       ├─► parseCapabilitiesFromArchitecture(...)
    │       ├─► parseCapabilitiesFromDescription(...)
    │       └─► applyFallbackPatterns(modelId, "default", ...)
    │
    └─► [No OpenRouter Data] → resolveFallbackCapabilities(modelId, provider)
            │
            └─► applyFallbackPatterns(modelId, provider, ...)

```

### Available Capabilities

The platform supports 15 capability categories:

| Capability | Icon | Description |
|------------|------|-------------|
| `reasoning` | 🧠 | Extended chain-of-thought reasoning |
| `vision` | 👁️ | Can analyze and understand images |
| `multimodal` | 🔮 | Supports mixed inputs (text, images, audio) |
| `audio` | 🎤 | Can process audio input/output |
| `code` | 💻 | Optimized for code tasks |
| `chat` | 💬 | General conversation |
| `function-calling` | 🛠️ | Function/tool calling support |
| `json-mode` | 📋 | Guaranteed JSON output |
| `streaming` | ⚡ | Streaming responses |
| `parallel-tools` | 🔀 | Parallel tool execution |
| `system-prompt` | ⚙️ | System prompts supported |
| `context-window` | 📚 | Extended context window (100K+ tokens) |
| `image-gen` | 🎨 | Image generation |
| `embedding` | 📊 | Text embeddings |
| `fine-tuned` | ✨ | Custom fine-tuned model |

### Architecture Detection

OpenRouter provides detailed architecture information for each model:

```typescript
interface OpenRouterModelArchitecture {
  modality: string;          // e.g., "text+image->text"
  input_modalities: string[]; // ["text", "image", "video"]
  output_modalities: string[];// ["text"]
  tokenizer: string;
  instruct_type: string | null;
}
```

The system parses this to detect:
- **Vision**: `input_modalities` includes "image" or "video"
- **Audio**: `input_modalities` includes "audio"
- **Multimodal**: Multiple input modalities
- **Image Gen**: `modality` contains "->image"
- **Chat**: Text input + text output

### Description Pattern Matching

The system analyzes model descriptions for capability keywords:

| Pattern | Capability | Metadata |
|---------|------------|----------|
| `vision`, `image`, `visual` | `vision` | `supportsImages: true` |
| `audio`, `sound`, `speech` | `audio` | `supportsAudio: true` |
| `video` | `multimodal` | `supportsVideo: true` |
| `multimodal` | `multimodal` | - |
| `reasoning`, `think` | `reasoning` | `hasReasoning: true` |
| `code`, `programming` | `code` | - |
| `json`, `structured output` | `json-mode` | `supportsJsonMode: true` |
| `function call`, `tool use` | `function-calling` | `supportsFunctionCalling: true` |

### Provider-Specific Fallback Patterns

When OpenRouter data is unavailable, the system uses provider-specific regex patterns:

| Provider | Pattern Example | Capability |
|----------|-----------------|------------|
| **openai** | `gpt-4o`, `vision` | `vision` |
| openai | `o1`, `gpt-4o-reason` | `reasoning` |
| openai | `-128k`, `-256k`, `-1m` | `context-window` |
| anthropic | `claude-3.5`, `claude-opus` | `vision` |
| anthropic | `opus`, `sonnet-4` | `reasoning` |
| anthropic | `-200k` | `context-window` |
| gemini | `1.5`, `2.0` | `vision`, `multimodal` |
| gemini | `-pro`, `-ultra` | `reasoning` |
| gemini | `-1m`, `-2m` | `context-window` |
| vllm | `-vision` | `vision` |
| vllm | `-code` | `code` |
| ollama | `llava`, `vision` | `vision` |
| ollama | `codellama` | `code` |

### Configuration

The capability detection system uses these constants:

| Constant | Value | Description |
|----------|-------|-------------|
| `CACHE_DURATION` | 30 * 60 * 1000 | 30 minutes cache TTL |
| `MAX_CACHE_SIZE` | 2000 | Max models in cache |
| `FETCH_TIMEOUT_MS` | 10000 | 10 second API timeout |
| `MAX_RETRIES` | 2 | Number of retry attempts |

### Adding Fallback Patterns for New Providers

To add a new provider to the fallback system:

#### 1. Update `FALLBACK_PATTERNS` in `model-capabilities.ts`

```typescript
const FALLBACK_PATTERNS: Record<string, ProviderFallbackPatterns> = {
  // ... existing providers
  newprovider: {
    patterns: [
      {
        test: (id) => /\b(newprovider-.*-vision)\b/i.test(id),
        capabilities: ["vision"],
        metadata: { supportsImages: true },
      },
      {
        test: (id) => /\b(newprovider-.*-reason)\b/i.test(id),
        capabilities: ["reasoning"],
        metadata: { hasReasoning: true },
      },
      {
        test: (id) => /\b(newprovider-.*-(\d+)k)\b/i.test(id),
        capabilities: ["context-window"],
      },
    ],
  },
};
```

#### 2. Add Description Patterns (Optional)

For better detection when OpenRouter descriptions are available:

```typescript
const DESCRIPTION_PATTERNS: Array<{
  test: (desc: string) => boolean;
  capabilities: ModelCapability[];
  metadata?: Partial<CapabilityMetadata>;
}> = [
  // ... existing patterns
  {
    test: (desc) => /\b(your-custom-keyword)\b/i.test(desc),
    capabilities: ["custom-capability"],
    metadata: { customMetadata: true },
  },
];
```

### Frontend Integration

Capabilities are automatically displayed in the UI:

| Component | Description |
|-----------|-------------|
| `frontend/src/components/ai-elements/model-capability-badge.tsx` | Individual capability badges with icons, colors, and tooltips |
| `frontend/src/components/chat/model-selector.tsx` | Model selector with capability display |

**Badge Features:**
- Color-coded by capability category (reasoning=purple, vision=blue, etc.)
- Icons from Lucide React
- Tooltips with capability descriptions
- Responsive sizing (sm/md options)
- Dark mode support

**Display Rules:**
- Shows top 3 prioritized capabilities by default
- Shows "+N more" for additional capabilities
- Prioritization: reasoning > vision > multimodal > audio > functionCalling > etc.

### Testing Capability Detection

```bash
# Start development environment
tilt up

# Test capability detection via API
curl http://localhost:9000/api/chat/models

# Check model capabilities in response
# {
#   "id": "anthropic/claude-sonnet-4-20250514",
#   "capabilities": {
#     "capabilities": ["reasoning", "vision", "chat", "streaming"],
#     "metadata": {
#       "supportsImages": true,
#       "hasReasoning": true,
#       "supportsStreaming": true
#     }
#   }
# }
```

### Troubleshooting

If capabilities aren't detected correctly:

1. **Check OpenRouter availability**:
   ```bash
   curl https://openrouter.ai/api/v1/models | head -100
   ```

2. **Verify model ID format**:
   ```typescript
   // Test pattern matching
   const modelId = "anthropic/claude-sonnet-4-20250514";
   console.log(/\b(claude-3\.[57]|claude-opus)\b/i.test(modelId));
   ```

3. **Check cache state**:
   ```typescript
   // In model-capabilities.ts
   console.log({
     cacheSize: MODELS_CACHE.size,
     lastFetch: new Date(LAST_FETCH_TIME),
   });
   ```

4. **Force cache clear**:
   ```typescript
   import { clearCapabilitiesCache } from "./model-capabilities";
   clearCapabilitiesCache();
   ```

### Performance Considerations

- **Cache Hit**: < 1ms (in-memory Map lookup)
- **Cache Miss**: ~100-500ms (OpenRouter API call with retry)
- **Fallback Mode**: < 1ms (regex pattern matching only)

The system uses stale-while-revalidate pattern: if API fails, it returns stale cache data if available, ensuring zero downtime for capability detection.
