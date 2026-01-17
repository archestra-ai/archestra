# MiniMax Provider Implementation Checklist

This document verifies that all requirements for adding MiniMax provider support have been addressed.

**Status:** ✅ Core Implementation Complete | ⚠️ Documentation & Testing Pending

---

## Quick Status Summary

| Requirement | Status | Notes |
|------------|--------|-------|
| 1. API Key Instructions | ⚠️ Pending | Need to add to PR description |
| 2. Streaming Support | ✅ Complete | Both non-streaming and streaming implemented |
| 3. Feature Completeness | ✅ Complete | All LLM Proxy and Chat features implemented |
| 4. Demo Video | ⚠️ Pending | Must be created before PR approval |
| 5. Documentation | ⚠️ Pending | Need to update Supported LLM Providers page |
| 6. Testing | ⚠️ Pending | E2E tests need to be added |

---

## ✅ 1. API Key Instructions

**Status: NEEDS DOCUMENTATION**

### How to Obtain MiniMax API Key

1. Visit [MiniMax Platform](https://platform.minimax.io/)
2. Sign up or log in to your account
3. Navigate to API Keys section in your account settings
4. Create a new API key
5. Copy the API key (format: typically starts with a specific prefix)

**For Testing:**
- Set `ARCHESTRA_MINIMAX_BASE_URL` environment variable (defaults to `https://api.minimax.io/v1` if not set)
- Set `ARCHESTRA_CHAT_MINIMAX_API_KEY` for Chat functionality
- Pass API key in `Authorization: Bearer <your-api-key>` header for LLM Proxy requests

**Note:** Add this information to the PR description or create a separate API_KEY_INSTRUCTIONS.md file.

---

## ✅ 2. Streaming Support

**Status: IMPLEMENTED**

### Non-streaming Responses
- ✅ Implemented in `execute()` method (lines 1156-1165 in `adapterV2/minimax.ts`)
- ✅ Sets `stream: false` in request
- ✅ Returns complete response

### Streaming Responses  
- ✅ Implemented in `executeStream()` method (lines 1167-1186 in `adapterV2/minimax.ts`)
- ✅ Sets `stream: true` with `stream_options: { include_usage: true }`
- ✅ Returns AsyncIterable of chunks
- ✅ Stream adapter processes chunks correctly (lines 748-968)

**Verification:**
- MiniMax API documentation confirms streaming support: https://platform.minimax.io/docs/api-reference/text-openai-api
- Implementation follows OpenAI-compatible streaming pattern (same as vLLM/Ollama)

---

## ✅ 3. Feature Completeness

### LLM Proxy Features

#### ✅ Tool Invocation and Persistence
- ✅ Tool definitions extracted in `getTools()` method (lines 145-159)
- ✅ Tool calls parsed in `getToolCalls()` method (lines 672-705)
- ✅ Tool results handled in `getToolResults()` method (lines 112-143)
- ✅ Tool result updates supported via `updateToolResult()` and `applyToolResultUpdates()` (lines 181-187)

#### ✅ Token/Cost Limits
- ✅ Token usage extracted via `getUsage()` method (lines 712-717)
- ✅ Usage tracking in stream adapter (lines 785-790)
- ✅ Cost calculation supported through existing TokenPriceModel integration

#### ✅ Model Optimization
- ✅ Added to `ProviderMessages` type in `cost-optimization.ts` (line 18)
- ✅ `getOptimizedModel()` function supports MiniMax provider
- ✅ Tokenizer integration for token counting

#### ✅ Tool Results Compression
- ✅ `convertToolResultsToToon()` function implemented (lines 974-1088)
- ✅ TOON compression statistics tracked
- ✅ Cost savings calculated

#### ✅ Dual LLM Verification
- ✅ `MiniMaxDualLlmClient` class implemented (lines 650-710 in `dual-llm-client.ts`)
- ✅ Added to `createDualLlmClient()` factory (lines 698-702)
- ✅ Supports both `chat()` and `chatWithSchema()` methods

#### ✅ Metrics and Observability
- ✅ Uses `getObservableFetch()` for request duration metrics (line 1144 in adapter)
- ✅ Token usage reported via existing metrics infrastructure
- ✅ Span name: "minimax.chat.completions" (line 1131)

### Chat Features

#### ✅ Chat Conversations
- ✅ Provider added to `SupportedChatProviderSchema` (line 18 in `chat-api-key.ts`)
- ✅ LLM client creation in `createLLMModel()` (lines 247-255 in `llm-client.ts`)
- ✅ Provider detection in `detectProviderFromModel()` (lines 47-50)
- ✅ API key resolution in `resolveProviderApiKey()` (lines 123-126)

#### ✅ Model Listing and Selection
- ✅ `fetchMiniMaxModels()` function implemented (lines 320-370 in `routes.models.ts`)
- ✅ Added to `modelFetchers` registry (line 506)
- ✅ Added to `fetchModelsForProvider()` switch (lines 575-579)
- ✅ Added to `getProviderApiKey()` switch (lines 490-492)
- ✅ Frontend model selector updated (line 50 in `model-selector.tsx`)

#### ✅ Streaming Responses
- ✅ Chat uses Vercel AI SDK which supports OpenAI-compatible providers
- ✅ Streaming handled via OpenAI SDK wrapper (same pattern as vLLM/Ollama)
- ✅ **Note:** MiniMax is OpenAI-compatible, so Vercel AI SDK support is available through OpenAI provider with custom baseURL

#### ✅ Error Handling
- ✅ Error parser: Uses `parseOpenAIError` (OpenAI-compatible) (line 828 in `errors.ts`)
- ✅ Error mapper: Uses `mapOpenAIErrorWrapper` (line 842)
- ✅ Error types: Reuses OpenAI error structure

---

## ⚠️ 4. Demo Video

**Status: REQUIRED BUT NOT PROVIDED**

**Action Required:**
- Create a demo video showing:
  - LLM Proxy non-streaming requests
  - LLM Proxy streaming requests
  - Tool invocation and persistence
  - Model optimization
  - Tool result compression
  - Chat conversations (non-streaming and streaming)
  - Model selection
  - Error handling

**Note:** This must be provided before PR approval.

---

## ⚠️ 5. Documentation

**Status: NEEDS UPDATE**

### Required Updates:

1. **Supported LLM Providers Page** (`docs/pages/platform-supported-llm-providers.md`)
   - Add MiniMax section with:
     - Supported APIs
     - Connection details
     - Environment variables
     - Important notes

2. **API Key Instructions**
   - Add to PR description or create separate documentation

**Action Required:** Update documentation before PR submission.

---

## ⚠️ 6. Testing

**Status: NOT YET IMPLEMENTED**

### Required E2E Tests:

1. **WireMock Stub Mappings**
   - Create `helm/e2e-tests/mappings/minimax-*.json` files
   - Mock models list endpoint
   - Mock chat completions (non-streaming and streaming)
   - Mock tool calls

2. **CI Configuration**
   - Add `ARCHESTRA_MINIMAX_BASE_URL` to `.github/values-ci.yaml` (line 17)
   - Add `ARCHESTRA_CHAT_MINIMAX_API_KEY` to `.github/values-ci.yaml` (line 24)

3. **Test Configs**
   - Add `minimaxConfig` to `tool-invocation.spec.ts`
   - Add `minimaxConfig` to `tool-persistence.spec.ts`
   - Add `minimaxConfig` to `tool-result-compression.spec.ts`
   - Add `minimaxConfig` to `model-optimization.spec.ts`
   - Add `minimaxConfig` to `token-cost-limits.spec.ts`

**Action Required:** Implement all e2e tests before PR submission.

---

## Summary

### ✅ Completed
- Core implementation (types, adapters, routes, configuration)
- Streaming support (both non-streaming and streaming)
- All LLM Proxy features
- All Chat features
- Frontend UI components
- Error handling
- Dual LLM support
- Metrics integration

### ⚠️ Pending
- API Key instructions documentation
- Supported LLM Providers page update
- E2E tests implementation
- Demo video creation
- MiniMax icon file (`frontend/public/icons/minimax.png`)

### 📝 Notes
- MiniMax is OpenAI-compatible, so Vercel AI SDK support is available through OpenAI provider with custom baseURL
- Implementation follows vLLM/Ollama pattern (OpenAI-compatible providers)
- All code follows existing patterns and conventions

---

## Next Steps

1. Create API key instructions document
2. Update `docs/pages/platform-supported-llm-providers.md`
3. Add MiniMax icon file (`frontend/public/icons/minimax.png` - 64x64px PNG)
4. Implement e2e tests (WireMock mappings + test configs)
5. Create demo video
6. Final verification and PR submission
