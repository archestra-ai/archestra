# Per-Agent LLM Configuration - Implementation Plan

## Overview

This feature allows internal agents (`agentType='agent'`) to have their own LLM configuration (provider, model, and API key strategy), overriding the default dynamic resolution.

---

## Phase 1: Shared Constants

### 1.1 Update `shared/model-constants.ts`

Add two new exports after `providerDisplayNames`:

```typescript
/**
 * Default models for each provider when using dynamic resolution.
 * Used by both backend (getSmartDefaultModel) and frontend (agent dialog).
 */
export const providerDefaultModels: Partial<Record<SupportedProvider, string>> = {
  anthropic: "claude-opus-4-1-20250805",
  gemini: "gemini-2.5-pro",
  openai: "gpt-4o",
  cohere: "command-r-08-2024",
};

/**
 * Display names for common models. Used when model isn't in available list.
 */
export const modelDisplayNames: Record<string, string> = {
  // Anthropic
  "claude-opus-4-1-20250805": "Claude Opus 4.1",
  "claude-opus-4-0-20250514": "Claude Opus 4",
  "claude-sonnet-4-20250514": "Claude Sonnet 4",
  "claude-sonnet-4-0-20250514": "Claude Sonnet 4",
  "claude-3-7-sonnet-20250219": "Claude 3.7 Sonnet",
  "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
  "claude-3-5-haiku-20241022": "Claude 3.5 Haiku",
  // OpenAI
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o Mini",
  "gpt-4-turbo": "GPT-4 Turbo",
  "o1": "o1",
  "o1-mini": "o1 Mini",
  "o1-preview": "o1 Preview",
  "o3-mini": "o3 Mini",
  // Gemini
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.0-flash": "Gemini 2.0 Flash",
  "gemini-1.5-pro": "Gemini 1.5 Pro",
  "gemini-1.5-flash": "Gemini 1.5 Flash",
  // Cohere
  "command-r-08-2024": "Command R",
  "command-r-plus-08-2024": "Command R+",
};
```

---

## Phase 2: Database Schema

### 2.1 Update Agent Schema (`backend/src/database/schemas/agent.ts`)

**Add import:**
```typescript
import type { SupportedChatProvider } from "@/types/chat-api-key";
import chatApiKeysTable from "./chat-api-key";
```

**Add type export:**
```typescript
/**
 * LLM API key resolution strategy for internal agents.
 * - dynamic: Uses user-based priority chain (personal → team → org → env)
 * - static: Uses a specific chat API key configured on the agent
 */
export type LlmApiKeyStrategy = "dynamic" | "static";
```

**Add columns to `agentsTable`** (after `incomingEmailAllowedDomain`):
```typescript
// LLM Configuration (only used when agentType = 'agent')
/** LLM provider for this agent (anthropic, openai, gemini, etc.) */
llmProvider: text("llm_provider").$type<SupportedChatProvider>(),
/** Model name for this agent (e.g., claude-opus-4-1-20250805, gpt-4o) */
llmModel: text("llm_model"),
/** API key resolution strategy: 'dynamic' uses user-based priority chain, 'static' uses a specific key */
llmApiKeyStrategy: text("llm_api_key_strategy")
  .$type<"dynamic" | "static">()
  .notNull()
  .default("dynamic"),
/** Static API key ID to use when llmApiKeyStrategy is 'static' */
llmStaticApiKeyId: uuid("llm_static_api_key_id").references(
  () => chatApiKeysTable.id,
  { onDelete: "set null" },
),
```

**Add index** (in the table options array):
```typescript
index("agents_llm_static_api_key_id_idx").on(table.llmStaticApiKeyId),
```

### 2.2 Generate Migration

```bash
pnpm db:generate
drizzle-kit check
```

This will create a migration similar to:
```sql
ALTER TABLE "agents" ADD COLUMN "llm_provider" text;
ALTER TABLE "agents" ADD COLUMN "llm_model" text;
ALTER TABLE "agents" ADD COLUMN "llm_api_key_strategy" text DEFAULT 'dynamic' NOT NULL;
ALTER TABLE "agents" ADD COLUMN "llm_static_api_key_id" uuid;
ALTER TABLE "agents" ADD CONSTRAINT "agents_llm_static_api_key_id_chat_api_keys_id_fk"
  FOREIGN KEY ("llm_static_api_key_id") REFERENCES "public"."chat_api_keys"("id")
  ON DELETE set null ON UPDATE no action;
CREATE INDEX "agents_llm_static_api_key_id_idx" ON "agents" USING btree ("llm_static_api_key_id");
```

