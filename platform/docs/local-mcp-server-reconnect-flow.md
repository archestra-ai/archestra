# Local MCP Server Installation & Reconnect Flow

This document analyzes the complete flow for installing local MCP servers and what happens when a user edits a catalog item and is forced to "Reconnect".

## Known Issue: Tool Policies and Assignments Lost on Reconnect

When a user edits a catalog item and reconnects, **all customized tool invocation policies, trusted data policies, and profile-tool assignments are permanently lost**. This is a critical bug that needs to be addressed.

---

## Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         INITIAL INSTALLATION FLOW                                │
└─────────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐      ┌─────────────────────┐      ┌─────────────────────────────┐
│   User       │      │    Frontend         │      │         Backend             │
│   clicks     │─────>│  LocalInstallDialog │─────>│   POST /api/mcp_server      │
│   Install    │      │                     │      │                             │
└──────────────┘      └─────────────────────┘      └──────────────┬──────────────┘
                                                                   │
                        ┌──────────────────────────────────────────┘
                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │  1. Create mcp_servers record (status: "pending")         │
        │  2. Start K8s Deployment                                  │
        │  3. Return immediately with pending status                │
        └───────────────────────────────────────────────────────────┘
                        │
                        ▼ (Async background process)
        ┌───────────────────────────────────────────────────────────┐
        │  4. Wait for K8s pod ready (up to 2 minutes)              │
        │  5. Update status to "discovering-tools"                  │
        │  6. Fetch tools via MCP protocol                          │
        │  7. Create tools in database (bulkCreateToolsIfNotExists) │
        │  8. Create DEFAULT policies for each tool ◄──────────────┬┘
        │     - Tool invocation policy (block_when_context_untrusted)
        │     - Trusted data policy (mark_as_untrusted)             │
        │  9. Create agent-tool assignments IF agentIds provided    │
        │ 10. Update status to "success"                            │
        └───────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────────────────────────┐
│                         CATALOG EDIT FLOW                                        │
└─────────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐      ┌─────────────────────┐      ┌─────────────────────────────┐
│   Admin      │      │    Frontend         │      │         Backend             │
│   edits      │─────>│  EditCatalogDialog  │─────>│ PUT /api/internal_mcp_catalog/:id
│   catalog    │      │                     │      │                             │
└──────────────┘      └─────────────────────┘      └──────────────┬──────────────┘
                                                                   │
                        ┌──────────────────────────────────────────┘
                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │  1. Update catalog item configuration                     │
        │  2. Find all mcp_servers with this catalogId              │
        │  3. Mark each server: reinstallRequired = true            │
        │                                                           │
        │  ⚠️  4. DELETE ALL TOOLS for this catalogId  ⚠️           │
        │      └── ToolModel.deleteByCatalogId(id)                  │
        │                                                           │
        │      CASCADE DELETES (via onDelete: "cascade"):           │
        │      ├── tool_invocation_policy records  ❌ LOST!         │
        │      ├── trusted_data_policy records     ❌ LOST!         │
        │      └── agent_tools assignments         ❌ LOST!         │
        │                                                           │
        └───────────────────────────────────────────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │  Frontend detects reinstallRequired = true                │
        │  Shows "Reinstall Required" / "Reconnect Required" button │
        └───────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────────────────────────┐
