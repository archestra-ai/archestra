---
description: Implementation plan for adding Groq as a new LLM provider (Issue #1856)
---

# Groq Provider Implementation Plan

## Overview

This plan outlines the steps to add Groq as a new LLM provider to the Archestra Platform. Groq is OpenAI-compatible at `https://api.groq.com/openai/v1` and has Vercel AI SDK support via `@ai-sdk/groq`.

## Prerequisites

- Groq API Key (obtain from https://console.groq.com/keys)
- Familiarity with existing provider implementations (OpenAI, Anthropic, Gemini)

---

## Phase 1: Core Type Definitions

### 1.1 Update SupportedProviders Schema
**File:** `platform/shared/model-constants.ts`

Add `"groq"` to:
- `SupportedProvidersSchema` enum
- `SupportedProvidersDiscriminatorSchema` (as `"groq:chatCompletions"`)
- `providerDisplayNames` record

### 1.2 Create Groq Types for Backend
**Directory:** `platform/backend/src/types/llm-providers/groq/`

Create the following files following the OpenAI pattern (since Groq is OpenAI-compatible):
- `index.ts` - Namespace exports
- `api.ts` - Request/response schemas (reuse OpenAI schemas as Groq uses OpenAI format)
- `messages.ts` - Message type definitions (reuse OpenAI)
- `tools.ts` - Tool definitions (reuse OpenAI)

### 1.3 Update Provider Index
**File:** `platform/backend/src/types/llm-providers/index.ts`

Export the new Groq provider namespace.

---

## Phase 2: Configuration

### 2.1 Add Environment Variables
**File:** `platform/backend/src/config.ts`

Add Groq configuration:
```typescript
// In llm section
groq: {
  baseUrl: process.env.ARCHESTRA_GROQ_BASE_URL || "https://api.groq.com/openai/v1",
},

// In chat section
groq: {
  apiKey: process.env.ARCHESTRA_CHAT_GROQ_API_KEY || "",
  baseUrl: process.env.ARCHESTRA_CHAT_GROQ_BASE_URL || "https://api.groq.com/openai/v1",
},
```

### 2.2 Update Environment Example
**File:** `platform/.env.example`

Add:
```
ARCHESTRA_GROQ_BASE_URL=https://api.groq.com/openai/v1
ARCHESTRA_CHAT_GROQ_API_KEY=
ARCHESTRA_CHAT_GROQ_BASE_URL=https://api.groq.com/openai/v1
```

---

## Phase 3: LLM Proxy Implementation

### 3.1 Create Proxy Routes
**File:** `platform/backend/src/routes/proxy/groq.ts`

Create the Groq proxy route handler following the OpenAI pattern since Groq uses OpenAI-compatible API:
- Register routes for `/v1/groq/:agentId/chat/completions`
- Handle both streaming and non-streaming responses
- Implement tool invocation policy enforcement
- Implement trusted data policy evaluation
- Add token/cost limits handling
- Add model optimization support
- Implement tool results compression
- Support dual LLM verification
- Add metrics and observability

### 3.2 Create Mock Client for Testing
**File:** `platform/backend/src/routes/proxy/mock-groq-client.ts`

Create mock client for testing (similar to `mock-openai-client.ts`).

### 3.3 Register Routes
**File:** `platform/backend/src/routes/index.ts` (or wherever routes are registered)

Register the Groq proxy routes.

---

## Phase 4: Chat Module Integration

### 4.1 Update Chat Models Fetcher
**File:** `platform/backend/src/routes/chat-models.ts`

Add `fetchGroqModels()` function:
```typescript
async function fetchGroqModels(apiKey: string): Promise<ModelInfo[]> {
  const baseUrl = config.chat.groq.baseUrl;
  const url = `${baseUrl}/models`;
  
  // Groq uses OpenAI-compatible API for listing models
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  
  // ... similar to OpenAI implementation
}
```

Update `modelFetchers` record to include Groq.
Update `getProviderApiKey()` switch statement.

### 4.2 Update LLM Client Service
**File:** `platform/backend/src/services/llm-client.ts`

1. Add `@ai-sdk/groq` import (install package first)
2. Update `detectProviderFromModel()`:
   ```typescript
   if (lowerModel.includes("llama") || lowerModel.includes("mixtral") || lowerModel.includes("groq")) {
     return "groq";
   }
   ```
3. Update `resolveProviderApiKey()` to handle Groq
4. Update `createLLMModel()` to create Groq client:
   ```typescript
   if (provider === "groq") {
     const client = createGroq({
       apiKey,
       baseURL: `http://localhost:${config.api.port}/v1/groq/${agentId}`,
       headers,
     });
     return client(modelName);
   }
   ```

### 4.3 Update Chat Routes
**File:** `platform/backend/src/routes/chat/routes.ts`

Update `getSmartDefaultModel()` to include Groq:
```typescript
case "groq":
  return "llama-3.3-70b-versatile"; // Popular Groq model
