# System API Keys for Keyless Providers

## Overview

Create system-level API keys for providers that don't require traditional API keys (Vertex AI, vLLM, Ollama, Bedrock). This ensures all models are consistently linked to API keys in the `api_key_models` table.

## Implementation Status

### 1. Database Migration ✅
- [x] Add `is_system` boolean column to `chat_api_keys` table (default: false)
- [x] Add unique constraint: one system key per provider
- Migration file: `0129_strange_vindicator.sql`

### 2. Model Layer (`ChatApiKeyModel`) ✅
- [x] Add `findSystemKey(provider)` method
- [x] Add `createSystemKey(provider, orgId)` method
- [x] Add `deleteSystemKey(provider)` method
- [x] Add `findAllSystemKeys()` method
- [x] Update `getVisibleKeys()` to include `isSystem` field

### 3. System Key Sync Service ✅
- [x] Create `SystemKeyManager` class in `backend/src/services/system-key-manager.ts`
- [x] Method: `syncSystemKeys(organizationId)` - called on startup and refresh
  - For each keyless provider:
    - If enabled + no system key → create + sync models
    - If enabled + has system key → sync models
    - If disabled + has system key → delete system key

### 4. Backend Startup Integration ✅
- [x] Call `systemKeyManager.syncSystemKeys()` on server startup (in `server.ts`)
- [x] Call it in "Refresh models" endpoint (`/api/chat/models/invalidate-cache`)

### 5. Cleanup Workaround ✅
- [x] Remove `additionalProviders` parameter from `getAllModelsWithApiKeys()`
- [x] Simplified to only show models with API key links (system keys now handle keyless providers)

### 6. Frontend Updates ✅
- [x] Display "System" badge with Server icon for system keys
- [x] Show "Auto-managed" in actions column for system keys (no edit/delete)
- [x] Tooltip explains system keys are auto-managed
- [x] Regenerated API client with `isSystem` field

## Files Changed

### Backend
- `backend/src/database/schemas/chat-api-key.ts` - Added `isSystem` column
- `backend/src/database/migrations/0129_strange_vindicator.sql` - Migration
- `backend/src/models/chat-api-key.ts` - Added system key methods
- `backend/src/models/api-key-model.ts` - Simplified getAllModelsWithApiKeys
- `backend/src/services/system-key-manager.ts` - New service
- `backend/src/services/model-sync.ts` - Added `hasFetcher()` method
- `backend/src/routes/chat/routes.models.ts` - Integrated system key sync
- `backend/src/server.ts` - Call system key sync on startup
- `backend/src/types/model.ts` - Added `isSystem` to LinkedApiKeySchema

### Frontend
- `frontend/src/app/settings/llm-api-keys/page.tsx` - UI for system keys

### Shared
- `shared/hey-api/clients/api/types.gen.ts` - Regenerated with `isSystem`

## Testing

To test:
1. Run migration: `pnpm db:migrate`
2. Start server: `tilt up`
3. Enable Vertex AI via environment: `ARCHESTRA_GEMINI_VERTEX_AI_ENABLED=true`
4. Check logs for "Starting system API keys sync"
5. Go to Settings > LLM & MCP Gateways
6. Verify "Vertex AI (System)" key appears with System badge
7. Click "Refresh models" - should sync system keys
8. Disable Vertex AI and restart - system key should be deleted