---

## Phase 3: Backend Types

### 3.1 Update Agent Types (`backend/src/types/agent.ts`)

**Add re-export:**
```typescript
export type { LlmApiKeyStrategy } from "@/database/schemas/agent";
```

**Add schema:**
```typescript
// LLM API key strategy schema
export const LlmApiKeyStrategySchema = z.enum(["dynamic", "static"]);
```

**Update extended field schemas:**
```typescript
// Extended field schemas for drizzle-zod
const selectExtendedFields = {
  incomingEmailSecurityMode: IncomingEmailSecurityModeSchema,
  llmProvider: SupportedChatProviderSchema.nullable(),
  llmApiKeyStrategy: LlmApiKeyStrategySchema,
};

const insertExtendedFields = {
  incomingEmailSecurityMode: IncomingEmailSecurityModeSchema.optional(),
  llmProvider: SupportedChatProviderSchema.optional(),
  llmApiKeyStrategy: LlmApiKeyStrategySchema.optional(),
};
```

**Add validation function:**
```typescript
/**
 * Validates LLM configuration settings.
 * When llmApiKeyStrategy is "static", llmStaticApiKeyId must be provided.
 */
function validateLlmConfig(
  data: {
    llmApiKeyStrategy?: string | null;
    llmStaticApiKeyId?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  if (data.llmApiKeyStrategy === "static" && !data.llmStaticApiKeyId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "API key is required when using static API key strategy",
      path: ["llmStaticApiKeyId"],
    });
  }
}
```

**Update `validateAgentFields`** to include LLM validation:
```typescript
function validateAgentFields(data: { ... }, ctx: z.RefinementCtx) {
  validateIncomingEmailDomain(data, ctx);
  validateLlmConfig(data, ctx);
}
```

---

## Phase 4: Backend Services

### 4.1 Update Secrets Manager (`backend/src/secrets-manager/index.ts`)

**Add helper function** at the bottom:
```typescript
/**
 * Extract API key value from a secret, supporting all provider-specific field names.
 * This is the single source of truth for extracting API keys from secrets.
 */
export function extractApiKeyFromSecret(
  secret: { secret?: Record<string, unknown> } | null,
): string | undefined {
  const value =
    secret?.secret?.apiKey ??
    secret?.secret?.anthropicApiKey ??
    secret?.secret?.geminiApiKey ??
    secret?.secret?.openaiApiKey ??
    secret?.secret?.zhipuaiApiKey ??
    secret?.secret?.cohereApiKey;
  return value ? (value as string) : undefined;
}
```

### 4.2 Update LLM Client (`backend/src/clients/llm-client.ts`)

**Modify `resolveProviderApiKey`** - add `agentStaticApiKeyId` parameter:
```typescript
export async function resolveProviderApiKey(params: {
  organizationId: string;
  userId: string;
  provider: SupportedChatProvider;
  conversationId?: string | null;
  /** If set, use this specific API key directly (agent static API key) */
  agentStaticApiKeyId?: string | null;
}): Promise<{ apiKey: string | undefined; source: string }> {
  const { organizationId, userId, provider, conversationId, agentStaticApiKeyId } = params;

  // If agent has a static API key configured, use it directly
  if (agentStaticApiKeyId) {
    const staticKey = await ChatApiKeyModel.findById(agentStaticApiKeyId);
    if (staticKey?.secretId && staticKey.provider === provider) {
      const secret = await secretManager().getSecret(staticKey.secretId);
      const secretValue = extractApiKeyFromSecret(secret);
      if (secretValue) {
        return { apiKey: secretValue, source: "agent_static" };
      }
    }
    // If static key is invalid or doesn't match provider, fall through to normal resolution
    logger.warn(
      { agentStaticApiKeyId, provider },
      "Agent static API key not found or provider mismatch, falling back to normal resolution",
    );
  }

  // ... rest of existing resolution logic
}
```

**Update import:**
```typescript
import { extractApiKeyFromSecret, secretManager } from "@/secrets-manager";
```