```

### 4.4 Update Chat Error Mapping
**File:** `platform/backend/src/routes/chat/errors.ts`

Add error mapping for Groq-specific error codes.

---

## Phase 5: Frontend Integration

### 5.1 Create Groq Interaction Utility
**File:** `platform/frontend/src/lib/llmProviders/groq.ts`

Create `GroqChatCompletionInteraction` class following the OpenAI pattern (since the response format is compatible).

### 5.2 Update Provider Display Components
**Files:**
- `platform/frontend/src/components/chat/model-selector.tsx` - Add Groq logo mapping
- `platform/frontend/src/components/proxy-connection-instructions.tsx` - Add Groq connection instructions
- `platform/frontend/src/app/cost/optimization-rules/_parts/rule.tsx` - Add Groq to provider dictionary

### 5.3 Update Interaction Utils
**File:** `platform/frontend/src/lib/interaction.utils.ts`

Add case for Groq provider in interaction parsing.

---

## Phase 6: E2E Tests

### 6.1 Add Groq Configuration to Test Config
**File:** `platform/e2e-tests/tests/api/llm-proxy/tool-invocation.spec.ts`

Add `groqConfig` following the existing pattern:
```typescript
const groqConfig: ToolInvocationTestConfig = {
  providerName: "Groq",
  endpoint: (agentId) => `/v1/groq/${agentId}/chat/completions`,
  headers: (wiremockStub) => ({
    Authorization: `Bearer ${wiremockStub}`,
    "Content-Type": "application/json",
  }),
  buildRequest: (content, tools) => ({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content }],
    tools: tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
  }),
  // ... assertion methods (same as OpenAI since format is compatible)
};
```

Add Groq to `testConfigs` array.

### 6.2 Create WireMock Stubs
**Directory:** `platform/e2e-tests/wiremock/mappings/`

Add Groq-specific WireMock stubs for testing.

### 6.3 Add Additional E2E Tests
- Model optimization tests
- Token/cost limits tests  
- Tool persistence tests
- Tool result compression tests

---

## Phase 7: Documentation

### 7.1 Update Supported Providers Doc
**File:** `docs/pages/platform-supported-llm-providers.md`

Add Groq section:
```markdown
## Groq

### Supported Groq APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported

### Groq Connection Details

- **Base URL**: `http://localhost:9000/v1/groq/{agent-id}`
- **Authentication**: Pass your Groq API key in the `Authorization` header as `Bearer <your-api-key>`

### Important Notes

