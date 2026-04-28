# Memory Source Contract (Rollout 1 Foundation)

## Canonical fields on `memory_item`

- `source_type` (`chat` | `manual` | `mcp_tool` | `api` | `import` | `system`)
- `source_id` (stable source identifier inside the channel)
- `source_metadata` (required object with blocks below)

## Required `source_metadata` blocks

- `origin`
- `ingestion`
- `actor`
- `quality`
- `safety`
- `future`

## Reserved future fields

`source_metadata.future` keeps forward-compatible identifiers without enabling project-memory logic yet:

- `projectId`
- `workspaceId`
- `sectionId`

## Channel examples

### `chat`

```json
{
  "sourceType": "chat",
  "sourceId": "conversation-uuid",
  "sourceMetadata": {
    "origin": { "channel": "chat", "conversationId": "conversation-uuid", "messageIds": ["msg-1", "msg-2"] },
    "ingestion": { "runId": "chat_extract:run-uuid", "idempotencyKey": "sha256", "dedupKey": "sha256" },
    "actor": { "kind": "agent", "agentId": "agent-uuid" },
    "quality": {
      "extractorVersion": "v1.2.0",
      "candidateProvenance": {
        "sourceRole": "mixed",
        "userConfirmed": true,
        "evidence": [{ "role": "user", "quote": "Yes, keep dark mode.", "messageId": "msg-1" }]
      }
    },
    "safety": { "policyFlags": [] },
    "future": { "projectId": null, "workspaceId": null, "sectionId": null }
  }
}
```

### `manual`

```json
{
  "sourceType": "manual",
  "sourceId": "manual:user-id:run-id",
  "sourceMetadata": {
    "origin": { "channel": "manual", "scopeType": "user", "scopeId": "user-id" },
    "ingestion": { "runId": "manual:run-id" },
    "actor": { "kind": "user", "userId": "user-id" },
    "quality": {},
    "safety": { "policyFlags": [] },
    "future": { "projectId": null, "workspaceId": null, "sectionId": null }
  }
}
```

### `mcp_tool`

```json
{
  "sourceType": "mcp_tool",
  "sourceId": "mcp:conversation-or-session-id",
  "sourceMetadata": {
    "origin": { "channel": "mcp_tool", "conversationId": "conversation-uuid", "toolName": "archestra__propose_memory_candidate" },
    "ingestion": { "runId": "mcp:run-id", "idempotencyKey": "sha256", "dedupKey": "sha256" },
    "actor": { "kind": "agent", "agentId": "agent-uuid", "userId": "user-id" },
    "quality": { "extractorVersion": "manual_mcp_propose" },
    "safety": { "policyFlags": [] },
    "future": { "projectId": null, "workspaceId": null, "sectionId": null }
  }
}
```

### `api`, `import`, `system`

Use the same block layout; channel-specific origin/actor details are optional, but `ingestion.runId` and `safety.policyFlags` are still required.