**Modify `createLLMModelForAgent`** - add `agentStaticApiKeyId` parameter:
```typescript
export async function createLLMModelForAgent(params: {
  // ... existing params
  /** Agent's static API key ID (when llmApiKeyStrategy is "static") */
  agentStaticApiKeyId?: string | null;
}): Promise<{ model: LLMModel; provider: SupportedChatProvider; apiKeySource: string }> {
  const { ..., agentStaticApiKeyId } = params;

  const { apiKey, source } = await resolveProviderApiKey({
    organizationId,
    userId,
    provider,
    conversationId,
    agentStaticApiKeyId,  // Pass through
  });
  // ... rest unchanged
}
```

### 4.3 Update Chat Routes (`backend/src/routes/chat/routes.chat.ts`)

**Add new exported function** after `getSmartDefaultModel`:
```typescript
/**
 * Resolve model and provider with optional agent-specific configuration.
 * Priority:
 * 1. Agent explicit config (if agent.llmProvider and agent.llmModel are set)
 * 2. Smart defaults based on available API keys (personal > team > org > env)
 *
 * Used for conversation creation (with agent) and A2A execution.
 */
export async function resolveModelAndProvider(params: {
  userId: string;
  organizationId: string;
  agent?: Pick<Agent, "llmProvider" | "llmModel"> | null;
}): Promise<{
  model: string;
  provider: SupportedChatProvider;
  source: "agent" | "personal_key" | "team_key" | "org_key" | "env" | "vertex_ai" | "config";
}> {
  const { userId, organizationId, agent } = params;

  // 1. Check if agent has explicit LLM config
  if (agent?.llmProvider && agent?.llmModel) {
    logger.info(
      { provider: agent.llmProvider, model: agent.llmModel },
      "Using agent's explicit LLM configuration",
    );
    return {
      model: agent.llmModel,
      provider: agent.llmProvider,
      source: "agent",
    };
  }

  // 2. Fall back to smart defaults
  const smartDefault = await getSmartDefaultModel(userId, organizationId);

  // Determine source (simplified logic)
  let source: "personal_key" | "team_key" | "org_key" | "env" | "vertex_ai" | "config" = "config";

  if (smartDefault.provider === "gemini" && isVertexAiEnabled() && !config.chat.gemini.apiKey) {
    source = "vertex_ai";
  } else if (
    (smartDefault.provider === "anthropic" && config.chat.anthropic.apiKey) ||
    (smartDefault.provider === "openai" && config.chat.openai.apiKey) ||
    (smartDefault.provider === "gemini" && config.chat.gemini.apiKey) ||
    (smartDefault.provider === "cohere" && config.chat.cohere?.apiKey)
  ) {
    source = "env";
  }

  return { model: smartDefault.model, provider: smartDefault.provider, source };
}
```

**Add import:**
```typescript
import { providerDefaultModels } from "@shared";
```

**Modify `POST /api/chat/conversations`** handler:
```typescript
// In the handler, after validating chatApiKeyId:

// Determine model and provider to use
let modelToUse = selectedModel;
let providerToUse = selectedProvider;

if (!selectedModel) {
  // No model specified - check agent config first, then use smart defaults
  const resolved = await resolveModelAndProvider({
    userId: user.id,
    organizationId,
    agent: agent.agentType === "agent" ? agent : null, // Only use agent config for internal agents
  });
  modelToUse = resolved.model;
  providerToUse = resolved.provider;
} else if (!selectedProvider) {
  // Model specified but no provider - detect provider from model name
  providerToUse = detectProviderFromModel(selectedModel);
}

logger.info({
  agentId,
  organizationId,
  selectedModel,
  selectedProvider,
  modelToUse,
  providerToUse,
  chatApiKeyId,
  wasSmartDefault: !selectedModel,
}, "Creating conversation with model");

// Create conversation with resolved values
return reply.send(
  await ConversationModel.create({
    userId: user.id,
    organizationId,
    agentId,
    title,
    selectedModel: modelToUse,
    selectedProvider: providerToUse,
    chatApiKeyId,
  }),
);
```

### 4.4 Update A2A Executor (`backend/src/agents/a2a-executor.ts`)

**Add import:**
```typescript
import { resolveModelAndProvider } from "@/routes/chat/routes.chat";
```

