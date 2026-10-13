---
title: Adding LLM Providers
description: Add a model provider to the LLM Proxy, the Model Router, and the built-in Chat.
order: 2
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

A provider touches two parts of Archestra. The [LLM Proxy](/docs/llm-proxy) route receives a client's request, applies Archestra's policies, and forwards it to the provider. [Chat](/docs/chat) support lists the provider's models and calls them from the built-in chat.

Most providers serve an OpenAI-compatible API. They reuse OpenAI's schemas and adapter and add little code of their own. A provider with its own API format also needs its own schemas, adapters, and a translator for the Model Router. Paths on this page are relative to `platform/`.

The Moonshot (Kimi) provider is the reference for an OpenAI-compatible provider. [Pull request #6778](https://github.com/archestra-ai/archestra/pull/6778) added it and shows every file the change touches.

## Files TypeScript Finds

TypeScript lists most of the files you need to change:

1. In `shared/model-constants.ts`, add the provider ID to `SupportedProvidersSchema`. Add its `provider:endpoint` value, for example `kimi:chatCompletions`, to `SupportedProvidersDiscriminatorSchema`.
2. Run `pnpm type-check` from `platform/`.
3. Each error is a `Record<SupportedProvider, …>` or an exhaustive switch that needs an entry for the new provider. Fix them all, using the sections below for what each entry needs.

Update the lists in [Files TypeScript Misses](#files-typescript-misses) by hand.

## OpenAI-Compatible Providers

### Types

Create `backend/src/types/llm-providers/<provider>/` with `api.ts`, `messages.ts`, `tools.ts`, and `index.ts`. Re-export OpenAI's schemas. Use `.passthrough()` on the request and response schemas to keep provider-specific fields through validation. Copy `backend/src/types/llm-providers/kimi/`.

Export the namespace from `backend/src/types/llm-providers/index.ts`. In `backend/src/types/interaction.ts`, add the request and response schemas to `InteractionRequestSchema` and `InteractionResponseSchema`. Then add an entry for the discriminator value.

### Adapter

The adapter gives the proxy a provider-agnostic view of requests, responses, and stream chunks. An OpenAI-compatible provider builds one from `createOpenAiCompatibleAdapterFactory` in `backend/src/routes/proxy/adapters/<provider>.ts`:

```typescript
export const kimiAdapterFactory = createOpenAiCompatibleAdapterFactory({
  provider: "kimi",
  interactionType: "kimi:chatCompletions",
  getBaseUrl: () => config.llm.kimi.baseUrl,
  createClient(apiKey, options) {
    const customFetch = options.agent
      ? metrics.llm.getObservableFetch("kimi", options.agent, options.source)
      : undefined;
    return new OpenAIProvider({
      maxRetries: PROXY_SDK_MAX_RETRIES,
      apiKey,
      baseURL: options.baseUrl ?? config.llm.kimi.baseUrl,
      fetch: customFetch,
      defaultHeaders: options.defaultHeaders,
    });
  },
});
```

Export the factory from `backend/src/routes/proxy/adapters/index.ts`.

### Proxy Route

Copy `backend/src/routes/proxy/routes/kimi.ts` to `backend/src/routes/proxy/routes/<provider>.ts`. Rename the Kimi identifiers. The file registers the chat completion routes, with and without an `/:agentId` segment, and forwards every other path to the provider unchanged.

Add the two route IDs to `RouteId` in `shared/routes.ts`. Export the route plugin from `backend/src/routes/index.ts`. Register it in `backend/src/server.ts`.

### Configuration

In `backend/src/config.ts`, add:

- `llm.<provider>.baseUrl`, read from `ARCHESTRA_<PROVIDER>_BASE_URL`, with the provider's public API as the default.
- `chat.<provider>.apiKey`, read from `ARCHESTRA_CHAT_<PROVIDER>_API_KEY`.

Add both variables to `platform/.env.example` and to the [Configuration](/docs/reference/configuration) reference.

### Chat

- `backend/src/routes/chat/model-fetchers/index.ts`: add a model fetcher. `makeBearerFetcher` covers any provider that lists models at `GET /models` with a bearer token.
- `backend/src/clients/llm-client.ts`: add an entry to `providerModelConfigs`. It sets how to create the AI SDK model, the default base URL, and whether an API key is required.
- `backend/src/routes/chat/errors.ts`: add an entry to `providerErrorHandlers`. OpenAI-compatible providers use `openAiCompatibleErrorHandler`.

### Frontend

- `frontend/public/icons/<provider>.png`: add the provider logo.
- `frontend/src/components/llm-provider-api-key-form.tsx`: add an entry to `PROVIDER_CONFIG` with the display name, icon, key placeholder, and the link to the provider's key console.
- `shared/interactions/llmProviders/<provider>.ts`: a class that parses stored requests and responses for the LLM Proxy logs. An OpenAI-compatible provider extends `OpenAiChatCompletionInteraction`. Register it in `shared/interactions/interaction.utils.ts`.

### Remaining Type Errors

The rest of the type errors need a one-line entry each. For an OpenAI-compatible provider, copy Kimi's entry:

- `backend/src/tokenizers/index.ts`: the tokenizer that estimates token counts for cost limits.
- `backend/src/observability/metrics/llm.ts`: the function that reads token usage from a response.
- `shared/model-constants.ts`: the display name, default base URL, default model, and model-name patterns.
- `backend/src/knowledge-base/embedding-clients/registry.ts`: `null` unless the provider serves embedding models.

## Native API Providers

A provider with its own API format needs more than the steps above. Start from the closest existing provider: `anthropic`, `gemini`, `cohere`, or `bedrock`.

- Schemas. Write Zod schemas for the provider's request, response, messages, and tools in `backend/src/types/llm-providers/<provider>/`.
- Adapters. Implement `LLMRequestAdapter`, `LLMResponseAdapter`, `LLMStreamAdapter`, and `LLMProvider` from `backend/src/types/llm-provider.ts`. The stream adapter accumulates chunks into the complete response.
- Model Router. The [Model Router](/docs/llm-proxy/providers) speaks the OpenAI Chat Completions and Responses APIs. Add `<provider>-openai.ts` and `<provider>-openai-translator.ts` to `backend/src/routes/proxy/adapters/` to translate between the two formats, as `gemini-openai.ts` does. Cover streaming and non-streaming requests.
- Tokenizer. If the message format differs from the ones in the `ProviderMessage` union in `backend/src/tokenizers/base.ts`, add it there.
- Metrics. If the provider SDK does not accept a custom `fetch`, wrap the SDK instance instead, as `getObservableGenAI` does for Gemini.
- Errors. Write a parser and an error-code mapper for the SDK's error shape in `backend/src/routes/chat/errors.ts`. Add the error types to `shared/chat-error.ts`.

## Files TypeScript Misses

These lists hold a subset of providers. A missing entry still compiles:

- `MODEL_ROUTER_SUPPORTED_PROVIDERS` in `shared/model-constants.ts`: add the provider to reach it through the Model Router. Also add its adapter factory to `openAiWireProviders` in `backend/src/routes/proxy/routes/model-router.ts`, or a translator for a native API.
- `frontend/src/app/connection/clients.ts`: add the provider to each client on the **Connect** page that can send requests to it.
- `shared/opencode-provider-routes.ts`: add the provider to route OpenCode's requests for it through Archestra.
- `docs/pages/llm-proxy/providers.md`: always add the provider's proxy URL, supported APIs, and models.

Run `pnpm codegen` after the route exists. It adds the new endpoints to `docs/openapi.json` and the generated API client. CI fails when `pnpm codegen` leaves changes behind.

## Testing

Add the provider to `backend/src/routes/proxy/routes/provider-matrix.rollback.test.ts`. The matrix runs the real route, handler, policies, and persistence against a fake SDK client. For an OpenAI-compatible provider, copy Kimi's entry. Do not add WireMock mappings for behavior the matrix already covers.

Before you open the pull request, run from `platform/`:

```bash
pnpm type-check
pnpm --filter @backend test -- provider-matrix
pnpm codegen && pnpm lint:fix
```

Then check the provider in the [development environment](/docs/contributing/developer-quickstart):

1. Go to **LLM → Model Providers**, click **Add API Key**, select the provider, and paste a key.
2. Open **Chat**, pick one of the provider's models, and send a message. The reply streams in, and the request appears in the LLM Proxy logs.
3. Chat always streams. To check a non-streaming response, call the proxy directly. The response is a single JSON chat completion.

```bash
curl http://localhost:9000/v1/<provider>/chat/completions \
  -H "Authorization: Bearer $PROVIDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "<model>", "messages": [{"role": "user", "content": "Hi"}], "stream": false}'
```