│                         RECONNECT/REINSTALL FLOW                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐      ┌──────────────────────────┐
│   User       │      │  ReinstallConfirmation   │
│   clicks     │─────>│  Dialog                  │
│   Reconnect  │      │                          │
└──────────────┘      └───────────┬──────────────┘
                                  │
                                  ▼
        ┌───────────────────────────────────────────────────────────┐
        │  handleReinstallConfirm():                                │
        │                                                           │
        │  1. Find the installed server for this catalog            │
        │                                                           │
        │  ⚠️  2. DELETE the installed server  ⚠️                   │
        │      └── deleteMutation.mutateAsync({ id: server.id })    │
        │                                                           │
        │      (Note: Tools were already deleted when catalog       │
        │       was edited, this deletes the mcp_server record)     │
        │                                                           │
        │  3. Open install dialog (handleInstallLocalServer)        │
        │                                                           │
        └───────────────────────────────────────────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │  handleLocalServerInstallConfirm():                       │
        │                                                           │
        │  installMutation.mutateAsync({                            │
        │    name: catalogItem.name,                                │
        │    catalogId: catalogItem.id,                             │
        │    environmentValues: ...,                                │
        │    teamId: ...,                                           │
        │    serviceAccount: ...,                                   │
        │                                                           │
        │    ⚠️  agentIds: NOT PROVIDED!  ⚠️                        │
        │  })                                                       │
        │                                                           │
        └───────────────────────────────────────────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │  Backend: POST /api/mcp_server (same as initial install)  │
        │                                                           │
        │  1. Create new mcp_server record                          │
        │  2. Start K8s deployment                                  │
        │  3. Async: discover tools                                 │
        │  4. Create tools with NEW IDs                             │
        │  5. Create NEW DEFAULT policies                           │
        │     (user's customized policies are gone!)                │
        │                                                           │
        │  ⚠️  6. Skip agent-tool creation (no agentIds)  ⚠️        │
        │                                                           │
        └───────────────────────────────────────────────────────────┘
```

---

## Database Schema Relationships

```
┌─────────────────────┐
│   internal_mcp_     │
│   catalog           │
│   (catalogId)       │
└─────────┬───────────┘
          │ 1:N
          ▼
┌─────────────────────┐         ┌─────────────────────┐
│   mcp_servers       │◄────────│   tools             │
│   (id)              │  N:1    │   (id, catalogId)   │
└─────────────────────┘         └─────────┬───────────┘
                                          │
          ┌───────────────────────────────┼───────────────────────────────┐
          │                               │                               │
          ▼                               ▼                               ▼
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│  agent_tools        │     │  tool_invocation_   │     │  trusted_data_      │
│  (agentId, toolId)  │     │  policy             │     │  policy             │
│                     │     │  (toolId)           │     │  (toolId)           │
│  onDelete: cascade  │     │  onDelete: cascade  │     │  onDelete: cascade  │
└─────────────────────┘     └─────────────────────┘     └─────────────────────┘

When tools are deleted via ToolModel.deleteByCatalogId(catalogId):
  - All agent_tools records with those toolIds are CASCADE DELETED
  - All tool_invocation_policy records with those toolIds are CASCADE DELETED
  - All trusted_data_policy records with those toolIds are CASCADE DELETED
```

---

## The Problem in Detail

### 1. Catalog Edit Triggers Tool Deletion

**File:** `backend/src/routes/internal-mcp-catalog.ts` (lines 423-435)

```typescript
// Mark all installed servers for reinstall
const installedServers = await McpServerModel.findByCatalogId(id);
for (const server of installedServers) {
  await McpServerModel.update(server.id, {
    reinstallRequired: true,
  });
}

// Delete all tools associated with this catalog id
// Tools will be rediscovered with updated configuration during reinstall
await ToolModel.deleteByCatalogId(id);  // <-- THIS CAUSES CASCADE DELETES
```

### 2. Cascade Deletes Remove User Data

**Files:**
- `backend/src/database/schemas/tool-invocation-policy.ts` (line 25)
- `backend/src/database/schemas/trusted-data-policy.ts` (line 22)
- `backend/src/database/schemas/agent-tool.ts` (line 22)

All three tables have `onDelete: "cascade"` on the `toolId` foreign key.

### 3. Reinstall Creates New Default Policies

**File:** `backend/src/models/tool.ts` (lines 200-216)

```typescript
static async createDefaultPolicies(toolId: string): Promise<void> {
  // Creates GENERIC default policies, not user's customized ones
  await ToolInvocationPolicyModel.create({
    toolId,
    conditions: [],  // Empty = always applies
    action: "block_when_context_is_untrusted",
    reason: null,
  });

  await TrustedDataPolicyModel.create({
    toolId,
    conditions: [],
    action: "mark_as_untrusted",
    description: null,
  });
}
```

### 4. Agent-Tool Assignments Not Recreated

**File:** `frontend/src/app/mcp-catalog/_parts/InternalMCPCatalog.tsx` (lines 283-302)

```typescript
const handleLocalServerInstallConfirm = async (
  installResult: LocalServerInstallResult,
) => {
  // ...
  const result = await installMutation.mutateAsync({
    name: localServerCatalogItem.name,
    catalogId: localServerCatalogItem.id,
    environmentValues: installResult.environmentValues,
    // ... other params
    // ⚠️ NO agentIds PARAMETER!
  });
};
```

Without `agentIds`, the backend skips creating agent-tool assignments:

**File:** `backend/src/routes/mcp-server.ts` (lines 513-523)

```typescript
// If agentIds were provided, create agent-tool assignments
if (agentIds && agentIds.length > 0) {  // <-- Always false during reinstall!
  const toolIds = createdTools.map((t) => t.id);
  await AgentToolModel.bulkCreateForAgentsAndTools(agentIds, toolIds, {
    executionSourceMcpServerId: mcpServer.id,
  });
}
```

---

## Impact on Users

| Data Type | Initial Install | After Reconnect | Status |
|-----------|-----------------|-----------------|--------|
| Tools | Created | Recreated with new IDs | Works but IDs change |
| Tool Invocation Policies | Default created | Default created (custom lost) | **DATA LOSS** |
| Trusted Data Policies | Default created | Default created (custom lost) | **DATA LOSS** |
| Agent-Tool Assignments | Created if agentIds provided | NOT created | **DATA LOSS** |
| Response Modifier Templates | Created with assignment | NOT recreated | **DATA LOSS** |

---

## Suggested Fixes

### Option A: Preserve Policies by Tool Name (Recommended)

Instead of deleting tools and recreating them:

1. **When catalog is edited:**
   - Mark servers for reinstall (keep current behavior)
   - **Don't delete tools** - just mark them as "pending_rediscovery"

2. **When reconnect happens:**
   - Fetch new tool list from MCP server
   - **Match tools by name** (slugified name is deterministic: `{catalogName}___{toolName}`)
   - Update existing tool records with new metadata (description, parameters)
   - Preserve existing policies and assignments
   - Add new tools, mark removed tools as inactive

### Option B: Backup and Restore Policies

1. **Before deleting tools:**
   - Backup policies and assignments keyed by tool name

2. **After creating new tools:**
   - Restore policies by matching tool names
   - Restore assignments by matching tool names

### Option C: Store Policies at Catalog Level

Move policies to be associated with catalog + tool_name instead of tool_id, so they survive tool recreation.

---

## Code Locations

| Component | File Path | Lines |
|-----------|-----------|-------|
| Catalog Edit (tool deletion) | `backend/src/routes/internal-mcp-catalog.ts` | 423-435 |
| Tool Deletion Method | `backend/src/models/tool.ts` | 898-904 |
| Tool Cascade Delete (policy) | `backend/src/database/schemas/tool-invocation-policy.ts` | 25 |
| Tool Cascade Delete (trusted) | `backend/src/database/schemas/trusted-data-policy.ts` | 22 |
| Tool Cascade Delete (assignment) | `backend/src/database/schemas/agent-tool.ts` | 22 |
| Reinstall Handler (frontend) | `frontend/src/app/mcp-catalog/_parts/InternalMCPCatalog.tsx` | 474-515 |
| Install Confirm (no agentIds) | `frontend/src/app/mcp-catalog/_parts/InternalMCPCatalog.tsx` | 283-302 |
| Install Route (backend) | `backend/src/routes/mcp-server.ts` | 81-634 |
| Tool Discovery (async) | `backend/src/routes/mcp-server.ts` | 465-549 |
| Default Policy Creation | `backend/src/models/tool.ts` | 200-216 |

---

## Testing the Issue

1. Create a local MCP server catalog item
2. Install the server (tools are discovered)
3. Assign tools to a profile
4. Customize tool invocation policies (e.g., add conditions)
5. Customize trusted data policies
6. Edit the catalog item (change any configuration)
7. Observe:
   - All tools for that catalog are deleted
   - Reinstall Required button appears
8. Click Reconnect/Reinstall
9. Observe:
   - Tools are recreated with new IDs
   - Policies are reset to defaults
   - Profile-tool assignments are gone
