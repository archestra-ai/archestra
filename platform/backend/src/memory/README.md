# Durable Memory (Backend)

Governed subsystem for storing approved, long-lived context as atomic records. Separate from chat history and the knowledge base. Review-first: every automated pathway creates only `candidate` records, and nothing becomes active memory without an explicit human approve action.

Public-facing documentation: [`docs/pages/platform-memory.md`](../../../../docs/pages/platform-memory.md).
Security runbook (canonical): [`docs/security.md`](./docs/security.md).
Source contract (canonical): [`docs/source-contract.md`](./docs/source-contract.md).

## Directory map

```
memory/
├── extractor/           # Async post-conversation candidate extraction
│   ├── extractor.ts
│   ├── extractor-task-handler.ts
│   └── *.test.ts
├── injection/           # Prompt-time retrieval + budget enforcement
│   ├── injection-builder.ts
│   ├── injection-budget.ts
│   └── *.test.ts
├── policy/              # Deterministic pre-write and review-path policy
│   ├── screen-candidate-before-persist.ts   # Shared pre-write screen
│   ├── sensitive-data-screen.ts             # Secrets, high-risk PII
│   ├── instruction-classifier.ts            # Instruction-like detection
│   ├── external-tools-capability.ts         # Capability-first tool gating
│   ├── normalize-content.ts                 # Tombstone matching normalization
│   ├── can-read.ts / can-approve.ts / can-delete.ts
│   └── requester-role.ts                    # Role resolution for policy checks
├── retrieval/           # ACL-filtered retrieval for injection
│   └── retrieval-service.ts
├── review/              # Candidate lifecycle transitions
│   └── review-service.ts
├── scoring/             # Deterministic governance scoring
│   └── scorer.ts        # scoreMemoryCandidate(), determinePolicyDecision()
├── telemetry/           # Memory-specific metrics and spans
│   ├── metrics.ts
│   └── spans.ts
└── docs/security.md     # Canonical security runbook
```

Database schemas live in [`database/schemas/memory-item.ts`](../database/schemas/memory-item.ts) and [`database/schemas/memory-tombstone.ts`](../database/schemas/memory-tombstone.ts). Drizzle-generated models are in [`models/memory-item.ts`](../models/memory-item.ts) and [`models/memory-tombstone.ts`](../models/memory-tombstone.ts).

## Data flow

```
Chat completion ─▶ task-queue ─▶ extractor-task-handler ─▶ extractor (LLM)
                                                             │
                                                             ▼
                                              screen-candidate-before-persist
                                              (secrets, PII, instruction-like,
                                               tombstone, external-context)
                                              + scorer (safetyScore, injectionRisk,
                                                        salienceScore, ...)
                                                             │
                                         ┌───────────────────┼────────────────┐
                                         ▼                   ▼                ▼
                                       block            quarantine           allow
                                                             │                │
                                                             ▼                ▼
                                                   memory-item (quarantined / candidate)
                                                             │
                                       Settings → Memory (review-service)
                                                             │
                          ┌──────────────────────────────────┼──────────────────────┐
                          ▼                                  ▼                      ▼
                       approved                           rejected              archived
                          │
               chat request ─▶ retrieval-service
                                (eligibility: status=approved, kind≠instruction,
                                 safetyScore≥40, injectionRisk≤50)
                                         ▼
                                rank-weighted sort
                                (0.35×salience + 0.30×confidence
                                 + 0.20×provenance + 0.15×safety)
                                         ▼
                               injection-builder
                             (budget, untrusted-context,
                              external-tools guard)
                                         ▼
                           <approved_user_memory> XML block (or null)
```

Entry points:

- **Chat route** ([`routes/chat/routes.ts`](../routes/chat/routes.ts)) calls injection before completion and enqueues extraction on idle.
- **Memory route** ([`routes/memory/routes.memory.ts`](../routes/memory/routes.memory.ts)) is the HTTP surface for CRUD, approve, reject, archive, restore, delete, and list.
- **Archestra MCP tools** ([`archestra-mcp-server/memory.ts`](../archestra-mcp-server/memory.ts)) expose `memory_propose` and related agent-facing tools. Propose writes candidates only.

## Configuration surface

Memory settings are stored per organization in `organizations` and updated through `PATCH /api/organization/memory-settings`.

`config.memory.defaults` in [`config.ts`](../config.ts) now contains bootstrap defaults only. Runtime behavior reads organization columns:

| Organization column (camelCase) | Default | Effect |
|---|---|---|
| `memoryExtractionEnabled` | `false` | Gates async extractor execution. |
| `memoryInjectionEnabled` | `false` | Gates prompt-time injection. Returns `null` fast when off. |
| `memoryIdleDelaySeconds` | `300` | Conversation-idle window before extraction is eligible. |
| `memoryExtractorMaxTokens` | `800` | LLM output cap. |
| `memoryExtractorModel` / `memoryExtractorChatApiKeyId` | `null` | Explicit extractor routing. |
| `memoryInjectionTokenBudget` | `600` | Per-request budget. |
| `memoryInjectionTopK` | `10` | Max items per injection. |
| `memoryCandidateTtlDays` | `30` | Candidate cleanup age. |
| `memoryTombstoneTtlDays` | `90` | Tombstone retention. |
| `memoryMaxContentLength` | `500` | Hard ceiling per item. |
| `memoryMaxCandidatesPerExtraction` | `5` | Upper bound per run. |

