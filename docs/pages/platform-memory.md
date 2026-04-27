---
title: Memory
category: Agents
order: 3
description: Durable agent memory with review-first lifecycle, scoped ACL, sensitive-content screening, and optional prompt-time injection
lastUpdated: 2026-04-24
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

> [!NOTE]
> Preview feature (rollout 1). Automatic extraction and prompt-time injection are **disabled by default** and activate only for `user` scope when explicitly enabled via environment variables.

Archestra Memory is a durable, review-first store for long-lived context that agents can reuse across conversations. It is independent from chat history and from the knowledge base. Every automated pathway writes only `candidate` records; nothing becomes active memory without human approval.

![Memory settings page](/docs/automated_screenshots/platform-memory_settings-page.webp)

## Who this is for

- **Operators**: control rollout with feature flags, monitor security signals, and decide when prompt-time injection is safe.
- **Reviewers** (admins, team leads, memory reviewers): triage candidates, approve what is useful, reject what is not, and archive stale memories.
- **End users** (`user` scope): accumulate personal preferences that the agent can apply automatically once approved.

Day-to-day management happens at **Settings → Memory**.

## Scopes and conflict model

Memory items carry exactly one scope:

| Scope | Visibility | Auto-extraction (rollout 1) | Auto-injection (rollout 1) |
|---|---|---|---|
| `user` | Owning user only | Yes, when enabled | Yes, when enabled |
| `team` | Members of the team | No | No |
| `organization` | All members of the organization | No | No |

Scope isolation is enforced by ACL filtering **before** any ranking or retrieval. A user never reads, approves, or injects memory from a scope they do not belong to. Team- and organization-scope items are fully reviewable and manually manageable in rollout 1, just not auto-extracted or injected.

A new candidate that contradicts an existing approved record is handled through **append-only supersede**: the reviewer creates a new candidate referencing `supersedes_memory_id`. Approved memory is never edited in place.

## Memory lifecycle

```
candidate ──approve──▶ approved ──archive──▶ archived
    │                      │                    │
    ├──reject──▶ rejected  └──supersede──▶ candidate (new)
    │
    └──delete──▶ (tombstone, if high-risk)

quarantined ──(security review)──▶ candidate or rejected
```

States:

- `candidate` — waiting for human review. All automated paths (extractor, MCP `memory_propose`, manual create, supersede) write here.
- `quarantined` — created by the pre-write screen when content is instruction-like or scored as high injection-risk. Requires explicit security review before it can enter the normal review queue or be approved. Never injected into prompts.
- `approved` — active memory, eligible for injection when rules allow.
- `rejected` — reviewer declined; may emit a tombstone.
- `archived` — formerly approved, now set aside; can be restored.

Deletions may create a **tombstone** to prevent immediate recreation of the same content through automated paths.

## Review workflow

1. A candidate enters the queue via extraction, MCP propose, or manual creation.
2. Pre-write screening runs with deterministic scoring. Three outcomes are possible:
   - **Block**: secrets, high-risk PII, tombstone hits — not persisted.
   - **Quarantine**: high-confidence instruction-like content or high injection-risk score — persisted with `quarantined` status, not visible in the normal review queue, never injected.
   - **Allow**: item becomes a `candidate` and enters the review queue (may carry `instruction_like_medium` flag for reviewer visibility).
3. Reviewer opens the candidate at **Settings → Memory**, inspects content, scope, and policy flags, and chooses an action.
4. Approval with a high-risk policy flag or `quarantined` status is **blocked** by a review-path guard; the candidate remains reviewable but cannot become active memory through the normal approve path.
5. Rejection requires a reason drawn from the fixed taxonomy below.

### Rejection taxonomy

`inaccurate`, `sensitive`, `manipulative`, `wrong_scope`, `temporary`, `duplicate`, `vague`, `not_useful`, `conflicts_with_existing`, `policy_violation`.

## RBAC

Memory access is governed by the standard RBAC system (`resource:action`). Typical permissions:

| Action | Permission |
|---|---|
| List and read scoped memory | `memory:read` |
| Create a manual candidate | `memory:create` |
| Edit candidates, supersede approved memory, archive, restore | `memory:update` |
| Approve or reject candidates | `memory:approve` |
| Hard-delete | `memory:delete` |

Scope eligibility layers on top of RBAC. A user with `memory:approve` still cannot approve a memory whose scope they do not belong to. Team- and organization-scope review also depends on `memory:team-admin` and `memory:admin` where applicable. The Roles admin UI (**Settings → Roles**) exposes these permissions when the enterprise RBAC module is active; otherwise predefined roles apply.

See also: [Access Control](/docs/platform-access-control).

## Automatic prompt injection

When injection is enabled, approved `user`-scope memories are added to the chat prompt for the owning user. Injection is **skipped** when any of the following apply:

- `ARCHESTRA_MEMORY_INJECTION_ENABLED` is `false` (default).
- The agent is configured with untrusted-context posture.
- The active tool set exposes **external communication capability** (`external_tools_with_trusted_context` guard).
- The per-request token budget or top-K would be exceeded by a given item.

The external-tool guard is **metadata-first**: tool definitions with explicit capability metadata are authoritative. Tools without metadata fall back to a legacy name-based heuristic, and the fallback is logged so the inventory can be migrated toward explicit metadata.