- **OpenAI Compatible**: Groq uses an OpenAI-compatible API format.
- **Streaming**: Groq supports streaming responses.
- **Models**: Popular models include llama-3.3-70b-versatile, mixtral-8x7b-32768.
```

---

## Phase 8: Package Dependencies

### 8.1 Install Vercel AI SDK Groq Package
```bash
cd platform/backend
pnpm add @ai-sdk/groq
```

---

## Phase 9: Unit Tests

### 9.1 Create Proxy Unit Tests
**File:** `platform/backend/src/routes/proxy/groq.test.ts`

Test:
- Request validation
- Streaming responses
- Non-streaming responses
- Tool invocation policy enforcement
- Trusted data evaluation
- Error handling

---

## Implementation Order

1. **Phase 8** - Install `@ai-sdk/groq` package
2. **Phase 1** - Core type definitions
3. **Phase 2** - Configuration
4. **Phase 3** - LLM Proxy implementation
5. **Phase 4** - Chat module integration
6. **Phase 5** - Frontend integration
7. **Phase 9** - Unit tests
8. **Phase 6** - E2E tests
9. **Phase 7** - Documentation

---

## Files to Create

| File | Description |
|------|-------------|
| `platform/backend/src/types/llm-providers/groq/index.ts` | Namespace exports |
| `platform/backend/src/types/llm-providers/groq/api.ts` | API schemas |
| `platform/backend/src/types/llm-providers/groq/messages.ts` | Message schemas |
| `platform/backend/src/types/llm-providers/groq/tools.ts` | Tool schemas |
| `platform/backend/src/routes/proxy/groq.ts` | Proxy routes |
| `platform/backend/src/routes/proxy/groq.test.ts` | Unit tests |
| `platform/backend/src/routes/proxy/mock-groq-client.ts` | Mock client |
| `platform/frontend/src/lib/llmProviders/groq.ts` | Frontend interaction utils |

---

## Files to Modify

| File | Changes |
|------|---------|
| `platform/shared/model-constants.ts` | Add "groq" to supported providers |
| `platform/backend/src/types/llm-providers/index.ts` | Export Groq namespace |
| `platform/backend/src/config.ts` | Add Groq config |
| `platform/backend/src/routes/chat-models.ts` | Add Groq model fetcher |
| `platform/backend/src/services/llm-client.ts` | Add Groq support |
| `platform/backend/src/routes/chat/routes.ts` | Add Groq default model |
| `platform/backend/src/routes/chat/errors.ts` | Add Groq error mapping |
| `platform/frontend/src/lib/llmProviders/common.ts` | Export Groq (if needed) |
| `platform/frontend/src/components/chat/model-selector.tsx` | Add Groq logo |
| `platform/frontend/src/components/proxy-connection-instructions.tsx` | Add Groq instructions |
| `platform/e2e-tests/tests/api/llm-proxy/tool-invocation.spec.ts` | Add Groq test config |
| `docs/pages/platform-supported-llm-providers.md` | Add Groq documentation |

---

## Acceptance Criteria Checklist

- [x] API Key Instructions documented
- [ ] Non-streaming responses work correctly (needs testing)
- [ ] Streaming responses work correctly (needs testing)
- [ ] Tool invocation and persistence work (needs testing)
- [ ] Token/cost limits functional (needs testing)
- [ ] Model optimization works (needs testing)
- [ ] Tool results compression works (needs testing)
- [ ] Dual LLM verification works (needs testing)
- [ ] Metrics and observability in place (needs testing)
- [ ] Chat conversations work (needs testing)
- [ ] Model listing and selection work (needs testing)
- [ ] Streaming responses in Chat UI work (needs testing)
- [ ] Error handling works (needs testing)
- [ ] E2E tests pass (not created yet)
- [x] Documentation updated
- [ ] Demo video created (manual step)

---

## Implementation Progress (as of 2026-02-02)

### Completed:
- ✅ Phase 1: Core type definitions (model-constants.ts, llm-providers/groq/index.ts)
- ✅ Phase 2: Configuration (config.ts, .env.example)
- ✅ Phase 3: LLM Proxy implementation (routes/proxy/groq.ts, routes/index.ts, shared/routes.ts)
- ✅ Phase 4: Chat module integration (llm-client.ts, chat-models.ts, chat/routes.ts, cost-optimization.ts)
- ✅ Phase 7: Documentation (docs/pages/platform-supported-llm-providers.md)

### Pending:
- ⏳ Phase 8: Install `@ai-sdk/groq` package (blocked by network issues)
- ⏳ Phase 5: Frontend integration
- ⏳ Phase 6: E2E tests
- ⏳ Phase 9: Unit tests


---

## Notes

1. **Groq is OpenAI-compatible** - Most code can reuse OpenAI patterns
2. **Vercel AI SDK support** - `@ai-sdk/groq` is available
3. **Popular Groq models**: 
   - `llama-3.3-70b-versatile`
   - `llama-3.1-70b-versatile`
   - `llama-3.1-8b-instant`
   - `mixtral-8x7b-32768`
   - `gemma2-9b-it`