Fallback extractor model resolution was removed. Extraction now resolves model config from:
1. Organization override (`memoryExtractorModel`, `memoryExtractorChatApiKeyId`).
2. Organization default LLM model/provider key.
3. `null` (skip extraction with telemetry), if neither resolves.

## Extraction tracking and maintenance

Conversation-level extraction lifecycle is tracked in `conversations`:

- `memoryExtractionStatus`: `pending | completed | failed | skipped`
- `memoryExtractionAttemptedAt`
- `memoryExtractedAt`

`GET /api/organization/memory-extraction-stats` exposes aggregate counts by status, including `null` (not yet processed).

Periodic task `memory_maintenance` (hourly) now owns:

- per-org candidate cleanup (`memoryCandidateTtlDays`)
- per-org tombstone cleanup (`memoryTombstoneTtlDays`)
- retry queueing for failed extractions in orgs with extraction enabled

## Security posture

Canonical document: [`docs/security.md`](./docs/security.md).

Summary of enforced controls (read the runbook for reasons, metrics, and rollback):

- **Candidate-only write boundary.** Automated paths never write approved memory.
- **Pre-write screen** (`screen-candidate-before-persist`) runs for extractor, MCP propose, manual create, and supersede. Decisions: `allow`, `quarantine`, `block`. Quarantined items are persisted with status `quarantined` and require security review before they can be approved; they are never injected.
- **Scoring.** Every non-hard-blocked candidate is scored by `scoring/scorer.ts` (`SCORER_VERSION = "1.0.0"`). Scores include `salienceScore`, `confidenceScore`, `injectionRisk`, `sensitivityRisk`, `provenanceTrustScore`, and `safetyScore` (`= 100 − max(all risks)`). The scorer drives both the quarantine decision and retrieval ranking.
- **Approve-path guard.** Candidates with status `quarantined` or carrying `instruction_like`, `instruction_like_high`, `instruction_like_medium`, or `external_context` cannot be approved through the normal endpoint.
- **Retrieval eligibility.** Items are excluded from injection if `kind === "instruction"`, expired, `safetyScore < 40`, or `injectionRisk > 50`.
- **Prompt-time injection guard.** Injection is active only when the flag is on, the posture is trusted, and active tools do not expose external communication capability.
- **Tombstones.** Deletions and rejections of high-risk content emit deterministic tombstones with normalized fallback matching.

## Telemetry

Metrics live in [`telemetry/metrics.ts`](./telemetry/metrics.ts); spans in [`telemetry/spans.ts`](./telemetry/spans.ts). Public PromQL catalog is in the platform observability documentation. Primary memory counters:

- `archestra_memory_policy_blocked_total{reason}`
- `archestra_memory_screen_decision_total{decision,reason}`
- `archestra_memory_injection_block_total{reason}`
- `archestra_memory_review_policy_block_total{reason}`
- `archestra_memory_tombstone_hit_total{reason,match_type}`
- `archestra_memory_mcp_propose_block_total{reason}`
- `archestra_memory_candidates_created_total{source_type}`
- `archestra_memory_review_outcome_total{source_type,outcome}`
- `archestra_memory_safety_block_total{source_type,reason}`
- `archestra_memory_dedup_drop_total{source_type,reason}`
- `archestra_memory_candidate_scored_total{memory_type,scope_type,source_type,safety_score_bucket}`
- `archestra_memory_quarantined_total{reason,scope_type}`
- `archestra_memory_retrieved_total{memory_type,scope_type,safety_score_bucket}`
- `archestra_memory_extractor_no_model_total{organization_id}`
- `archestra_memory_extraction_status_total{status,organization_id}`
- `archestra_memory_maintenance_duration_seconds`
- `archestra_memory_maintenance_retried_total{organization_id}`

## Frontend surface

The `/settings/memory` UI is implemented in [`frontend/src/app/settings/memory`](../../../../frontend/src/app/settings/memory) and calls the routes described above through generated SDK clients.

## HTTP Client Integration Notes

Endpoints with no request body (`POST /api/memory/:id/approve`, `POST /api/memory/:id/archive`, `POST /api/memory/:id/unarchive`) must NOT include a `Content-Type: application/json` header. Fastify rejects any request that carries `Content-Type: application/json` but has an absent or empty body with a `500` parse error. The generated SDK (via `pnpm codegen:api-client`) handles this correctly because the OpenAPI spec declares no body for those operations; custom HTTP clients must follow the same rule.

## Out of scope (rollout 1)

- Semantic / vector retrieval.
- Autonomous self-editing of approved memory.
- Team / organization automatic extraction and injection.
- Memory import/export.
- Project / workspace / agent scopes.
- Auto-consolidation UI.
- Scheduled expiry workflows beyond candidate TTL cleanup.

## Planned security improvements

Deferred items are tracked in [`.workspace/003-implementation/reports/stage-15/artifacts/stage-15-security-followups.md`](../../../../../.workspace/003-implementation/reports/stage-15/artifacts/stage-15-security-followups.md). Inline references use `TODO(SEC-FU-XX): <action>`.