Disabling injection at any level is instant and cheap: the retrieval path returns `null` immediately when the flag is off, so there is no hot-path cost when the feature is not in use.

## Extraction behavior

Async extraction runs after a conversation goes idle and is gated by `ARCHESTRA_MEMORY_EXTRACTION_ENABLED`. In rollout 1 the extractor:

- proposes only `user`-scope candidates;
- uses prompt version `v1.0.0`, frozen for the rollout;
- applies the same pre-write screen as manual create and MCP propose;
- respects `ARCHESTRA_MEMORY_MAX_CANDIDATES_PER_EXTRACTION` and `ARCHESTRA_MEMORY_MAX_CONTENT_LENGTH`.

Conversations are **skipped** when extraction is disabled, when the owning user is not in `user` scope eligibility, or when a recent extraction already covered the same conversation window.

## Deletion, archive, tombstones, `source_deleted`

- **Archive** is reversible: `approved → archived → approved`.
- **Delete** is permanent. For rejected or deleted items whose content is high-risk, a tombstone is emitted so the same content cannot be re-proposed automatically.
- Tombstones match candidates by deterministic content hash and a normalized fallback; matches increment `archestra_memory_tombstone_hit_total`.
- When the originating source of a memory (for example, a chat message) is deleted, the memory can be marked `source_deleted` for provenance and review hygiene, without automatically removing the memory itself.

## Telemetry

Memory emits a dedicated set of security counters. Full catalog, PromQL examples, and alert guidance are in the [Observability](/docs/platform-observability) documentation. Key counters:

- `archestra_memory_policy_blocked_total{reason}` — pre-write blocks.
- `archestra_memory_screen_decision_total{decision,reason}` — screening outcomes.
- `archestra_memory_injection_block_total{reason}` — prompt-time blocks.
- `archestra_memory_review_policy_block_total{reason}` — approve-path blocks for high-risk flagged or quarantined candidates.
- `archestra_memory_tombstone_hit_total{reason,match_type}` — replay suppression.
- `archestra_memory_mcp_propose_block_total{reason}` — MCP `memory_propose` tool-boundary blocks.
- `archestra_memory_candidate_scored_total{memory_type,scope_type,source_type,safety_score_bucket}` — scored candidates by type and safety band.
- `archestra_memory_quarantined_total{reason,scope_type}` — items placed into quarantine by the pre-write scorer.
- `archestra_memory_retrieved_total{memory_type,scope_type,safety_score_bucket}` — items retrieved for prompt injection.

A nonzero block rate is not automatically a fault in rollout 1; many blocks are expected evidence of enforcement.

## Out of scope (rollout 1)

- Semantic or vector retrieval for memory.
- Autonomous self-editing of approved memory.
- Team or organization **automatic** extraction and injection.
- Memory import/export.
- Project, workspace, or agent scopes.
- Auto-consolidation UI.
- Scheduled expiry for approved memory beyond the candidate TTL cleanup.

## Environment variables

Configured in the backend process (see [Deployment](/docs/platform-deployment)).

| Variable | Default | Purpose |
|---|---|---|
| `ARCHESTRA_MEMORY_EXTRACTION_ENABLED` | `false` | Enables async post-conversation extraction. |
| `ARCHESTRA_MEMORY_INJECTION_ENABLED` | `false` | Enables prompt-time injection of approved `user`-scope memory. |
| `ARCHESTRA_MEMORY_IDLE_DELAY_SECONDS` | `300` | Idle window before a conversation is eligible for extraction. |
| `ARCHESTRA_MEMORY_EXTRACTOR_MAX_TOKENS` | `800` | Upper bound on extractor model output. |
| `ARCHESTRA_MEMORY_EXTRACTOR_MODEL_OVERRIDE` | — | Optional explicit model id for extraction. |
| `ARCHESTRA_MEMORY_EXTRACTOR_API_KEY_ID_OVERRIDE` | — | Optional explicit API key id for extraction. |
| `ARCHESTRA_MEMORY_EXTRACTOR_FALLBACK_MODEL` | — | Secondary model if the primary is unavailable. |
| `ARCHESTRA_MEMORY_EXTRACTOR_FALLBACK_API_KEY_ID` | — | Secondary API key for the fallback model. |
| `ARCHESTRA_MEMORY_INJECTION_TOKEN_BUDGET` | `600` | Per-request token budget for injected memory. |
| `ARCHESTRA_MEMORY_INJECTION_TOP_K` | `10` | Maximum number of memory items per injection. |
| `ARCHESTRA_MEMORY_CANDIDATE_TTL_DAYS` | `30` | Age at which stale candidates are cleaned up. |
| `ARCHESTRA_MEMORY_TOMBSTONE_TTL_DAYS` | `90` | Tombstone retention window. |
| `ARCHESTRA_MEMORY_MAX_CONTENT_LENGTH` | `500` | Maximum characters per memory item. |
| `ARCHESTRA_MEMORY_MAX_CANDIDATES_PER_EXTRACTION` | `5` | Upper bound on candidates per extraction run. |

Security-policy internals and rollback procedures are documented in the backend memory security runbook for operators.
