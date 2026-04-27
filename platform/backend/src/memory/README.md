# Durable Memory (Backend)

Governed subsystem for storing approved, long-lived context as atomic records. Separate from chat history and the knowledge base. Review-first: every automated pathway creates only `candidate` records, and nothing becomes active memory without an explicit human approve action.

Public-facing documentation: [`docs/pages/platform-memory.md`](../../../../docs/pages/platform-memory.md).
Security runbook (canonical): [`docs/security.md`](./docs/security.md).

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
                                                             │
                                            ┌────────────────┼────────────────┐
                                            ▼                ▼                ▼
                                          block            flag             allow
                                                             │
                                                             ▼
                                                   memory-item (candidate)
                                                             │
                                       Settings → Memory (review-service)
                                                             │
                                 ┌───────────────────────────┼───────────────────────┐
                                 ▼                           ▼                       ▼
                            approved                      rejected               archived
                                 │
                      chat request ─▶ retrieval-service (ACL, scope, top-K)
                                                ▼
                                      injection-builder
                                    (budget, untrusted-context,
                                     external-tools guard)
                                                ▼
                                  prompt-time memory block (or null)
```

Entry points:

- **Chat route** ([`routes/chat/routes.ts`](../routes/chat/routes.ts)) calls injection before completion and enqueues extraction on idle.
- **Memory route** ([`routes/memory/routes.memory.ts`](../routes/memory/routes.memory.ts)) is the HTTP surface for CRUD, approve, reject, archive, restore, delete, and list.
- **Archestra MCP tools** ([`archestra-mcp-server/memory.ts`](../archestra-mcp-server/memory.ts)) expose `memory_propose` and related agent-facing tools. Propose writes candidates only.

## Configuration surface

All memory config is parsed in [`config.ts`](../config.ts) under `config.memory`. Runtime flags:

| Key | Env var | Default | Effect |
|---|---|---|---|
| `extractionEnabled` | `ARCHESTRA_MEMORY_EXTRACTION_ENABLED` | `false` | Gates async extractor execution. |
| `injectionEnabled` | `ARCHESTRA_MEMORY_INJECTION_ENABLED` | `false` | Gates prompt-time injection. Returns `null` fast when off. |
| `idleDelaySeconds` | `ARCHESTRA_MEMORY_IDLE_DELAY_SECONDS` | `300` | Conversation-idle window before extraction is eligible. |
| `extractorMaxTokens` | `ARCHESTRA_MEMORY_EXTRACTOR_MAX_TOKENS` | `800` | LLM output cap. |
| `extractorModelOverride` / `extractorApiKeyIdOverride` | — | — | Explicit routing for extraction. |
| `extractorFallbackModel` / `extractorFallbackApiKeyId` | — | — | Secondary model if the primary is unavailable. |
| `injectionTokenBudget` | `ARCHESTRA_MEMORY_INJECTION_TOKEN_BUDGET` | `600` | Per-request budget. |
| `injectionTopK` | `ARCHESTRA_MEMORY_INJECTION_TOP_K` | `10` | Max items per injection. |
| `candidateTtlDays` | `ARCHESTRA_MEMORY_CANDIDATE_TTL_DAYS` | `30` | Candidate cleanup age. |
| `tombstoneTtlDays` | `ARCHESTRA_MEMORY_TOMBSTONE_TTL_DAYS` | `90` | Tombstone retention. |
| `maxContentLength` | `ARCHESTRA_MEMORY_MAX_CONTENT_LENGTH` | `500` | Hard ceiling per item. |
| `maxCandidatesPerExtraction` | `ARCHESTRA_MEMORY_MAX_CANDIDATES_PER_EXTRACTION` | `5` | Upper bound per run. |

## Security posture

Canonical document: [`docs/security.md`](./docs/security.md).

Summary of enforced controls (read the runbook for reasons, metrics, and rollback):

- **Candidate-only write boundary.** Automated paths never write approved memory.
- **Pre-write screen** (`screen-candidate-before-persist`) runs for extractor, MCP propose, manual create, and supersede. Decisions: `allow`, `flag`, `block`.
- **Approve-path guard.** Candidates carrying `instruction_like`, `instruction_like_high`, `instruction_like_medium`, or `external_context` cannot be approved through the normal endpoint.
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