**Modify `executeA2AMessage`:**
```typescript
// Replace the existing model/provider detection with:
const {
  model: selectedModel,
  provider,
  source: modelSource,
} = await resolveModelAndProvider({
  userId,
  organizationId,
  agent,
});

logger.info({
  agentId: agent.id,
  selectedModel,
  provider,
  modelSource,
  hasAgentLlmConfig: !!agent.llmProvider && !!agent.llmModel,
  llmApiKeyStrategy: agent.llmApiKeyStrategy,
}, "A2A resolved model and provider");

// When calling createLLMModelForAgent, add agentStaticApiKeyId:
const { model } = await createLLMModelForAgent({
  organizationId,
  userId,
  agentId: agent.id,
  model: selectedModel,
  provider,
  sessionId,
  externalAgentId: delegationChain,
  agentStaticApiKeyId:
    agent.llmApiKeyStrategy === "static" ? agent.llmStaticApiKeyId : null,
});
```

### 4.5 Update Policy Config Subagent (`backend/src/agents/subagents/policy-config-subagent.ts`)

**Update `VIRTUAL_AGENT` constant** to include new fields:
```typescript
private static readonly VIRTUAL_AGENT: Agent = {
  // ... existing fields
  llmProvider: null,
  llmModel: null,
  llmApiKeyStrategy: "dynamic",
  llmStaticApiKeyId: null,
  // ... rest unchanged
};
```

---

## Phase 5: Frontend Changes

### 5.1 Update Chat API Key Selector (`frontend/src/components/chat/chat-api-key-selector.tsx`)

**Add prop:**
```typescript
interface ChatApiKeySelectorProps {
  // ... existing props
  /** Callback to change the model when selecting a key from a different provider */
  onModelChange?: (model: string) => void;
}
```

**Modify hook call** - fetch ALL keys (not filtered by provider):
```typescript
// Fetch ALL API keys (not filtered by provider) so user can switch providers
const { data: availableKeys = [], isLoading: isLoadingKeys } =
  useAvailableChatApiKeys();  // Remove the currentProvider filter
```

**Update `applyKeyChange`:**
```typescript
const applyKeyChange = (keyId: string) => {
  // Find the selected key to get its provider
  const selectedKey = availableKeys.find((k) => k.id === keyId);

  // If key is from a different provider, switch to that provider's default model
  if (selectedKey && selectedKey.provider !== currentProvider && onModelChange) {
    const defaultModel = providerDefaultModels[selectedKey.provider as keyof typeof providerDefaultModels];
    if (defaultModel) {
      onModelChange(defaultModel);
    }
  }

  // ... rest of existing logic
};
```

**Add import:**
```typescript
import { providerDefaultModels } from "@shared";
```

### 5.2 Update Prompt Input (`frontend/src/app/chat/prompt-input.tsx`)

**Pass `onModelChange` to `ChatApiKeySelector`:**
```typescript
<ChatApiKeySelector
  // ... existing props
  onModelChange={onModelChange}  // Add this line
/>
```

### 5.3 Update Agent Dialog (`frontend/src/components/agent-dialog.tsx`)

**Add imports:**
```typescript
import {
  providerDefaultModels,
  providerDisplayNames,
  SupportedProviders,
} from "@shared";
import { useModelsByProviderQuery } from "@/lib/chat-models.query";
import {
  type SupportedChatProvider,
  useAvailableChatApiKeys,
} from "@/lib/chat-settings.query";
```

**Add state variables** (inside the component):
```typescript
// LLM Configuration state (internal agents only)
const [llmProvider, setLlmProvider] = useState<SupportedChatProvider | "">("");
const [llmModel, setLlmModel] = useState("");
const [llmApiKeyStrategy, setLlmApiKeyStrategy] = useState<"dynamic" | "static">("dynamic");
const [llmStaticApiKeyId, setLlmStaticApiKeyId] = useState<string | null>(null);

// Fetch models and API keys for LLM configuration
const { modelsByProvider, isLoading: isLoadingModels } = useModelsByProviderQuery();
const { data: availableApiKeys = [] } = useAvailableChatApiKeys(llmProvider || undefined);
```

**Update `useEffect` for form reset:**
```typescript
// In the if (agentData) block, add:
setLlmProvider(agentData.llmProvider || "");
setLlmModel(agentData.llmModel || "");
setLlmApiKeyStrategy(agentData.llmApiKeyStrategy || "dynamic");
setLlmStaticApiKeyId(agentData.llmStaticApiKeyId || null);

// In the else block (create mode), add:
setLlmProvider("");
setLlmModel("");
setLlmApiKeyStrategy("dynamic");
setLlmStaticApiKeyId(null);
```

