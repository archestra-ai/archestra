# Durable Memory (Rollout 1)

## Purpose
Durable Memory is a governed subsystem for storing approved, long-lived context as atomic records. It is separate from chat history and the knowledge base.

## Rollout 1 Supported Scope
- Data model, API contracts, ACL, and review workflow support `user`, `team`, and `organization` scopes.
- Automatic extraction and prompt injection are enabled only for `user` scope in rollout 1.
- Team and organization memories are reviewable and manually manageable, but not auto-extracted or injected.

## State Model
Memory items follow a review-first lifecycle:
- `candidate`
- `approved`
- `rejected`
- `archived`

Key transitions:
- `candidate -> approved`
- `candidate -> rejected` (requires rejection reason)
- `approved -> archived`
- `archived -> approved`
- `approved -> candidate` via append-only supersede (`supersedes_memory_id`), not in-place edit
- Any status can be hard-deleted; delete/reject can create tombstones to prevent immediate recreation

## Human Review Invariant
No extractor output becomes active memory without human approval. Agents/tools can propose candidates but cannot write directly into approved durable memory.

## Security Layers
- Candidate-only write boundary:
  - Automated paths (extractor and MCP propose) can only create `candidate` records.
- Sensitive screening:
  - Secrets and high-risk PII are blocked before persistence.
  - Instruction-like content is policy-scored and can be hard-blocked for high-confidence patterns.
- External context isolation:
  - Memory propose/injection paths enforce untrusted/external-context guards.
- Tombstone protection:
  - Deleted/rejected high-risk content is tracked with deterministic content hashing to prevent immediate recreation.
- Runtime observability:
  - Security decisions and blocks emit explicit memory security metrics.

## Extraction and Injection Boundaries
- Extraction:
  - Asynchronous post-conversation task, gated by `ARCHESTRA_MEMORY_EXTRACTION_ENABLED`.
  - Rollout 1 proposes only `user`-scope candidates.
  - Uses extractor prompt version `v1.0.0`.
  - Applies sensitive-data screening before persistence.
- Injection:
  - Controlled by `ARCHESTRA_MEMORY_INJECTION_ENABLED` (default off).
  - Returns `null` immediately when disabled (zero hot-path cost).
  - Rollout 1 injects only approved `user`-scope records with token budget and top-K limits.

## Fixed Rejection Taxonomy
- `inaccurate`
- `sensitive`
- `manipulative`
- `wrong_scope`
- `temporary`
- `duplicate`
- `vague`
- `not_useful`
- `conflicts_with_existing`
- `policy_violation`

## HTTP Client Integration Notes

Endpoints with no request body (`POST /api/memory/:id/approve`, `POST /api/memory/:id/archive`, `POST /api/memory/:id/unarchive`) must NOT include a `Content-Type: application/json` header. Fastify rejects any request that carries `Content-Type: application/json` but has an absent or empty body with a `500` parse error. The generated SDK (via `pnpm codegen:api-client`) handles this correctly because the OpenAPI spec declares no body for those operations; custom HTTP clients must follow the same rule.

## Out of Scope (Rollout 1)
- Semantic/vector retrieval for memory
- Autonomous self-editing of approved memory
- Team/org automatic extraction and prompt injection
- Memory import/export
- Project/workspace/agent scopes
- Auto-consolidation UI
- Scheduled expiry workflows for approved memory (beyond candidate TTL cleanup)

## Planned Security Improvements
Deferred items are tracked in:

- `C:\Users\vgarv\OneDrive\Desktop\Code\contribution\Archestra\.workspace\003-implementation\reports\stage-15-security-followups.md`

Use stable inline TODO references:

- `TODO(SEC-FU-XX): <action>`