**Update `handleSave`:**
```typescript
// Build LLM config for internal agents
const llmConfig = isInternalAgent
  ? {
      llmProvider: llmProvider || undefined,
      llmModel: llmModel || undefined,
      llmApiKeyStrategy,
      llmStaticApiKeyId:
        llmApiKeyStrategy === "static" ? llmStaticApiKeyId || undefined : undefined,
    }
  : {};

// Include in mutation calls:
await updateAgent.mutateAsync({
  id: agent.id,
  data: {
    // ... existing fields
    ...llmConfig,
  },
});
```

**Add JSX for LLM Configuration section** (after Email Invocation section, inside `isInternalAgent` check):
```tsx
{/* LLM Configuration (Agent only) */}
{isInternalAgent && (
  <div className="space-y-2">
    <Label>LLM Configuration</Label>
    <div className="border rounded-lg bg-muted/30 p-4 space-y-4">
      {/* Provider Selection */}
      <div className="space-y-2">
        <Label htmlFor="llm-provider" className="text-sm">Provider</Label>
        <Select
          value={llmProvider || "__dynamic__"}
          onValueChange={(value) => {
            const newProvider = value === "__dynamic__" ? "" : value;
            setLlmProvider(newProvider as SupportedChatProvider | "");
            setLlmModel(providerDefaultModels[newProvider as keyof typeof providerDefaultModels] || "");
            setLlmStaticApiKeyId(null);
            setLlmApiKeyStrategy("dynamic");
          }}
        >
          <SelectTrigger id="llm-provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__dynamic__">Dynamic (first available)</SelectItem>
            <div className="h-px bg-border my-1" />
            {SupportedProviders.map((provider) => (
              <SelectItem key={provider} value={provider}>
                {providerDisplayNames[provider]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!llmProvider && (
          <p className="text-xs text-muted-foreground">
            Resolves from: user's key → team key → org key → ARCHESTRA_CHAT_&lt;PROVIDER&gt;_API_KEY.
          </p>
        )}
      </div>

      {/* Model - only shown when provider is selected */}
      {llmProvider && (
        <div className="space-y-2">
          <Label htmlFor="llm-model" className="text-sm">Model</Label>
          <Select value={llmModel} onValueChange={setLlmModel} disabled={isLoadingModels}>
            <SelectTrigger id="llm-model">
              <SelectValue placeholder="Select model" />
            </SelectTrigger>
            <SelectContent>
              {(modelsByProvider[llmProvider as keyof typeof modelsByProvider] || []).map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* API Key Selection - not shown for Gemini when Vertex AI is enabled */}
      {llmProvider && !(llmProvider === "gemini" && features?.geminiVertexAiEnabled) && (
        <div className="space-y-2">
          <Label htmlFor="llm-api-key" className="text-sm">API Key</Label>
          <Select
            value={llmApiKeyStrategy === "static" && llmStaticApiKeyId ? llmStaticApiKeyId : "__dynamic__"}
            onValueChange={(value) => {
              if (value === "__dynamic__") {
                setLlmApiKeyStrategy("dynamic");
                setLlmStaticApiKeyId(null);
              } else {
                setLlmApiKeyStrategy("static");
                setLlmStaticApiKeyId(value);
              }
            }}
          >
            <SelectTrigger id="llm-api-key">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__dynamic__">Dynamic (first available)</SelectItem>
              {availableApiKeys.length > 0 && (
                <>
                  <div className="h-px bg-border my-1" />
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Static</div>
                  {availableApiKeys.map((key) => (
                    <SelectItem key={key.id} value={key.id}>
                      <div className="flex items-center gap-2">
                        <span>{key.name}</span>
                        <span className="text-xs text-muted-foreground">({key.scope})</span>
                      </div>
                    </SelectItem>
                  ))}
                </>
              )}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {llmApiKeyStrategy === "dynamic"
              ? `Resolves from: user's key → team key → org key → ARCHESTRA_CHAT_${llmProvider.toUpperCase()}_API_KEY.`
              : "Uses a specific API key for this agent."}
          </p>
        </div>
      )}

      {/* Vertex AI info for Gemini */}
      {llmProvider === "gemini" && features?.geminiVertexAiEnabled && (
        <p className="text-xs text-muted-foreground">
          Uses Vertex AI with service account authentication.
        </p>
      )}
    </div>
  </div>
)}
```

**Update `useCallback` dependencies** for `handleSave`:
```typescript
], [
  // ... existing deps
  llmProvider,
  llmModel,
  llmApiKeyStrategy,
  llmStaticApiKeyId,
]);
```

### 5.4 Update Chat Page (`frontend/src/app/chat/page.tsx`)

**Modify the model initialization `useEffect`:**
```typescript
// Initialize model: agent's config > localStorage > first available
useEffect(() => {
  if (!initialModel) {
    const allModels = Object.values(modelsByProvider).flat();
    if (allModels.length === 0) return;

    // First priority: use agent's configured model
    if (initialAgentId) {
      const agent = internalAgents.find((a) => a.id === initialAgentId);
      if (agent?.llmModel && allModels.some((m) => m.id === agent.llmModel)) {
        setInitialModel(agent.llmModel);
        return;
      }
    }

    // Second priority: restore from localStorage
    const savedModelId = localStorage.getItem("selected-chat-model");
    if (savedModelId && allModels.some((m) => m.id === savedModelId)) {
      setInitialModel(savedModelId);
      return;
    }

    // Fall back to first available model
    // ... existing fallback logic
  }
}, [modelsByProvider, initialModel, initialAgentId, internalAgents]);
```

**Modify `handleInitialAgentChange`:**
```typescript
const handleInitialAgentChange = useCallback((agentId: string) => {
  setInitialAgentId(agentId);
  localStorage.setItem("selected-chat-agent", agentId);

  // Use agent's configured model if available
  const agent = internalAgents.find((a) => a.id === agentId);
  if (agent?.llmModel) {
    setInitialModel(agent.llmModel);
  }
}, [internalAgents]);
```

---

## Phase 6: Regenerate API Client

```bash
pnpm codegen:api-client
```

This updates `shared/hey-api/clients/api/types.gen.ts` with the new fields.

---

## Phase 7: Testing

### Unit Tests
- Test `validateLlmConfig` validation function
- Test `resolveModelAndProvider` with various agent configs
- Test `resolveProviderApiKey` with `agentStaticApiKeyId`

### Integration Tests
- Create agent with LLM config via API
- Update agent LLM config via API
- Verify conversation creation uses agent's LLM config
- Verify A2A execution uses agent's LLM config

### E2E Tests
- Create internal agent with specific LLM config
- Verify model auto-selection when changing agent
- Verify API key selector behavior with cross-provider selection

---

## Phase 8: Run Checks

```bash
pnpm lint
pnpm type-check
pnpm test
pnpm db:generate  # Should show no new migrations
drizzle-kit check
```

---

## File Change Summary

| File | Action |
|------|--------|
| `shared/model-constants.ts` | Add `providerDefaultModels` and `modelDisplayNames` |
| `backend/src/database/schemas/agent.ts` | Add 4 columns + type + FK + index |
| `backend/src/types/agent.ts` | Add schema, validation, re-export |
| `backend/src/secrets-manager/index.ts` | Add `extractApiKeyFromSecret` helper |
| `backend/src/clients/llm-client.ts` | Add `agentStaticApiKeyId` param |
| `backend/src/routes/chat/routes.chat.ts` | Add `resolveModelAndProvider`, update create endpoint |
| `backend/src/agents/a2a-executor.ts` | Use `resolveModelAndProvider`, pass static key |
| `backend/src/agents/subagents/policy-config-subagent.ts` | Update `VIRTUAL_AGENT` |
| `frontend/src/components/agent-dialog.tsx` | Add LLM config UI section |
| `frontend/src/components/chat/chat-api-key-selector.tsx` | Add `onModelChange`, fetch all keys |
| `frontend/src/app/chat/prompt-input.tsx` | Pass `onModelChange` prop |
| `frontend/src/app/chat/page.tsx` | Use agent's model on selection |
| New migration | `ALTER TABLE agents ADD COLUMN ...` |

---

## Rollback Plan

If needed, the feature can be rolled back by:
1. Creating a migration to drop the 4 new columns
2. Reverting the code changes
3. The default `llmApiKeyStrategy: "dynamic"` ensures existing behavior is maintained

---

## Key Design Decisions

1. **Backward Compatible**: Default strategy is "dynamic" which maintains existing behavior
2. **Agent-Specific Override**: Internal agents can opt into specific LLM config
3. **Cascading Resolution**: Agent config → user key → team key → org key → env var
4. **Static Key Support**: Allows pinning an agent to a specific API key (useful for cost tracking, dedicated resources)
5. **Provider Change Auto-Model**: When provider changes, model automatically updates to provider's default
6. **Vertex AI Support**: Gemini with Vertex AI doesn't show API key selector (uses ADC)
